require 'json'
require 'ripper'
require 'time'
require 'open3'
require 'fiber'

module MegamapEvidence
  MAX_FILES = 30_000
  MAX_SOURCE_BYTES = 8 * 1024 * 1024
  MAX_TOTAL_SOURCE_BYTES = 128 * 1024 * 1024
  MAX_CLASSES = 5_000
  MAX_METHODS = 50_000
  MAX_CALLS = 10_000
  MAX_EVENTS = 1_000_000
  MAX_STACKS = 1_024
  MAX_JSON_BYTES = 32 * 1024 * 1024
  CONSTANT_NAME = /\A[A-Z]\w*(?:::[A-Z]\w*)*\z/

  def self.fingerprint(bytes)
    hash = 14_695_981_039_346_656_037
    bytes.each_byte { |byte| hash = ((hash ^ byte) * 1_099_511_628_211) & 0xffffffffffffffff }
    format('%016x', hash)
  end

  def self.clean_label(label)
    label.to_s.encode('UTF-8', invalid: :replace, undef: :replace).gsub(/[[:cntrl:]]/, ' ')[0, 180]
  end

  def self.module_name(mod)
    Module.instance_method(:name).bind(mod).call
  rescue TypeError
    nil
  end

  def self.loaded_constant(name)
    return nil unless CONSTANT_NAME.match?(name)
    name.split('::').inject(Object) do |owner, part|
      return nil unless owner.is_a?(Module) && owner.const_defined?(part, false) && !owner.autoload?(part)
      owner.const_get(part, false)
    end
  rescue NameError
    nil
  end

  def self.owner_name(owner)
    if owner.singleton_class?
      text = Module.instance_method(:to_s).bind(owner).call
      match = /\A#<Class:([A-Z]\w*(?:::[A-Z]\w*)*)>\z/.match(text)
      match && [match[1], '.']
    else
      name = module_name(owner)
      [name, '#'] if name && CONSTANT_NAME.match?(name)
    end
  end

  def self.default_root
    defined?(Rails) && Rails.respond_to?(:root) && Rails.root ? Rails.root.to_s : Dir.pwd
  end

  def self.snapshot(root: default_root, output: nil, label: 'Loaded app')
    warnings = []
    if defined?(Rails) && Rails.respond_to?(:application) && Rails.application
      begin
        Rails.application.eager_load!
      rescue StandardError, LoadError
        warnings << 'Rails eager loading was incomplete; only available definitions were exported'
      end
    end
    Exporter.new(root, label, warnings).export(output)
  end

  def self.capture(root: default_root, output:, label: 'Observed execution', max_events: MAX_EVENTS, max_calls: MAX_CALLS)
    raise ArgumentError, 'capture requires a block' unless block_given?
    collector = nil
    begin
      collector = Collector.new(root, max_events, max_calls)
      collector.enable
    rescue StandardError, LoadError
      begin
        collector.disable if collector
      rescue StandardError
        nil
      end
      collector = nil
      report_failure
    end
    begin
      yield
    ensure
      if collector
        begin
          collector.disable
          Exporter.new(root, label, collector.warnings, collector.calls, collector.files).export(output)
        rescue StandardError, LoadError
          report_failure
        end
      end
    end
  end

  def self.report_failure
    $stderr.write("megamap: optional evidence collection or export failed; application behavior is unchanged\n")
  rescue StandardError
    nil
  end

  class Sources
    attr_reader :declarations, :warnings

    def initialize(root)
      @root = File.realpath(root)
      raise ArgumentError, 'evidence root must be a directory' unless File.directory?(@root)
      @texts = {}
      @paths = {}
      @fingerprints = {}
      @line_counts = {}
      @source_bytes = 0
      @warnings = []
      @declarations = nil
      @context_files = nil
      @context_set = nil
    end

    def relative(path)
      return nil unless path.is_a?(String) && path.valid_encoding? && path.end_with?('.rb')
      return @paths[path] if @paths.key?(path)
      original = File.expand_path(path, @root)
      return @paths[path] = nil if File.symlink?(original)
      absolute = File.realpath(original)
      prefix = @root + File::SEPARATOR
      @paths[path] = if absolute.start_with?(prefix) && File.file?(absolute)
        name = absolute[prefix.length..-1]
        name if !name.split('/').any? { |part| part.empty? || part == '..' || part == '.' } && !name.include?("\0")
      end
    rescue SystemCallError, ArgumentError
      @paths[path] = nil
    end

    def text(file)
      return @texts[file] if @texts.key?(file)
      absolute = File.join(@root, file)
      return @texts[file] = nil unless relative(absolute) == file && File.size(absolute) <= MAX_SOURCE_BYTES
      if @source_bytes + File.size(absolute) > MAX_TOTAL_SOURCE_BYTES
        @warnings << 'Source byte limit reached; metadata is incomplete' if @warnings.empty?
        return @texts[file] = nil
      end
      bytes = File.binread(absolute).force_encoding(Encoding::UTF_8)
      @source_bytes += bytes.bytesize
      @texts[file] = bytes.valid_encoding? && !bytes.byteslice(0, 8_000).include?("\0") ? bytes : nil
    rescue SystemCallError
      @texts[file] = nil
    end

    def location(path, line)
      file = relative(path)
      context_files
      return nil unless file && @context_set.key?(file)
      body = file && text(file)
      return nil unless body && line.is_a?(Integer) && line > 0 && line <= (@line_counts[file] ||= body.lines.length)
      { 'file' => file, 'line' => line }
    end

    def fingerprint(file)
      return @fingerprints[file] if @fingerprints.key?(file)
      body = text(file)
      @fingerprints[file] = MegamapEvidence.fingerprint(body) if body
    end

    def declaration_index
      return @declarations if @declarations
      @declarations = {}
      context_files.each do |file|
        body = text(file)
        next unless body
        begin
          tree = Ripper.sexp(body)
          walk(tree, [], file) if tree
        rescue SystemStackError, SyntaxError
          @warnings << 'Some source declarations could not be indexed' unless @warnings.include?('Some source declarations could not be indexed')
        end
      end
      @declarations
    end

    def context_files
      return @context_files if @context_files
      @context_files = files.select { |file| !text(file).nil? }
      @context_set = @context_files.map { |file| [file, true] }.to_h
      @context_files
    end

    private

    def files
      output, _error, status = Open3.capture3('git', '-C', @root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.rb')
      paths = status.success? ? output.split("\0") : fallback_files('', [])
      valid_files(paths)
    rescue SystemCallError
      valid_files(fallback_files('', []))
    end

    def valid_files(paths)
      paths = paths.select { |file| relative(file) == file }.uniq.sort
      raise ArgumentError, 'Project Ruby source context exceeds the export file limit' if paths.length > MAX_FILES
      paths
    end

    def fallback_files(directory, inherited_rules)
      absolute = File.join(@root, directory)
      rules = inherited_rules.dup
      ignore_file = File.join(absolute, '.gitignore')
      if File.file?(ignore_file)
        File.read(ignore_file, encoding: 'UTF-8').each_line do |line|
          pattern = line.strip
          next if pattern.empty? || pattern.start_with?('#', '!')
          dir_only = pattern.end_with?('/')
          pattern = pattern.sub(%r{/+\z}, '')
          rules << { base: directory, pattern: pattern.sub(%r{\A/+}, ''), anchored: pattern.include?('/'), dir_only: dir_only }
        end
      end
      Dir.children(absolute).sort.each_with_object([]) do |name, result|
        next if name == '.git'
        path = directory.empty? ? name : "#{directory}/#{name}"
        full = File.join(@root, path)
        kind = File.lstat(full)
        next if kind.symlink?
        dir = kind.directory?
        next if rules.any? { |rule| ignored?(rule, path, name, dir) }
        if dir
          result.concat(fallback_files(path, rules))
        elsif kind.file? && path.end_with?('.rb')
          result << path
        end
      end
    rescue SystemCallError, EncodingError
      []
    end

    def ignored?(rule, path, name, directory)
      return false if rule[:dir_only] && !directory
      local = if rule[:anchored]
        prefix = rule[:base].empty? ? '' : rule[:base] + '/'
        return false unless path.start_with?(prefix)
        path[prefix.length..-1]
      else
        name
      end
      pattern = Regexp.escape(rule[:pattern].b).gsub('\\*', '[^/]*').gsub('\\?', '[^/]')
      Regexp.new("\\A#{pattern}\\z", Regexp::NOENCODING).match?(local.b)
    end

    def constant(node)
      return nil unless node.is_a?(Array)
      case node[0]
      when :const_ref, :var_ref then constant(node[1])
      when :top_const_ref then name = constant(node[1]); "::#{name}" if name
      when :const_path_ref, :const_path_field
        left = constant(node[1]); right = constant(node[2]); "#{left}::#{right}" if left && right
      when :@const then node[1]
      end
    end

    def first_line(node)
      return nil unless node.is_a?(Array)
      return node[2][0] if node[0].to_s.start_with?('@') && node[2].is_a?(Array)
      node.each do |child|
        result = first_line(child)
        return result if result
      end
      nil
    end

    def qualified(raw, nesting)
      return raw[2..-1] if raw.start_with?('::')
      candidates = nesting.reverse.map { |parent| "#{parent}::#{raw}" } + [raw]
      candidates.find { |candidate| MegamapEvidence.loaded_constant(candidate).is_a?(Module) } || candidates.first
    end

    def walk(node, nesting, file)
      return unless node.is_a?(Array)
      if node[0] == :class || node[0] == :module
        raw = constant(node[1])
        return unless raw
        name = qualified(raw, nesting)
        line = first_line(node[1])
        inheritance = node[0] == :class && !node[2].nil?
        declaration = { 'file' => file, 'line' => line, 'inheritance' => inheritance }
        previous = @declarations[name]
        @declarations[name] = declaration if previous.nil? || (inheritance && !previous['inheritance'])
        body = node[node[0] == :class ? 3 : 2]
        walk(body, nesting + [name], file)
      elsif node[0] != :sclass
        node.each { |child| walk(child, nesting, file) }
      end
    end
  end

  class Exporter
    def initialize(root, label, warnings = [], calls = [], trace_files = nil)
      @sources = Sources.new(root)
      @label = MegamapEvidence.clean_label(label)
      @warnings = warnings.dup
      @calls = calls
      @trace_files = trace_files
      @files = {}
      @method_definitions = []
      @method_indices = {}
      @method_locations = {}
      @method_owners = {}.compare_by_identity
    end

    def export(output)
      current_context = @sources.context_files
      context = @trace_files ? @trace_files.keys.sort : current_context
      @files = @trace_files ? @trace_files.dup : context.map { |file| [file, @sources.fingerprint(file)] }.to_h
      if @trace_files && (context != current_context || context.any? { |file| @sources.fingerprint(file) != @trace_files[file] })
        warning('Project Ruby source context changed during capture; recapture before importing')
      end
      classes = []
      @sources.declaration_index.sort.each do |name, declaration|
        mod = MegamapEvidence.loaded_constant(name)
        next unless mod.is_a?(Module)
        if classes.length >= MAX_CLASSES
          warning('Class export limit reached; metadata is incomplete')
          break
        end
        location = @sources.location(declaration['file'], declaration['line'])
        next unless location
        entry = location.merge('name' => name, 'ancestors' => mod.ancestors.map { |ancestor| MegamapEvidence.module_name(ancestor) }.compact.take(256),
                               'active_record' => active_record?(mod), 'attributes' => [], 'associations' => [], 'method_refs' => [])
        add_file(entry['file'])
        if entry['active_record']
          entry['attributes'] = attempt("Attribute metadata unavailable for #{name}", []) { mod.attribute_names.map(&:to_s).uniq.sort.take(2_000) }
          entry['associations'] = attempt("Association metadata unavailable for #{name}", []) { associations(mod) }
        end
        entry['method_refs'] = methods(mod, false) + methods(mod, true)
        classes << entry
      end
      calls = @calls.select do |call|
        valid = [call['caller'], call['callee']].all? do |symbol|
          file = symbol['file']
          current = @sources.fingerprint(file)
          current && @trace_files && current == @trace_files[file] && @sources.location(file, symbol['line'])
        end
        valid &&= !@sources.location(call['caller']['file'], call['line']).nil?
        if valid
          add_file(call['caller']['file']); add_file(call['callee']['file'])
        else
          warning('Source changed or became unavailable during capture; affected observations were skipped')
        end
        valid
      end
      @sources.warnings.each { |message| warning(message) }
      document = { 'version' => 2, 'label' => @label, 'captured_at' => Time.now.utc.iso8601,
                   'files' => @files.sort.to_h, 'context_files' => context, 'classes' => classes,
                   'method_definitions' => @method_definitions, 'calls' => calls, 'warnings' => @warnings.take(64) }
      encoded = JSON.generate(document)
      raise ArgumentError, 'Evidence exceeds the 32 MiB export limit' if encoded.bytesize > MAX_JSON_BYTES
      write(output, encoded) if output
      document
    end

    private

    def warning(message)
      @warnings << message if @warnings.length < 64 && !@warnings.include?(message)
    end

    def attempt(message, fallback)
      yield
    rescue StandardError, LoadError
      warning(message)
      fallback
    end

    def add_file(file)
      @files[file] ||= @sources.fingerprint(file)
    end

    def active_record?(mod)
      base = MegamapEvidence.loaded_constant('ActiveRecord::Base')
      mod.is_a?(Class) && base.is_a?(Class) && !!(mod <= base)
    end

    def associations(mod)
      mod.reflect_on_all_associations.each_with_object([]) do |association, result|
        attempt("Some associations were unavailable for #{MegamapEvidence.module_name(mod)}", nil) do
          next if association.polymorphic?
          target = MegamapEvidence.module_name(association.klass)
          next unless target && CONSTANT_NAME.match?(target)
          result << { 'name' => association.name.to_s, 'target' => target, 'collection' => !!association.collection? }
        end
      end.take(2_000)
    end

    def methods(mod, singleton)
      receiver = singleton ? mod.singleton_class : mod
      names = (receiver.public_instance_methods + receiver.protected_instance_methods + receiver.private_instance_methods).uniq.sort
      entries = []
      names.each do |name|
        method = receiver.instance_method(name)
        source = method.source_location
        next unless source
        location = @method_locations.fetch(source) { @method_locations[source] = @sources.location(source[0], source[1]) }
        next unless location
        defining_owner = method.owner
        owner = @method_owners[defining_owner] ||= MegamapEvidence.owner_name(defining_owner)
        next unless owner
        original_name = method.respond_to?(:original_name) ? method.original_name : method.name
        definition_name = "#{owner[0]}#{owner[1]}#{original_name}"
        key = [definition_name, location['file'], location['line']]
        index = @method_indices[key]
        unless index
          if @method_definitions.length >= MAX_METHODS
            warning('Method export limit reached; metadata is incomplete')
            next
          end
          index = @method_definitions.length
          @method_indices[key] = index
          @method_definitions << location.merge('name' => definition_name)
          add_file(location['file'])
        end
        entries << [name.to_s, singleton, index]
      end
      entries
    rescue StandardError
      warning("Some method metadata was unavailable for #{MegamapEvidence.module_name(mod)}")
      entries || []
    end

    def write(output, bytes)
      path = File.expand_path(output)
      temporary = "#{path}.#{Process.pid}.tmp"
      created = false
      begin
        File.open(temporary, File::WRONLY | File::CREAT | File::EXCL, 0o600) do |file|
          created = true
          file.write(bytes)
        end
        File.rename(temporary, path)
      ensure
        File.unlink(temporary) if created && File.exist?(temporary)
      end
    end
  end

  class Collector
    attr_reader :warnings

    def initialize(root, max_events, max_calls)
      @sources = Sources.new(root)
      @context = @sources.context_files.map { |file| [file, @sources.fingerprint(file)] }.to_h
      @max_events = [[Integer(max_events), 1].max, MAX_EVENTS].min
      @max_calls = [[Integer(max_calls), 1].max, MAX_CALLS].min
      @events = 0
      @stacks = {}
      @calls = {}
      @warnings = []
      @mutex = Mutex.new
      @finished = false
      @trace = TracePoint.new(:call, :return, :c_call, :c_return, :b_call, :b_return, :line) { |event| record(event) }
    end

    def enable
      @trace.enable
    end

    def disable
      @trace.disable
      @mutex.synchronize do
        @finished = true
        @stacks.clear
      end
    end

    def calls
      @calls.values
    end

    def files
      @context
    end

    private

    def descriptor(event)
      location = @sources.location(event.path, event.lineno)
      owner = MegamapEvidence.owner_name(event.defined_class)
      location && owner && location.merge('name' => "#{owner[0]}#{owner[1]}#{event.method_id}")
    end

    def record(event)
      @mutex.synchronize { record_event(event) unless @finished }
    end

    def record_event(event)
      @events += 1
      if @events > @max_events
        @warnings << 'Trace event limit reached; observed calls cover only part of the capture'
        @trace.disable
        return
      end
      key = [Thread.current, Fiber.current]
      unless @stacks.key?(key)
        if @stacks.length >= MAX_STACKS
          @warnings << 'Trace thread/fiber limit reached; observations are incomplete'
          @trace.disable
          return
        end
        @stacks[key] = []
      end
      stack = @stacks[key]
      kind = event.event
      if kind == :line
        frame = stack.last
        if frame && frame[:symbol] && @sources.relative(event.path) == frame[:symbol]['file']
          frame[:line] = event.lineno
        end
      elsif [:call, :c_call, :b_call].include?(kind)
        symbol = kind == :call ? descriptor(event) : nil
        caller = stack.last
        if symbol && caller && caller[:symbol] && caller[:line]
          called_name = event.respond_to?(:callee_id) ? event.callee_id : event.method_id
          call_key = [caller[:symbol], symbol, caller[:line], called_name]
          if @calls.key?(call_key)
            @calls[call_key]['count'] += 1
          elsif @calls.length < @max_calls
            @calls[call_key] = { 'caller' => caller[:symbol], 'callee' => symbol, 'line' => caller[:line], 'method' => called_name.to_s, 'count' => 1 }
          elsif !@warnings.include?('Observed call limit reached; observations are incomplete')
            @warnings << 'Observed call limit reached; observations are incomplete'
          end
        end
        stack << { kind: kind, method: event.method_id, symbol: symbol, line: nil }
      else
        expected = { return: :call, c_return: :c_call, b_return: :b_call }[kind]
        index = stack.rindex { |frame| frame[:kind] == expected && frame[:method] == event.method_id }
        index ? stack.slice!(index..-1) : stack.clear
      end
    rescue StandardError
      @warnings << 'Some trace events could not be recorded' unless @warnings.include?('Some trace events could not be recorded')
      @stacks.clear
    end
  end
end

if ENV['MEGAMAP_EVIDENCE_MODE'] == 'snapshot' || $PROGRAM_NAME == __FILE__
  output = ENV['MEGAMAP_EVIDENCE_OUT']
  raise ArgumentError, 'MEGAMAP_EVIDENCE_OUT is required' if output.nil? || output.empty?
  MegamapEvidence.snapshot(output: output, label: ENV.fetch('MEGAMAP_EVIDENCE_LABEL', 'Loaded Rails app'))
end
