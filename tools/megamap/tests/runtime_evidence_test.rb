require 'minitest/autorun'
require 'tmpdir'
require 'fileutils'
require 'json'
require_relative '../tools/runtime_evidence'

class RuntimeEvidenceTest < Minitest::Test
  def setup
    @root = Dir.mktmpdir('spamton-runtime-evidence-')
    @output = File.join(@root, 'evidence.json')
    @namespace = "EvidenceFixture#{object_id}"
  end

  def teardown
    Object.send(:remove_const, @namespace) if Object.const_defined?(@namespace, false)
    Object.send(:remove_const, :ActiveRecord) if @owned_active_record
    FileUtils.remove_entry(@root)
  end

  def source(path, body)
    absolute = File.join(@root, path)
    FileUtils.mkdir_p(File.dirname(absolute))
    File.write(absolute, "module #{@namespace}\n#{body}\nend\n")
    load absolute
    absolute
  end

  def constant(name)
    Object.const_get(@namespace).const_get(name)
  end

  def methods(document, entry)
    entry.fetch('method_refs').map do |name, singleton, index|
      definition = document.fetch('method_definitions').fetch(index)
      definition_name = definition.fetch('name')
      owner = definition_name.rpartition(/[.#]/).first
      definition.merge('name' => name, 'singleton' => singleton, 'owner' => owner, 'definition_name' => definition_name)
    end
  end

  def with_owner_counts
    original = MegamapEvidence.method(:owner_name)
    owners = Hash.new(0).compare_by_identity
    MegamapEvidence.define_singleton_method(:owner_name) { |owner| owners[owner] += 1; original.call(owner) }
    yield owners
  ensure
    MegamapEvidence.define_singleton_method(:owner_name, original)
  end

  def with_limit(name, value)
    previous = MegamapEvidence.const_get(name)
    MegamapEvidence.send(:remove_const, name)
    MegamapEvidence.const_set(name, value)
    yield
  ensure
    MegamapEvidence.send(:remove_const, name)
    MegamapEvidence.const_set(name, previous)
  end

  def test_inherited_aliases_share_one_definition_without_losing_receiver_bindings
    source('shared.rb', "module Shared\n def run; :ok; end\n alias another run\nend\nclass First\n include Shared\nend\nclass Last\n extend Shared\nend")
    document = MegamapEvidence.snapshot(root: @root)
    assert_equal 2, document.fetch('version')
    definitions = document.fetch('method_definitions')
    target = definitions.index { |definition| definition['name'] == "#{@namespace}::Shared#run" }
    refute_nil target
    assert_equal 1, definitions.count { |definition| definition['name'] == "#{@namespace}::Shared#run" }
    first = document.fetch('classes').find { |entry| entry['name'] == "#{@namespace}::First" }
    last = document.fetch('classes').find { |entry| entry['name'] == "#{@namespace}::Last" }
    assert_includes first.fetch('method_refs'), ['run', false, target]
    assert_includes first.fetch('method_refs'), ['another', false, target]
    assert_includes last.fetch('method_refs'), ['run', true, target]
    assert_includes last.fetch('method_refs'), ['another', true, target]
    refute first.key?('methods')
    assert_equal ['file', 'line', 'name'], definitions.fetch(target).keys.sort
    assert_equal 'shared.rb', definitions.fetch(target).fetch('file')
    assert_equal 3, definitions.fetch(target).fetch('line')
  end

  def test_unique_definition_limit_still_allows_later_classes_to_reference_existing_targets
    source('classes.rb', "class ABase\n def shared; :ok; end\nend\nclass BFirst < ABase\n def extra; :extra; end\nend\nclass ZLast < ABase; end")
    document = with_limit(:MAX_METHODS, 1) { MegamapEvidence.snapshot(root: @root) }
    assert_equal 2, document.fetch('version')
    definitions = document.fetch('method_definitions')
    assert_equal 1, definitions.length
    assert_equal "#{@namespace}::ABase#shared", definitions.first.fetch('name')
    first = document.fetch('classes').find { |entry| entry['name'] == "#{@namespace}::BFirst" }
    last = document.fetch('classes').find { |entry| entry['name'] == "#{@namespace}::ZLast" }
    assert_includes first.fetch('method_refs'), ['shared', false, 0]
    assert_includes last.fetch('method_refs'), ['shared', false, 0]
    refute first.fetch('method_refs').any? { |name, _singleton, _target| name == 'extra' }
    assert document.fetch('warnings').any? { |warning| warning.include?('Method export limit') }
  end

  def test_prepended_and_generated_targets_keep_the_effective_definition_and_side
    source('company.rb', "module Included\n def run; :included; end\nend\nmodule Prepended\n def run; :prepended; end\nend\nclass Company\n include Included\n prepend Prepended\n [:first, :second].each { |name| define_method(name) { :generated } }\n define_singleton_method(:build) { :built }\nend")
    document = MegamapEvidence.snapshot(root: @root)
    company = document.fetch('classes').find { |entry| entry['name'] == "#{@namespace}::Company" }
    loaded = methods(document, company)
    assert_equal "#{@namespace}::Prepended#run", loaded.find { |method| method['name'] == 'run' }.fetch('definition_name')
    first = loaded.find { |method| method['name'] == 'first' }
    second = loaded.find { |method| method['name'] == 'second' }
    assert_equal first.fetch('line'), second.fetch('line')
    assert_equal "#{@namespace}::Company#first", first.fetch('definition_name')
    assert_equal "#{@namespace}::Company#second", second.fetch('definition_name')
    build = loaded.find { |method| method['name'] == 'build' }
    assert_equal true, build.fetch('singleton')
    assert_equal "#{@namespace}::Company.build", build.fetch('definition_name')
  end

  def test_deduplicated_export_still_enforces_the_existing_byte_budget
    source('company.rb', "class Company\n def run; :ok; end\nend")
    error = with_limit(:MAX_JSON_BYTES, 16) do
      assert_raises(ArgumentError) { MegamapEvidence.snapshot(root: @root, output: @output) }
    end
    assert_match(/Evidence exceeds the .* export limit/, error.message)
    refute File.exist?(@output)
  end

  def test_inherited_bindings_validate_shared_source_and_owner_metadata_once_per_export
    path = source('shared.rb', "module Shared\n def run; :ok; end\nend\nclass First\n include Shared\nend\nclass Last\n extend Shared\nend")
    exporter = MegamapEvidence::Exporter.new(@root, 'shared reflection')
    sources = exporter.instance_variable_get(:@sources)
    original_location = sources.method(:location)
    locations = Hash.new(0)
    sources.define_singleton_method(:location) do |file, line|
      locations[[file, line]] += 1
      original_location.call(file, line)
    end
    owners = nil
    document = with_owner_counts { |counts| owners = counts; exporter.export(nil) }
    assert_equal 1, locations[[path, 3]], 'an inherited definition location is validated once, not for each receiving class'
    assert_equal 1, owners[constant('Shared')], 'actual defining module metadata is shared across receiver bindings'
    first = document.fetch('classes').find { |entry| entry['name'] == "#{@namespace}::First" }
    last = document.fetch('classes').find { |entry| entry['name'] == "#{@namespace}::Last" }
    assert_equal "#{@namespace}::Shared#run", methods(document, first).find { |method| method['name'] == 'run' }.fetch('definition_name')
    assert_equal "#{@namespace}::Shared#run", methods(document, last).find { |method| method['name'] == 'run' }.fetch('definition_name')
  end

  def test_rejected_sources_are_cached_and_anonymous_owner_lookups_remain_retryable
    path = source('shared.rb', "class First; end\nclass Last; end")
    foreign_directory = Dir.mktmpdir('spamton-foreign-methods-')
    foreign_path = File.join(foreign_directory, 'foreign.rb')
    File.write(foreign_path, "module #{@namespace}::Foreign\n def foreign; :ok; end\nend\n")
    load foreign_path
    anonymous = Module.new
    anonymous.module_eval('def anonymous; :ok; end', path, 2)
    ['First', 'Last'].each { |name| constant(name).include(constant('Foreign')); constant(name).include(anonymous) }
    exporter = MegamapEvidence::Exporter.new(@root, 'rejected reflection')
    sources = exporter.instance_variable_get(:@sources)
    original_location = sources.method(:location)
    locations = Hash.new(0)
    sources.define_singleton_method(:location) do |file, line|
      locations[[file, line]] += 1
      original_location.call(file, line)
    end
    owners = nil
    document = with_owner_counts { |counts| owners = counts; exporter.export(nil) }
    assert_equal 1, locations[[foreign_path, 2]], 'a rejected external source location is not revalidated per receiver'
    assert_equal 0, owners[constant('Foreign')], 'external method owners need no export metadata'
    assert_equal 2, owners[anonymous], 'an anonymous owner remains retryable if it is named later'
    assert_empty document.fetch('method_definitions')
    assert document.fetch('classes').all? { |entry| entry.fetch('method_refs').empty? }
  ensure
    FileUtils.remove_entry(foreign_directory) if foreign_directory && File.exist?(foreign_directory)
  end

  def test_anonymous_owner_named_during_export_is_available_to_later_receivers
    path = source('classes.rb', "class First; end\nclass Last; end")
    anonymous = Module.new
    anonymous.module_eval('def generated; :ok; end', path, 2)
    ['First', 'Last'].each { |name| constant(name).include(anonymous) }
    original = MegamapEvidence.method(:owner_name)
    seen = 0
    namespace = Object.const_get(@namespace)
    MegamapEvidence.define_singleton_method(:owner_name) do |owner|
      value = original.call(owner)
      if owner.equal?(anonymous)
        seen += 1
        namespace.const_set(:NamedLater, owner) if seen == 1
      end
      value
    end
    document = MegamapEvidence.snapshot(root: @root)
    last = document.fetch('classes').find { |entry| entry['name'] == "#{@namespace}::Last" }
    assert_equal 2, seen
    generated = methods(document, last).find { |method| method['name'] == 'generated' }
    assert_equal "#{@namespace}::NamedLater#generated", generated.fetch('definition_name')
  ensure
    MegamapEvidence.define_singleton_method(:owner_name, original) if original
  end

  def test_observed_calls_keep_definition_and_callsite_locations_and_aggregate_counts
    source('company.rb', "class Company\n def run; :ok; end\nend")
    source('worker.rb', "class Worker\n def perform(target)\n  target.run\n end\nend")
    result = MegamapEvidence.capture(root: @root, output: @output, label: 'request example') do
      2.times { constant('Worker').new.perform(constant('Company').new) }
      :original_result
    end
    assert_equal :original_result, result
    document = JSON.parse(File.read(@output))
    call = document.fetch('calls').find { |entry| entry.dig('callee', 'name') == "#{@namespace}::Company#run" }
    refute_nil call
    assert_equal "#{@namespace}::Worker#perform", call.dig('caller', 'name')
    assert_equal 'worker.rb', call.dig('caller', 'file')
    assert_equal 3, call.dig('caller', 'line')
    assert_equal 4, call.fetch('line')
    assert_equal 'company.rb', call.dig('callee', 'file')
    assert_equal 3, call.dig('callee', 'line')
    assert_equal 'run', call.fetch('method')
    assert_equal 2, call.fetch('count')
    assert_match(/\A[0-9a-f]{16}\z/, document.fetch('files').fetch('company.rb'))
  end

  def test_loaded_metadata_records_the_real_owner_and_prefers_the_inheritance_declaration
    source('namespace.rb', 'class Record; end; class Company; end')
    Object.const_get(@namespace).send(:remove_const, :Company)
    source('company.rb', "module Work\n def run; end\nend\nclass Company < Record\n include Work\n def self.build; end\nend")
    source('reopen.rb', 'class Company; end')
    document = MegamapEvidence.snapshot(root: @root, output: @output)
    company = document.fetch('classes').find { |entry| entry['name'] == "#{@namespace}::Company" }
    refute_nil company
    assert_equal 'company.rb', company.fetch('file')
    assert_equal 5, company.fetch('line')
    run = methods(document, company).find { |entry| entry['name'] == 'run' && !entry['singleton'] }
    assert_equal "#{@namespace}::Work", run.fetch('owner')
    assert_equal "#{@namespace}::Work#run", run.fetch('definition_name')
    assert_equal 'company.rb', run.fetch('file')
    assert_includes company.fetch('ancestors'), "#{@namespace}::Record"
  end

  def test_extended_module_methods_keep_their_definition_side_and_alias_names
    source('company.rb', "module Work\n def run; :ok; end\n alias another run\nend\nclass Company\n extend Work\nend")
    document = MegamapEvidence.snapshot(root: @root)
    company = document.fetch('classes').find { |entry| entry['name'] == "#{@namespace}::Company" }
    run = methods(document, company).find { |entry| entry['name'] == 'run' && entry['singleton'] }
    another = methods(document, company).find { |entry| entry['name'] == 'another' && entry['singleton'] }
    assert_equal "#{@namespace}::Work#run", run.fetch('definition_name')
    assert_equal "#{@namespace}::Work#run", another.fetch('definition_name')
    assert_equal "#{@namespace}::Work", another.fetch('owner')
  end

  def test_generated_methods_and_observed_aliases_use_the_actual_definition
    source('company.rb', "class Company\n define_method(:run) { :ok }\n alias another run\nend")
    source('worker.rb', "class Worker\n def perform(target)\n target.another\n end\nend")
    MegamapEvidence.capture(root: @root, output: @output) { constant('Worker').new.perform(constant('Company').new) }
    document = JSON.parse(File.read(@output))
    call = document.fetch('calls').find { |entry| entry['method'] == 'another' }
    refute_nil call
    assert_equal "#{@namespace}::Company#run", call.dig('callee', 'name')
    assert_equal 3, call.dig('callee', 'line')
    company = document.fetch('classes').find { |entry| entry['name'] == "#{@namespace}::Company" }
    assert_equal 3, methods(document, company).find { |entry| entry['name'] == 'run' }.fetch('line')
  end

  def test_threads_and_suspended_fibers_do_not_share_caller_frames
    source('company.rb', "class Company\n def run; end\n def other; end\nend")
    source('worker.rb', "class Worker\n def paused(target)\n Fiber.yield\n target.run\n end\n def another(target)\n target.other\n end\n def threaded(target)\n target.run\n end\nend")
    worker = constant('Worker').new
    company = constant('Company').new
    MegamapEvidence.capture(root: @root, output: @output) do
      first = Fiber.new { worker.paused(company) }
      second = Fiber.new { worker.another(company) }
      first.resume
      second.resume
      Thread.new { worker.threaded(company) }.join
      first.resume
    end
    calls = JSON.parse(File.read(@output)).fetch('calls')
    pairs = calls.map { |entry| [entry.dig('caller', 'name'), entry.dig('callee', 'name')] }
    assert_equal [["#{@namespace}::Worker#another", "#{@namespace}::Company#other"], ["#{@namespace}::Worker#paused", "#{@namespace}::Company#run"], ["#{@namespace}::Worker#threaded", "#{@namespace}::Company#run"]].sort, pairs.sort
  end

  def test_external_and_c_block_frames_do_not_become_direct_application_calls
    source('company.rb', "class Company\n def run; end\nend")
    source('worker.rb', "class Worker\n def through_block(target)\n [target].each(&:run)\n end\n def through_external(target)\n EvidenceExternalBridge.call(target)\n end\nend")
    external = Dir.mktmpdir('spamton-external-evidence-')
    begin
      path = File.join(external, 'bridge.rb')
      File.write(path, "module EvidenceExternalBridge\n def self.call(target); target.run; end\nend")
      load path
      MegamapEvidence.capture(root: @root, output: @output) do
        worker = constant('Worker').new
        target = constant('Company').new
        worker.through_block(target)
        worker.through_external(target)
      end
      assert_empty JSON.parse(File.read(@output)).fetch('calls')
    ensure
      Object.send(:remove_const, :EvidenceExternalBridge) if Object.const_defined?(:EvidenceExternalBridge, false)
      FileUtils.remove_entry(external)
    end
  end

  def test_concurrent_application_calls_are_aggregated_without_cross_thread_edges
    source('company.rb', "class Company\n def run; end\nend")
    source('worker.rb', "class Worker\n def perform(target)\n target.run\n end\nend")
    worker = constant('Worker').new
    company = constant('Company').new
    MegamapEvidence.capture(root: @root, output: @output) do
      Array.new(16) { Thread.new { 20.times { worker.perform(company) } } }.each(&:join)
    end
    document = JSON.parse(File.read(@output))
    assert_empty document.fetch('warnings')
    assert_equal 1, document.fetch('calls').length
    assert_equal 320, document.fetch('calls').first.fetch('count')
  end

  def test_exceptions_preserve_application_behavior_and_do_not_leave_stale_frames
    source('company.rb', "class Company\n def fail_now; raise 'application sentinel'; end\n def run; end\nend")
    source('worker.rb', "class Worker\n def perform(target)\n target.fail_now\n rescue RuntimeError\n target.run\n end\nend")
    MegamapEvidence.capture(root: @root, output: @output) { constant('Worker').new.perform(constant('Company').new) }
    calls = JSON.parse(File.read(@output)).fetch('calls')
    assert_equal ['fail_now', 'run'], calls.map { |entry| entry['method'] }.sort
    assert calls.all? { |entry| entry.dig('caller', 'name') == "#{@namespace}::Worker#perform" }
    error = assert_raises(RuntimeError) do
      MegamapEvidence.capture(root: @root, output: @output) { raise 'original application exception' }
    end
    assert_equal 'original application exception', error.message
    refute JSON.parse(File.read(@output)).key?('exception')
  end

  def test_capture_limits_report_incompleteness_and_leave_the_application_running
    source('company.rb', "class Company\n def one; end\n def two; end\nend")
    source('worker.rb', "class Worker\n def perform(target)\n target.one\n target.two\n end\nend")
    result = MegamapEvidence.capture(root: @root, output: @output, max_calls: 1) do
      constant('Worker').new.perform(constant('Company').new)
      :finished
    end
    document = JSON.parse(File.read(@output))
    assert_equal :finished, result
    assert_equal 1, document.fetch('calls').length
    assert document.fetch('warnings').any? { |warning| warning.include?('call limit') }
    result = MegamapEvidence.capture(root: @root, output: @output, max_events: 1) { :still_finished }
    assert_equal :still_finished, result
    assert JSON.parse(File.read(@output)).fetch('warnings').any? { |warning| warning.include?('event limit') }
  end

  def test_modified_sources_do_not_keep_observations_from_the_old_contents
    company_file = source('company.rb', "class Company\n def run; end\nend")
    source('worker.rb', "class Worker\n def perform(target)\n target.run\n end\nend")
    MegamapEvidence.capture(root: @root, output: @output) do
      constant('Worker').new.perform(constant('Company').new)
      File.open(company_file, 'a') { |file| file.write("\n") }
    end
    document = JSON.parse(File.read(@output))
    assert_empty document.fetch('calls')
    assert document.fetch('warnings').any? { |warning| warning.include?('Source changed') }
  end

  def test_metadata_exports_rails_association_contracts_without_exporting_values_or_errors
    active_record = File.join(@root, 'active_record.rb')
    File.write(active_record, "module ActiveRecord\n class Base\n def self.attribute_names; raise 'credential sentinel'; end\n end\nend\n")
    load active_record
    @owned_active_record = true
    source('company.rb', "class Person < ActiveRecord::Base; end\nclass Company < ActiveRecord::Base\n def self.reflect_on_all_associations\n  [Struct.new(:name, :klass) { def polymorphic?; false; end; def collection?; false; end }.new(:person, Person)]\n end\n def run(secret); secret; end\nend")
    source('worker.rb', "class Worker\n def perform(target, value)\n target.run(value)\n end\nend")
    MegamapEvidence.capture(root: @root, output: @output) { constant('Worker').new.perform(constant('Company').new, 'private argument sentinel') }
    encoded = File.read(@output)
    refute_includes encoded, 'private argument sentinel'
    refute_includes encoded, 'credential sentinel'
    company = JSON.parse(encoded).fetch('classes').find { |entry| entry['name'] == "#{@namespace}::Company" }
    assert_equal true, company.fetch('active_record')
    assert_includes company.fetch('ancestors'), 'ActiveRecord::Base'
    assert_equal [{ 'name' => 'person', 'target' => "#{@namespace}::Person", 'collection' => false }], company.fetch('associations')
  end

  def test_writing_evidence_preserves_unrelated_temporary_files_and_uses_private_permissions
    collision = "#{@output}.#{Process.pid}.tmp"
    File.write(collision, 'untouched sentinel')
    assert_raises(Errno::EEXIST) { MegamapEvidence.snapshot(root: @root, output: @output) }
    assert_equal 'untouched sentinel', File.read(collision)
    File.unlink(collision)
    MegamapEvidence.snapshot(root: @root, output: @output)
    assert_equal 0o600, File.stat(@output).mode & 0o777
  end

  def test_fingerprints_are_protocol_compatible_and_labels_are_bounded
    assert_equal 'cbf29ce484222325', MegamapEvidence.fingerprint('')
    assert_equal 'a430d84680aabd0b', MegamapEvidence.fingerprint('hello')
    assert_equal 180, MegamapEvidence.snapshot(root: @root, label: "a\n" * 100).fetch('label').length
    refute_includes MegamapEvidence.snapshot(root: @root, label: "a\nb").fetch('label'), "\n"
  end

  def test_requiring_the_collector_is_inert_until_explicitly_requested
    script = File.expand_path('../tools/runtime_evidence.rb', __dir__)
    output, error, status = Open3.capture3({ 'MEGAMAP_EVIDENCE_MODE' => nil, 'MEGAMAP_EVIDENCE_OUT' => @output }, RbConfig.ruby, '-r', script, '-e', 'puts "loaded only"')
    assert status.success?, error
    assert_equal "loaded only\n", output
    refute File.exist?(@output)
    refute_includes error, 'evidence'
  end

  def test_export_failure_preserves_the_successful_application_result
    result = nil
    _stdout, stderr = capture_io do
      result = MegamapEvidence.capture(root: @root, output: File.join(@root, 'missing', 'evidence.json')) { :original_result }
    end
    assert_equal :original_result, result
    assert_includes stderr, 'megamap:'
    refute_includes stderr, @root
  end

  def test_unavailable_collection_preserves_the_application_result_and_exception
    _stdout, stderr = capture_io do
      assert_equal :original_result, MegamapEvidence.capture(root: File.join(@root, 'missing'), output: @output) { :original_result }
      error = assert_raises(RuntimeError) do
        MegamapEvidence.capture(root: @root, output: File.join(@root, 'missing', 'out.json')) { raise 'application sentinel' }
      end
      assert_equal 'application sentinel', error.message
    end
    assert_includes stderr, 'megamap:'
    refute_includes stderr, 'application sentinel'
    refute_includes stderr, @root
  end

  def test_context_fingerprints_include_class_reopenings_that_change_method_lookup
    source('a_worker.rb', 'class Worker; end')
    source('extra.rb', "module Extra\n def run; end\nend")
    source('z_configure.rb', "class Worker\n include Extra\nend")
    document = MegamapEvidence.snapshot(root: @root)
    assert_equal ['a_worker.rb', 'extra.rb', 'z_configure.rb'], document.fetch('context_files')
    assert_equal MegamapEvidence.fingerprint(File.binread(File.join(@root, 'z_configure.rb'))), document.fetch('files').fetch('z_configure.rb')
    worker = document.fetch('classes').find { |entry| entry['name'] == "#{@namespace}::Worker" }
    assert methods(document, worker).any? { |method| method['owner'] == "#{@namespace}::Extra" }
  end

  def test_context_uses_the_viewer_source_file_boundary_and_git_ignore_rules
    source('included.rb', 'class Included; end')
    File.write(File.join(@root, 'empty.rb'), '')
    File.write(File.join(@root, '.gitignore'), "ignored/\n*.skip.rb\n")
    FileUtils.mkdir_p(File.join(@root, 'ignored'))
    File.write(File.join(@root, 'ignored', 'hidden.rb'), 'class Hidden; end')
    File.write(File.join(@root, 'hidden.skip.rb'), 'class Hidden; end')
    File.write(File.join(@root, 'binary.rb'), "x\0y")
    File.binwrite(File.join(@root, 'invalid.rb'), "\xff\xff".b)
    File.open(File.join(@root, 'large.rb'), 'wb') { |file| file.truncate(8 * 1024 * 1024 + 1) }
    File.symlink(File.join(@root, 'included.rb'), File.join(@root, 'link.rb'))
    [false, true].each do |git|
      if git
        _out, error, status = Open3.capture3('git', '-C', @root, 'init', '-q')
        assert status.success?, error
      end
      document = MegamapEvidence.snapshot(root: @root)
      assert_equal ['empty.rb', 'included.rb'], document.fetch('context_files'), "git=#{git}"
      assert_equal document.fetch('context_files'), document.fetch('files').keys.sort
    end
  end

  def test_capture_retains_the_initial_context_when_configuration_changes_during_execution
    source('company.rb', "class Company\n def run; end\nend")
    source('worker.rb', "class Worker\n def perform(target)\n target.run\n end\nend")
    configuration = source('z_configure.rb', 'class Worker; end')
    before = MegamapEvidence.fingerprint(File.binread(configuration))
    MegamapEvidence.capture(root: @root, output: @output) do
      constant('Worker').new.perform(constant('Company').new)
      File.write(configuration, "module #{@namespace}; class Worker; end; end\n# changed configuration\n")
    end
    document = JSON.parse(File.read(@output))
    assert_equal before, document.fetch('files').fetch('z_configure.rb')
    refute_equal MegamapEvidence.fingerprint(File.binread(configuration)), document.fetch('files').fetch('z_configure.rb')
  end
end
