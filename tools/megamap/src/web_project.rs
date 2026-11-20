use crate::{call_colors::{self, CallHighlights}, evidence::{EvidenceFilter, EvidenceKind, Snapshot}, evidence_input::{self, EvidenceInput}, filter::Filter, history::{self, History}, model::{self, ColorMode, Kind, R, Tree}, palette, relationships::{self, Direction, Graph, Reachability, SourceFile}, scan, source_cache::{self, SourceCache}, syntax::HighlightedText};
use serde_json::{json, Value};
use std::{collections::HashSet, fs, io::Read, path::{Component, Path, PathBuf}};

pub const MAX_INPUT: usize = 64 * 1024 * 1024;
pub const MAX_OUTPUT: usize = 128 * 1024 * 1024;
const MAX_SOURCE: usize = 2 * 1024 * 1024;
const MAX_INDEX_SOURCE: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug)]
struct Options {
    filter: String, hide_tests: bool, show_ignored: bool, color: ColorMode, search: String,
    trace_root: Option<usize>, direction: String, depth: usize, evidence: String,
}
impl Default for Options {
    fn default() -> Self { Self { filter: String::new(), hide_tests: false, show_ignored: false, color: ColorMode::FileType, search: String::new(), trace_root: None, direction: "all".into(), depth: 1, evidence: "all".into() } }
}
impl Options {
    fn parse(value: Option<&Value>) -> Result<Self, String> {
        let mut out = Self::default();
        let Some(value) = value else { return Ok(out) };
        if !value.is_object() { return Err("options must be an object".into()); }
        for (name, target) in [("filter", &mut out.filter), ("search", &mut out.search), ("direction", &mut out.direction), ("evidence", &mut out.evidence)] {
            if let Some(v) = value.get(name) { *target = v.as_str().ok_or_else(|| format!("{name} must be a string"))?.into(); }
        }
        for (name, target) in [("hideTests", &mut out.hide_tests), ("showIgnored", &mut out.show_ignored)] {
            if let Some(v) = value.get(name) { *target = v.as_bool().ok_or_else(|| format!("{name} must be a boolean"))?; }
        }
        if let Some(v) = value.get("color") { out.color = match v.as_str() { Some("file_type") => ColorMode::FileType, Some("recent") => ColorMode::Recent, Some("churn") => ColorMode::Churn, _ => return Err("invalid color mode".into()) }; }
        if let Some(v) = value.get("traceRoot").filter(|v| !v.is_null()) { out.trace_root = Some(node_id(v)?); }
        if let Some(v) = value.get("depth") { out.depth = v.as_u64().filter(|n| (1..=relationships::MAX_DEPTH as u64).contains(n)).ok_or_else(|| format!("depth must be between 1 and {}", relationships::MAX_DEPTH))? as usize; }
        if !matches!(out.direction.as_str(), "all" | "callees" | "callers") { return Err("invalid direction".into()); }
        if !matches!(out.evidence.as_str(), "all" | "source" | "static" | "loaded" | "observed") { return Err("invalid evidence mode".into()); }
        Ok(out)
    }
    fn evidence_filter(&self) -> EvidenceFilter {
        EvidenceFilter::for_mode(match self.evidence.as_str() {
            "source" => 1, "static" => 2, "loaded" => 3, "observed" => 4, _ => 0,
        })
    }
}
fn node_id(value: &Value) -> Result<usize, String> { value.as_u64().and_then(|n| usize::try_from(n).ok()).ok_or_else(|| "node must be a numeric indexed ID".into()) }

pub struct Project {
    root: PathBuf, tree: Tree, scanned: bool, options: Options, filter: Filter, history: Option<History>,
    graph: Option<Graph>, source: SourceCache, reachable: Option<Reachability>, highlights: CallHighlights,
    evidence_status: String, notice: String, read_errors: usize, revision: u64, allow_capture: bool,
}
impl Project {
    pub fn new(root: &Path, allow_capture: bool) -> Result<Self, String> {
        let root = root.canonicalize().map_err(|_| "registered project root does not exist")?;
        if !root.is_dir() { return Err("registered project root must be a directory".into()); }
        let label = root.file_name().unwrap_or(root.as_os_str()).to_string_lossy().into_owned();
        Ok(Self { root, tree: Tree::new(&label), scanned: false, options: Options::default(), filter: Filter::default(), history: None, graph: None, source: SourceCache::default(), reachable: None, highlights: CallHighlights::default(), evidence_status: "Static analysis; optional app data is off".into(), notice: String::new(), read_errors: 0, revision: 0, allow_capture })
    }
    pub fn request(&mut self, request: &Value) -> Value {
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        match self.execute(request) { Ok(result) => json!({"id":id,"result":result}), Err(error) => json!({"id":id,"error":error}) }
    }
    fn scan(&mut self) -> Result<(), String> {
        if !self.scanned {
            for entry in scan::scan_project(&self.root)?.entries {
                if self.secure_path(&entry.path).is_ok() { self.tree.insert(entry); }
            }
            self.scanned = true;
        }
        Ok(())
    }
    fn execute(&mut self, request: &Value) -> Result<Value, String> {
        let op = request.get("op").and_then(Value::as_str).ok_or("op must be a string")?;
        if op == "capture" && !self.allow_capture { return Err("capture is disabled; start with --allow-capture to enable it".into()); }
        self.scan()?;
        match op {
            "view" => {
                let mut options = Options::parse(request.get("options"))?;
                if let Some(node) = options.trace_root {
                    let n = self.tree.nodes.get(node).ok_or("unknown trace root ID")?;
                    if n.kind != Kind::Text || n.ignored || !relationships::supports_path(&n.path) { return Err("trace root must be a non-ignored Ruby, JavaScript or TypeScript file".into()); }
                }
                self.notice.clear();
                match Filter::parse(&options.filter) {
                    Ok(filter) => self.filter = filter,
                    Err(error) => { options.filter = self.options.filter.clone(); self.notice = format!("Invalid filter: {error}. Keeping previous valid filter"); }
                }
                self.options = options;
                if self.options.trace_root.is_some() && self.options.direction != "all" { self.ensure_graph()?; }
                self.view()
            }
            "source" => {
                let node = node_id(request.get("node").ok_or("node is required")?)?;
                let syntax = request.get("syntax").map(|v| v.as_bool().ok_or("syntax must be a boolean")).transpose()?.unwrap_or(true);
                self.source(node, syntax)
            }
            "expand" => {
                let node = node_id(request.get("node").ok_or("node is required")?)?;
                let n = self.tree.nodes.get(node).ok_or("unknown node ID")?;
                if !matches!(n.kind, Kind::Ghost { .. }) { return Err("expand requires an unread ignored node".into()); }
                let path = n.path.clone(); self.secure_path(&path)?;
                let entries = scan::scan_ignored(&self.root, &path).into_iter().filter(|entry| self.secure_path(&entry.path).is_ok()).collect();
                self.tree.graft(node, entries);
                if let Some(history) = &self.history { self.tree.apply_history(history); }
                self.view()
            }
            "evidence" => {
                let input = request.get("snapshot").ok_or("snapshot is required")?;
                if !input.is_null() && !input.is_string() { return Err("snapshot must be a JSON string or null".into()); }
                self.refresh_sources()?;
                let sources = self.sources();
                let snapshot = if input.is_null() { self.evidence_status = "Static analysis; optional app data is off".into(); None }
                    else if let Some(text) = input.as_str() {
                        match Snapshot::parse(text, &sources) {
                            Ok(snapshot) => { self.evidence_status = snapshot_status(&snapshot); Some(snapshot) }
                            Err(error) => { self.evidence_status = format!("Optional evidence unavailable: {error}. Using static analysis"); None }
                        }
                    } else { return Err("snapshot must be a JSON string or null".into()); };
                self.build_graph(&sources, snapshot.as_ref()); self.view()
            }
            "capture" => {
                self.refresh_sources()?;
                let sources = self.sources();
                let evidence = evidence_input::load(&self.root, &sources, &EvidenceInput::Rails);
                self.evidence_status = evidence.status;
                self.build_graph(&sources, evidence.snapshot.as_ref()); self.view()
            }
            _ => Err("unknown operation".into()),
        }
    }
    fn secure_path(&self, relative: &str) -> Result<PathBuf, String> {
        let path = Path::new(relative);
        if path.is_absolute() || path.components().any(|part| !matches!(part, Component::Normal(_))) { return Err("invalid indexed path".into()); }
        let mut full = self.root.clone();
        for part in path.components() {
            full.push(part);
            let meta = fs::symlink_metadata(&full).map_err(|_| "indexed file is unavailable")?;
            if meta.file_type().is_symlink() { return Err("symlink reads are not allowed".into()); }
        }
        let full = full.canonicalize().map_err(|_| "indexed file is unavailable")?;
        if !full.starts_with(&self.root) { return Err("indexed file is outside the registered root".into()); }
        Ok(full)
    }
    fn read_text(&self, path: &str, limit: usize) -> Result<String, String> {
        let path = self.secure_path(path)?;
        if !path.is_file() { return Err("source is not a regular file".into()); }
        let file = fs::File::open(path).map_err(|_| "source could not be opened")?;
        let mut bytes = Vec::new();
        file.take(limit as u64 + 1).read_to_end(&mut bytes).map_err(|_| "source could not be read")?;
        if bytes.len() > limit { return Err(format!("source exceeds {} MiB limit", limit / 1024 / 1024)); }
        if bytes.contains(&0) { return Err("binary source is unavailable".into()); }
        String::from_utf8(bytes).map_err(|_| "source is not supported UTF-8 text".into())
    }
    fn refresh_sources(&mut self) -> Result<(), String> {
        let mut sources = Vec::new(); let mut failed = 0;
        for node in &self.tree.nodes {
            if node.kind == Kind::Text && !node.ignored && relationships::supports_path(&node.path) {
                match self.read_text(&node.path, MAX_INDEX_SOURCE) { Ok(text) => sources.push(SourceFile { path: node.path.clone(), text }), Err(_) => failed += 1 }
            }
        }
        let (entries, originals) = source_cache::prepare(sources);
        for entry in entries { self.tree.insert(entry); }
        self.source.replace(originals);
        self.read_errors = failed;
        if failed > 0 { self.notice = format!("{failed} source files unavailable to the call index"); }
        Ok(())
    }
    fn sources(&self) -> Vec<SourceFile> {
        let mut sources: Vec<_> = self.source.originals.iter().map(|(path, text)| SourceFile { path: path.clone(), text: (**text).clone() }).collect();
        sources.sort_by(|a,b| a.path.cmp(&b.path)); sources
    }
    fn build_graph(&mut self, sources: &[SourceFile], snapshot: Option<&Snapshot>) {
        let base_url = self.read_text("tsconfig.json", MAX_SOURCE).ok().and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .and_then(|value| value.pointer("/compilerOptions/baseUrl").and_then(Value::as_str).map(str::to_owned));
        self.graph = Some(Graph::build_with_snapshot(sources, base_url.as_deref(), snapshot));
    }
    fn ensure_graph(&mut self) -> Result<(), String> {
        if self.graph.is_none() { self.refresh_sources()?; self.build_graph(&self.sources(), None); }
        Ok(())
    }
    fn view(&mut self) -> Result<Value, String> {
        self.reachable = if self.options.direction != "all" {
            self.graph.as_ref().zip(self.options.trace_root).map(|(graph, node)| graph.related_filtered(&self.tree.nodes[node].path,
                if self.options.direction == "callers" { Direction::Callers } else { Direction::Callees }, self.options.depth, self.options.evidence_filter()))
        } else { None };
        self.tree.update_weights(self.options.show_ignored);
        self.tree.apply_filter(&self.filter, self.options.hide_tests, self.reachable.as_ref().map(|r| &r.paths));
        if self.options.color != ColorMode::FileType && self.history.is_none() {
            match history::load(&self.root) {
                Ok(history) => { self.tree.apply_history(&history); self.history = Some(history); }
                Err(_) => { self.notice = "Git history is unavailable for this project".into(); self.history = Some(History::default()); },
            }
        }
        self.tree.compute_heat(self.options.color);
        self.tree.layout(R { x:0.0, y:0.0, w:1000.0, h:700.0 });
        self.tree.search(&self.options.search);
        let visible: HashSet<_> = self.tree.nodes.iter().enumerate().filter(|(id,n)| n.is_file() && self.tree.is_visible(*id)).map(|(_,n)| n.path.clone()).collect();
        self.highlights = CallHighlights::new(self.reachable.as_ref().map_or(&[], |r| r.call_sites.as_slice()), &visible);
        self.revision = self.revision.wrapping_add(1);
        let nodes: Vec<_> = self.tree.nodes.iter().enumerate().map(|(id,n)| {
            let kind = match n.kind { Kind::Dir => "dir", Kind::Text => "text", Kind::Binary => "binary", Kind::Ghost { dir:true,.. } => "ghost_dir", Kind::Ghost { .. } => "ghost_file" };
            let color = if self.reachable.is_some() && n.is_file() { call_colors::file_rgb(&n.path, self.options.trace_root.map(|id| self.tree.nodes[id].path.as_str())) }
                else if self.options.color != ColorMode::FileType { palette::heat_color(n.heat) }
                else { palette::file_type_color(&n.name,n.kind == Kind::Binary) };
            json!({"id":id,"parent":n.parent,"children":n.children,"name":n.name,"path":n.path,"kind":kind,"ignored":n.ignored,"visible":self.tree.is_visible(id),"rect":rect(n.rect),"inner":rect(model::code_inner(n.rect)),"cols":n.cols,"lineHeight":n.line_h,"lineCount":n.lines.len(),"totalLines":n.total_lines,"totalFiles":n.total_files,"bytes":n.bytes,"commits":n.commits,"lastChange":n.last_change,"color":color,"lit":n.lit,"onPath":n.on_path})
        }).collect();
        let root = &self.tree.nodes[0];
        let reached = self.reachable.as_ref();
        let count = |set: &HashSet<String>| set.iter().filter(|path| visible.contains(*path)).count();
        let status = format!("{} files · {} lines{}", root.total_files, root.total_lines, if self.notice.is_empty() { String::new() } else { format!(" · {}", self.notice) });
        Ok(json!({"revision":self.revision,"root":root.name,"nodes":nodes,"geometry":{"columnChars":model::COL_CHARS,"charWidth":model::CHAR_W},"status":status,"evidenceStatus":self.evidence_status,"counts":{"files":root.total_files,"lines":root.total_lines,"nodes":self.tree.nodes.iter().enumerate().filter(|(id,_)| self.tree.is_visible(*id)).count()},"trace":{"root":self.options.trace_root,"analyzedFiles":self.graph.as_ref().map_or(0,|g|g.analyzed_files),"unresolvedSites":self.graph.as_ref().map_or(0,|g|g.unresolved_sites),"parseErrors":self.graph.as_ref().map_or(0,|g|g.parse_errors),"unreadFiles":self.read_errors,"direct":reached.map_or(0,|r|count(&r.direct)),"indirect":reached.map_or(0,|r|count(&r.indirect)),"reachedSymbols":reached.map_or(0,|r|r.reached_symbols),"sites":self.highlights.site_count(),"inferred":self.highlights.inferred_site_count(),"loaded":self.highlights.evidence_site_count(EvidenceKind::Loaded),"observed":self.highlights.evidence_site_count(EvidenceKind::Observed)},"capabilities":{"capture":self.allow_capture,"maxDepth":relationships::MAX_DEPTH}}))
    }
    fn source(&mut self, node: usize, syntax: bool) -> Result<Value, String> {
        let n = self.tree.nodes.get(node).ok_or("unknown node ID")?;
        let ignored = n.ignored;
        let path = n.path.clone();
        self.secure_path(&path)?;
        let strips: Vec<_> = n.lines.iter().map(|line| json!([line.indent,line.len,line.comment])).collect();
        let empty = |message: String| json!({"node":node,"path":path,"lines":[],"strips":strips,"message":message});
        if n.kind != Kind::Text { return Ok(empty("Source unavailable: read ignored nodes explicitly; directories and binary files have no text".into())); }
        let original = self.source.originals.get(&path).cloned();
        if original.as_ref().is_some_and(|text| text.len() > MAX_SOURCE) { return Ok(empty("Source unavailable: source exceeds 2 MiB limit".into())); }
        let mut refreshed = false;
        if !self.source.files.contains_key(&node) {
            let text = match original { Some(text) => (*text).clone(), None => match self.read_text(&path, MAX_SOURCE) { Ok(text) => text, Err(message) => return Ok(empty(format!("Source unavailable: {message}"))) } };
            let summary = scan::summarize_lines(text.as_bytes());
            let old = &self.tree.nodes[node];
            refreshed = old.bytes != text.len() as u64 || old.lines.len() != summary.len() || old.lines.iter().zip(&summary).any(|(a,b)| (a.indent,a.len,a.comment) != (b.indent,b.len,b.comment));
            self.tree.insert(scan::Entry { path: path.clone(), ignored, kind: scan::EntryKind::Text { bytes: text.len() as u64, lines: summary } });
            self.source.accept(self.source.generation, node, HighlightedText::new(&path, &text));
        }
        let root = self.options.trace_root.map(|id| self.tree.nodes[id].path.as_str());
        let lines: Vec<_> = self.source.files[&node].lines.iter().enumerate().map(|(index,line)| {
            let marks = self.highlights.line(&path,index+1); let columns = line.text.chars().count();
            let runs: Vec<_> = call_colors::paint_line(line,marks,root,syntax,columns).into_iter().map(|run| json!({"text":run.text,"color":run.color})).collect();
            let links: Vec<_> = call_colors::link_ranges(marks,columns).into_iter().filter_map(|link| {
                let target = self.tree.find(&link.definition.file).filter(|id| self.tree.is_visible(*id))?;
                Some(json!({"start":link.start,"end":link.end,"definition":{"node":target,"name":link.definition.name,"file":link.definition.file,"line":link.definition.line},"reason":link.inference,"evidence":link.evidence.label()}))
            }).collect();
            json!({"text":line.text,"runs":runs,"links":links})
        }).collect();
        let strips: Vec<_> = self.tree.nodes[node].lines.iter().map(|line| json!([line.indent,line.len,line.comment])).collect();
        Ok(json!({"node":node,"path":path,"lines":lines,"strips":strips,"message":if refreshed { Some("Source changed since the map scan; refresh the project to update geometry") } else { None }}))
    }
}
fn rect(r: R) -> [f64;4] { [r.x,r.y,r.w,r.h] }
fn snapshot_status(snapshot: &Snapshot) -> String {
    format!("Loaded evidence: {}{}", snapshot.label, if snapshot.warnings.is_empty() { String::new() } else { format!(" · {} warnings/ignored entries: {}",snapshot.warnings.len(),snapshot.warnings.iter().take(2).cloned().collect::<Vec<_>>().join("; ")) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("spamton-web-project-{}-{}",std::process::id(),NEXT.fetch_add(1,Ordering::Relaxed)));
            fs::create_dir_all(&path).unwrap();
            fs::write(path.join("a.ts"),"import { run } from './b';\nexport function start() { return run(); }\n").unwrap();
            fs::write(path.join("b.ts"),"export function run() { return 1; }\n").unwrap();
            fs::write(path.join("note.txt"),"a plain text file\n").unwrap();
            Self(path)
        }
        fn project(&self) -> Project { Project::new(&self.0,false).unwrap() }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    fn result(response: Value) -> Value { assert!(response.get("error").is_none(),"{response}");response["result"].clone() }
    fn view(project: &mut Project, options: Value) -> Value { result(project.request(&json!({"id":1,"op":"view","options":options}))) }
    #[test]
    fn depth_control_limit_matches_the_graph_limit() {
        let fixture = Fixture::new(); let mut project = fixture.project();
        let initial = view(&mut project, json!({}));
        assert_eq!(initial["capabilities"]["maxDepth"], relationships::MAX_DEPTH);
        assert!(project.request(&json!({"op":"view","options":{"depth":relationships::MAX_DEPTH+1}}))["error"].is_string());
    }

    #[test]
    fn trace_diagnostics_keep_unread_and_parse_failures_visible_across_depth_changes() {
        let fixture=Fixture::new();fs::write(fixture.0.join("broken.rb"),"class Broken(\n").unwrap();
        let mut project=fixture.project();view(&mut project,json!({}));let a=project.tree.find("a.ts").unwrap();fs::remove_file(fixture.0.join("b.ts")).unwrap();
        for depth in [1,2] {
            let traced=view(&mut project,json!({"traceRoot":a,"direction":"callees","depth":depth}));
            assert_eq!(traced["trace"]["unreadFiles"],1);
            assert_eq!(traced["trace"]["parseErrors"],1);
        }
    }
    #[test]
    fn filters_retain_node_ids_and_invalid_filter_retains_previous_selection() {
        let fixture = Fixture::new(); let mut project = fixture.project();
        let initial = view(&mut project,json!({}));
        let a = project.tree.find("a.ts").unwrap(); let b = project.tree.find("b.ts").unwrap();
        let filtered = view(&mut project,json!({"filter":"a.ts"}));
        assert_eq!(initial["nodes"].as_array().unwrap().len(),filtered["nodes"].as_array().unwrap().len());
        assert_eq!(filtered["nodes"][a]["visible"],true);assert_eq!(filtered["nodes"][b]["visible"],false);
        assert_eq!(filtered["counts"]["files"],1);
        let invalid = view(&mut project,json!({"filter":"("}));
        assert!(invalid["status"].as_str().unwrap().contains("Invalid filter"));
        assert_eq!(invalid["counts"]["files"],1);
        assert_eq!(view(&mut project,json!({}))["counts"]["files"],3);
    }
    #[test]
    fn indexed_text_and_summaries_stay_together_and_calls_link_without_syntax() {
        let fixture = Fixture::new();let mut project = fixture.project();view(&mut project,json!({}));
        let a = project.tree.find("a.ts").unwrap();
        let traced = view(&mut project,json!({"traceRoot":a,"direction":"callees"}));
        assert_eq!(traced["counts"]["files"],2);assert_eq!(traced["trace"]["direct"],1);
        fs::write(fixture.0.join("a.ts"),"changed\n").unwrap();
        let source = result(project.request(&json!({"id":2,"op":"source","node":a,"syntax":false})));
        assert_eq!(source["lines"].as_array().unwrap().len(),2);
        assert!(source["lines"][1]["text"].as_str().unwrap().contains("run()"));
        assert_eq!(source["lines"][1]["links"].as_array().unwrap().len(),1);
        assert_eq!(source["strips"].as_array().unwrap().len(),2);
        let all = view(&mut project,json!({"traceRoot":a,"direction":"all"}));
        assert_eq!(all["counts"]["files"],3);assert_eq!(all["trace"]["sites"],0);assert_eq!(all["trace"]["root"],a);
    }
    #[test]
    fn live_source_before_indexing_refreshes_its_strips_and_reports_old_geometry() {
        let fixture = Fixture::new();let mut project = fixture.project();view(&mut project,json!({}));
        let node = project.tree.find("note.txt").unwrap();
        fs::write(fixture.0.join("note.txt"),"first\n\tsecond\n").unwrap();
        let source = result(project.request(&json!({"id":2,"op":"source","node":node})));
        assert_eq!(source["lines"].as_array().unwrap().len(),2);
        assert_eq!(source["strips"].as_array().unwrap().len(),2);
        assert_eq!(source["strips"][1][0],4);
        assert!(source["message"].as_str().unwrap().contains("refresh"));
    }
    #[test]
    fn invalid_evidence_falls_back_to_static_and_capture_requires_cli_capability() {
        let fixture = Fixture::new();let mut project = fixture.project();
        assert!(project.request(&json!({"id":9,"op":"capture"}))["error"].as_str().unwrap().contains("disabled"));
        let response = result(project.request(&json!({"id":3,"op":"evidence","snapshot":"{"})));
        assert!(response["evidenceStatus"].as_str().unwrap().contains("Using static analysis"));
        assert_eq!(response["capabilities"]["capture"],false);
    }
    #[test]
    fn source_ids_and_non_text_limits_are_explicit() {
        let fixture = Fixture::new();fs::write(fixture.0.join("blob"),b"\0binary").unwrap();
        fs::write(fixture.0.join("large.txt"),vec![b'a';MAX_SOURCE+1]).unwrap();
        let mut project = fixture.project();view(&mut project,json!({}));
        for path in ["blob","large.txt"] {
            let node = project.tree.find(path).unwrap();
            let source = result(project.request(&json!({"id":4,"op":"source","node":node})));
            assert!(source["lines"].as_array().unwrap().is_empty());assert!(source["message"].is_string());
        }
        assert!(project.request(&json!({"id":5,"op":"source","node":"../a.ts"}))["error"].is_string());
        assert!(project.request(&json!({"id":6,"op":"source","node":99999}))["error"].is_string());
    }
    #[cfg(unix)]
    #[test]
    fn indexed_paths_reject_replaced_symlink_files_and_parent_directories() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();let outside = Fixture::new();
        let mut project = fixture.project();view(&mut project,json!({}));
        let node = project.tree.find("a.ts").unwrap();
        fs::remove_file(fixture.0.join("a.ts")).unwrap();symlink(outside.0.join("a.ts"),fixture.0.join("a.ts")).unwrap();
        assert!(project.request(&json!({"id":4,"op":"source","node":node}))["error"].as_str().unwrap().contains("symlink"));
        symlink(&outside.0,fixture.0.join("linked")).unwrap();
        assert!(project.secure_path("linked/b.ts").unwrap_err().contains("symlink"));
        assert!(project.secure_path("../a.ts").is_err());
    }
    #[test]
    fn ignored_nodes_only_read_when_explicitly_expanded() {
        let fixture = Fixture::new();fs::write(fixture.0.join(".gitignore"),"vendor/\n").unwrap();
        fs::create_dir(fixture.0.join("vendor")).unwrap();fs::write(fixture.0.join("vendor/secret.txt"),"ignored text\n").unwrap();
        let mut project = fixture.project();let initial = view(&mut project,json!({"showIgnored":true}));
        let vendor = project.tree.find("vendor").unwrap();
        assert_eq!(initial["nodes"][vendor]["kind"],"ghost_dir");assert!(project.tree.find("vendor/secret.txt").is_none());
        let expanded = result(project.request(&json!({"id":5,"op":"expand","node":vendor})));
        let secret = project.tree.find("vendor/secret.txt").unwrap();
        assert_eq!(expanded["nodes"][secret]["ignored"],true);
        assert_eq!(expanded["nodes"][vendor]["kind"],"dir");
        let hidden = view(&mut project,json!({}));assert_eq!(hidden["nodes"][secret]["visible"],false);
    }
}
