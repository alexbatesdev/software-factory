use crate::relationships::{SourceFile, SymbolRef};
use serde_json::Value;
use std::{collections::{HashMap, HashSet}, sync::Arc};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum EvidenceKind {
    #[default]
    Source,
    Inferred,
    Loaded,
    Observed,
}

impl EvidenceKind {
    pub fn label(self) -> &'static str {
        match self {
            Self::Source => "Source-resolved",
            Self::Inferred => "Inferred",
            Self::Loaded => "Loaded app",
            Self::Observed => "Observed execution",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EvidenceFilter {
    pub source: bool,
    pub inferred: bool,
    pub loaded: bool,
    pub observed: bool,
}

impl Default for EvidenceFilter {
    fn default() -> Self { Self { source: true, inferred: true, loaded: true, observed: true } }
}

impl EvidenceFilter {
    pub fn for_mode(mode: usize) -> Self {
        Self { source: mode <= 2, inferred: mode == 0 || mode == 2, loaded: mode == 0 || mode == 3, observed: mode == 0 || mode == 4 }
    }

    pub fn allows(self, kind: EvidenceKind) -> bool {
        match kind { EvidenceKind::Source => self.source, EvidenceKind::Inferred => self.inferred, EvidenceKind::Loaded => self.loaded, EvidenceKind::Observed => self.observed }
    }
}

#[derive(Clone, Debug)]
pub struct LoadedMethod {
    pub name: String,
    pub singleton: bool,
    pub definition: Arc<SymbolRef>,
}

#[derive(Clone, Debug)]
pub struct LoadedAssociation {
    pub name: String,
    pub target: String,
    pub collection: bool,
}

#[derive(Clone, Debug)]
pub struct LoadedClass {
    pub name: String,
    pub file: String,
    pub line: usize,
    pub active_record: bool,
    pub attributes: Vec<String>,
    pub associations: Vec<LoadedAssociation>,
    pub methods: Vec<LoadedMethod>,
}

#[derive(Clone, Debug)]
pub struct ObservedCall {
    pub caller: SymbolRef,
    pub callee: SymbolRef,
    pub line: usize,
    pub method: String,
    pub count: u64,
}

#[derive(Clone, Debug, Default)]
pub struct Snapshot {
    pub label: String,
    pub warnings: Vec<String>,
    pub classes: Vec<LoadedClass>,
    pub calls: Vec<ObservedCall>,
}

/// A content freshness check, not an authentication or cryptographic hash.
pub fn fingerprint(text: &str) -> String {
    let value = text.as_bytes().iter().fold(14695981039346656037u64, |hash, byte| (hash ^ u64::from(*byte)).wrapping_mul(1099511628211));
    format!("{value:016x}")
}

impl Snapshot {
    pub fn parse(text: &str, sources: &[SourceFile]) -> Result<Self, String> {
        if text.len() > 64 * 1024 * 1024 { return Err("Evidence exceeds the 64 MiB limit".into()); }
        let value: Value = serde_json::from_str(text).map_err(|e| format!("Invalid evidence JSON: {e}"))?;
        let version=value.get("version").and_then(Value::as_u64).filter(|v|matches!(v,1|2)).ok_or("Unsupported evidence version (expected 1 or 2)")?;
        let files = value.get("files").and_then(Value::as_object).ok_or("Evidence needs a files fingerprint map")?;
        if files.len() > 200_000 { return Err("Too many evidence files".into()); }
        let mut source_map: HashMap<&str, Option<&str>> = HashMap::new();
        for source in sources {
            source_map.entry(&source.path).and_modify(|old| *old = None).or_insert(Some(&source.text));
        }
        let label: String = value.get("label").and_then(Value::as_str).unwrap_or("Imported capture").chars().take(256).map(|c| if c.is_control() { ' ' } else { c }).collect();
        let mut result = Self { label, ..Self::default() };
        if let Some(warnings) = value.get("warnings") {
            if let Some(warnings) = warnings.as_array() {
                for warning in warnings.iter().take(16) {
                    if let Some(text) = warning.as_str() {
                        let text: String = text.chars().take(256).map(|c| if c.is_control() { ' ' } else { c }).collect();
                        result.warn(format!("Capture warning: {text}"));
                    }
                }
                if warnings.len() > 16 { result.warn("Capture warning: further warnings omitted".into()); }
            } else { result.warn("Invalid capture warnings were ignored".into()); }
        }
        let mut validated = HashMap::new();
        for (path, expected) in files {
            let current = source_map.get(path.as_str()).and_then(|value| *value);
            if relative_path(path) && current.is_some_and(|text| expected.as_str() == Some(fingerprint(text).as_str())) {
                validated.insert(path.as_str(), current.unwrap().lines().count().max(1));
            } else { result.warn(format!("Missing, stale or invalid evidence file: {path}")); }
        }
        let context = value.get("context_files").and_then(Value::as_array).ok_or("Evidence needs a project Ruby source context; recapture it")?;
        if context.len() > 200_000 { return Err("Too many evidence context files".into()); }
        let mut captured_context = HashSet::new();
        for path in context {
            let path = path.as_str().filter(|path| relative_path(path) && path.ends_with(".rb")).ok_or("Invalid evidence Ruby source context")?;
            if !captured_context.insert(path) { return Err("Duplicate evidence Ruby source context file".into()); }
            if !validated.contains_key(path) { return Err("Evidence Ruby source context is missing or stale; recapture it".into()); }
        }
        let current_context: HashSet<_> = sources.iter().filter(|source| source.path.ends_with(".rb")).map(|source| source.path.as_str()).collect();
        if captured_context != current_context { return Err("Evidence Ruby source files changed; recapture it".into()); }
        let mut definitions=Vec::new();
        if version==2 {
            if !value.get("method_definitions").is_some_and(Value::is_array){return Err("Compact evidence needs a method_definitions array".into());}
            let mut targets=HashSet::new();
            for definition in array(&value,"method_definitions")? {
                let parsed=symbol(definition,&validated).filter(|symbol|symbol.name.rsplit_once('#').or_else(||symbol.name.rsplit_once('.')).is_some_and(|(owner,method)|constant(owner)&&method_name(method))).map(Arc::new);
                if let Some(target)=&parsed {if !targets.insert(Arc::clone(target)){return Err("Duplicate compact evidence method definition".into());}}
                else {result.warn("Skipped invalid or stale method definition".into());}
                definitions.push(parsed);
            }
        }
        let classes = array(&value, "classes")?;
        let mut names = HashMap::new();
        for class in classes {
            if let Some(name) = class.get("name").and_then(Value::as_str) { *names.entry(name).or_insert(0usize) += 1; }
        }
        for class in classes {
            let Some(parsed) = parse_class(class, &validated, version, &definitions) else { result.warn("Skipped invalid or stale loaded class".into()); continue };
            if names.get(parsed.name.as_str()) != Some(&1) { result.warn(format!("Conflicting loaded class: {}", parsed.name)); continue; }
            result.classes.push(parsed);
        }
        for call in array(&value, "calls")? {
            let Some(parsed) = parse_call(call, &validated) else { result.warn("Skipped invalid or stale observed call".into()); continue };
            result.calls.push(parsed);
        }
        Ok(result)
    }

    fn warn(&mut self, warning: String) {
        if self.warnings.len() < 32 {
            self.warnings.push(warning.chars().take(320).map(|c| if c.is_control() { ' ' } else { c }).collect());
        }
    }
}

fn array<'a>(value: &'a Value, key: &str) -> Result<&'a [Value], String> {
    let Some(value) = value.get(key) else { return Ok(&[]) };
    let values = value.as_array().ok_or_else(|| format!("Evidence {key} must be an array"))?;
    if values.len() > 200_000 { return Err(format!("Too many evidence {key}")); }
    Ok(values)
}

fn relative_path(path: &str) -> bool {
    !path.is_empty() && path.len() <= 4096 && !path.starts_with('/') && !path.contains('\\') && !path.chars().any(char::is_control)
        && path.split('/').all(|part| !part.is_empty() && part != "." && part != "..")
}

fn name(value: &Value, key: &str) -> Option<String> {
    let text = value.get(key)?.as_str()?;
    (!text.is_empty() && text.len() <= 512 && !text.chars().any(|c| c.is_control() || c.is_whitespace())).then(|| text.into())
}

fn constant(text: &str) -> bool {
    !text.is_empty() && text.split("::").all(|part| {
        let mut chars = part.chars();
        chars.next().is_some_and(char::is_uppercase) && chars.all(|c| c.is_alphanumeric() || c == '_')
    })
}

fn method_name(text: &str) -> bool {
    !text.is_empty() && text.len() <= 256 && !text.chars().any(|c| c.is_control() || c.is_whitespace() || matches!(c, '#' | '.' | ':'))
}

fn symbol_name(text: &str) -> bool {
    if text == "<module>" { return true; }
    match text.rsplit_once('#').or_else(|| text.rsplit_once('.')) {
        Some((owner, method)) => constant(owner) && method_name(method),
        None => method_name(text),
    }
}

fn location(value: &Value, files: &HashMap<&str, usize>) -> Option<(String, usize)> {
    let file = value.get("file")?.as_str()?;
    let line = usize::try_from(value.get("line")?.as_u64()?).ok()?;
    (line > 0 && line <= *files.get(file)?).then(|| (file.into(), line))
}

fn symbol(value: &Value, files: &HashMap<&str, usize>) -> Option<SymbolRef> {
    let name = name(value, "name").filter(|name| symbol_name(name))?;
    let (file, line) = location(value, files)?;
    Some(SymbolRef { name, file, line })
}

fn parse_class(value: &Value, files: &HashMap<&str, usize>, version:u64, definitions:&[Option<Arc<SymbolRef>>]) -> Option<LoadedClass> {
    let class_name = name(value, "name").filter(|name| constant(name))?;
    let (file, line) = location(value, files)?;
    let ancestors: Vec<String> = array(value, "ancestors").ok()?.iter().map(|v| v.as_str().filter(|s| constant(s)).map(str::to_owned)).collect::<Option<_>>()?;
    if ancestors.len() > 256 { return None; }
    let active_record = value.get("active_record").and_then(Value::as_bool).unwrap_or(false);
    if active_record && !ancestors.iter().any(|a| a == "ActiveRecord::Base") { return None; }
    let attributes = array(value, "attributes").ok()?.iter().map(|v| v.as_str().filter(|s| !s.is_empty() && s.len() <= 256 && s.chars().all(|c| c.is_alphanumeric() || c == '_')).map(str::to_owned)).collect::<Option<Vec<_>>>()?;
    let mut associations = Vec::new();
    let mut association_names = HashSet::new();
    for association in array(value, "associations").ok()? {
        let association_name = name(association, "name").filter(|name| method_name(name))?;
        if !association_names.insert(association_name.clone()) { return None; }
        let target = name(association, "target").filter(|target| constant(target))?;
        associations.push(LoadedAssociation { name: association_name, target, collection: association.get("collection")?.as_bool()? });
    }
    let mut methods = Vec::new();
    let mut method_names = HashSet::new();
    if version==2 {
        if value.get("methods").is_some() || !value.get("method_refs").is_some_and(Value::is_array){return None;}
        for reference in array(value,"method_refs").ok()? {
            let tuple=reference.as_array().filter(|tuple|tuple.len()==3)?;
            let method=tuple[0].as_str().filter(|method|method_name(method))?.to_owned();
            let singleton=tuple[1].as_bool()?;
            if !method_names.insert((singleton,method.clone())){return None;}
            let index=usize::try_from(tuple[2].as_u64()?).ok()?;
            let definition=Arc::clone(definitions.get(index)?.as_ref()?);
            methods.push(LoadedMethod{name:method,singleton,definition});
        }
    } else {
        if value.get("method_refs").is_some(){return None;}
    for method in array(value, "methods").ok()? {
        let method_name = name(method, "name").filter(|name| method_name(name))?;
        let owner = name(method, "owner").filter(|owner| constant(owner))?;
        let singleton = method.get("singleton")?.as_bool()?;
        if !method_names.insert((singleton, method_name.clone())) { return None; }
        let (file, line) = location(method, files)?;
        let definition_name = match method.get("definition_name") {
            Some(_) => name(method, "definition_name").filter(|name| symbol_name(name))?,
            None => format!("{owner}{}{method_name}", if singleton { "." } else { "#" }),
        };
        if !definition_name.starts_with(&format!("{owner}#")) && !definition_name.starts_with(&format!("{owner}.")) { return None; }
        methods.push(LoadedMethod { name: method_name, singleton, definition: Arc::new(SymbolRef { name: definition_name, file, line }) });
    }
    }
    Some(LoadedClass { name: class_name, file, line, active_record, attributes, associations, methods })
}

fn parse_call(value: &Value, files: &HashMap<&str, usize>) -> Option<ObservedCall> {
    let caller = symbol(value.get("caller")?, files)?;
    let callee = symbol(value.get("callee")?, files)?;
    let line = usize::try_from(value.get("line")?.as_u64()?).ok()?;
    if line == 0 || line > *files.get(caller.file.as_str())? { return None; }
    let method = name(value, "method").filter(|name| method_name(name))?;
    let count = value.get("count")?.as_u64()?;
    if count == 0 { return None; }
    Some(ObservedCall { caller, callee, line, method, count })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn compact_fixture() -> (Vec<SourceFile>, Value, Value) {
        let sources=vec![SourceFile{path:"a.rb".into(),text:"module Shared\n def run; end\nend\nclass A; end\nclass B; end\n".into()}];
        let target=serde_json::json!({"name":"Shared#run","file":"a.rb","line":2});
        let class=|name:&str,line:usize,methods:Value|serde_json::json!({"name":name,"file":"a.rb","line":line,"methods":methods});
        let method=|name:&str,singleton:bool|serde_json::json!({"name":name,"singleton":singleton,"owner":"Shared","definition_name":"Shared#run","file":"a.rb","line":2});
        let legacy=serde_json::json!({"version":1,"files":{"a.rb":fingerprint(&sources[0].text)},"context_files":["a.rb"],"classes":[class("A",4,serde_json::json!([method("run",false),method("again",false),method("run",true)])),class("B",5,serde_json::json!([method("run",false)]))]});
        let mut compact=legacy.clone();compact["version"]=serde_json::json!(2);compact["method_definitions"]=serde_json::json!([target]);
        for(class,refs)in compact["classes"].as_array_mut().unwrap().iter_mut().zip([serde_json::json!([["run",false,0],["again",false,0],["run",true,0]]),serde_json::json!([["run",false,0]])]){class.as_object_mut().unwrap().remove("methods");class["method_refs"]=refs;}
        (sources,legacy,compact)
    }

    #[test]
    fn compact_methods_preserve_legacy_alias_and_receiver_side_bindings() {
        let(sources,legacy,compact)=compact_fixture();
        let old=Snapshot::parse(&legacy.to_string(),&sources).unwrap();
        let new=Snapshot::parse(&compact.to_string(),&sources).unwrap();
        assert_eq!(old.classes.len(),new.classes.len());assert!(new.warnings.is_empty());
        for(a,b)in old.classes.iter().zip(&new.classes){
            assert_eq!(a.name,b.name);assert_eq!(a.methods.len(),b.methods.len());
            for(a,b)in a.methods.iter().zip(&b.methods){assert_eq!(a.name,b.name);assert_eq!(a.singleton,b.singleton);assert_eq!(a.definition,b.definition);}
        }
    }

    #[test]
    fn compact_references_share_definition_allocations_and_reject_ambiguous_tables() {
        let(sources,_,compact)=compact_fixture();let snapshot=Snapshot::parse(&compact.to_string(),&sources).unwrap();
        let first=&snapshot.classes[0].methods[0].definition;
        for class in &snapshot.classes{for method in &class.methods{assert!(Arc::ptr_eq(first,&method.definition));}}
        let mut unsupported=compact.clone();unsupported["version"]=serde_json::json!(3);assert!(Snapshot::parse(&unsupported.to_string(),&sources).unwrap_err().contains("Unsupported evidence version"));
        let mut duplicate=compact.clone();let target=duplicate["method_definitions"][0].clone();duplicate["method_definitions"].as_array_mut().unwrap().push(target);
        assert!(Snapshot::parse(&duplicate.to_string(),&sources).unwrap_err().contains("Duplicate"));
        for invalid in [serde_json::json!({"name":"run","file":"a.rb","line":2}),serde_json::json!({"name":"<module>","file":"a.rb","line":2}),serde_json::json!({"name":"Shared#run","file":"a.rb","line":99})]{
            let mut bad=compact.clone();bad["method_definitions"][0]=invalid;let snapshot=Snapshot::parse(&bad.to_string(),&sources).unwrap();assert!(snapshot.classes.is_empty());assert!(!snapshot.warnings.is_empty());
        }
        let mut mixed=compact.clone();mixed["classes"][0]["methods"]=serde_json::json!([]);let snapshot=Snapshot::parse(&mixed.to_string(),&sources).unwrap();assert_eq!(snapshot.classes.len(),1);assert_eq!(snapshot.classes[0].name,"B");
    }

    #[test]
    fn compact_and_legacy_snapshots_produce_identical_loaded_relationships() {
        use crate::relationships::Graph;
        let sources=vec![SourceFile{path:"extra.rb".into(),text:"module Extra; def run; end; alias another run; end".into()},SourceFile{path:"worker.rb".into(),text:"class Worker; extend Extra; end".into()},SourceFile{path:"entry.rb".into(),text:"class Entry; def self.perform; Worker.another; end; end".into()}];
        let files:serde_json::Map<String,Value>=sources.iter().map(|source|(source.path.clone(),serde_json::json!(fingerprint(&source.text)))).collect();
        let legacy=serde_json::json!({"version":1,"files":files,"context_files":["extra.rb","worker.rb","entry.rb"],"classes":[{"name":"Worker","file":"worker.rb","line":1,"methods":[{"name":"another","singleton":true,"owner":"Extra","definition_name":"Extra#run","file":"extra.rb","line":1}]}]});
        let mut compact=legacy.clone();compact["version"]=serde_json::json!(2);compact["method_definitions"]=serde_json::json!([{"name":"Extra#run","file":"extra.rb","line":1}]);compact["classes"][0].as_object_mut().unwrap().remove("methods");compact["classes"][0]["method_refs"]=serde_json::json!([["another",true,0]]);
        let old=Snapshot::parse(&legacy.to_string(),&sources).unwrap();let new=Snapshot::parse(&compact.to_string(),&sources).unwrap();
        let a=Graph::build_with_snapshot(&sources,None,Some(&old));let b=Graph::build_with_snapshot(&sources,None,Some(&new));
        assert_eq!(a.symbols,b.symbols);assert_eq!(a.edges,b.edges);assert_eq!(a.unresolved_sites,b.unresolved_sites);assert!(b.edges.iter().any(|edge|edge.evidence==EvidenceKind::Loaded && edge.callee.name=="Extra#run"));
    }

    #[test]
    fn compact_bad_references_never_retarget_independent_valid_classes() {
        let(sources,_,original)=compact_fixture();
        for bad in [serde_json::json!(["run",false,-1]),serde_json::json!(["run",false,1]),serde_json::json!(["run",false,1.5]),serde_json::json!(["run",false,"0"]),serde_json::json!(["run",0,0]),serde_json::json!(["bad name",false,0]),serde_json::json!(["run",false]),serde_json::json!(["run",false,0,"extra"])]{
            let mut value=original.clone();value["classes"][0]["method_refs"]=serde_json::json!([bad]);
            let snapshot=Snapshot::parse(&value.to_string(),&sources).unwrap();
            assert_eq!(snapshot.classes.len(),1,"{value}");assert_eq!(snapshot.classes[0].name,"B");assert_eq!(snapshot.classes[0].methods[0].definition.name,"Shared#run");assert!(!snapshot.warnings.is_empty());
        }
        for bad in [serde_json::json!([["run",false,0],["run",false,0]]),serde_json::json!({})]{
            let mut value=original.clone();value["classes"][0]["method_refs"]=bad;let snapshot=Snapshot::parse(&value.to_string(),&sources).unwrap();assert_eq!(snapshot.classes.len(),1);assert_eq!(snapshot.classes[0].name,"B");
        }
    }

    #[test]
    fn compact_invalid_definition_slots_cannot_shift_reference_indices() {
        let(sources,_,mut compact)=compact_fixture();let target=compact["method_definitions"][0].clone();
        compact["method_definitions"]=serde_json::json!([{"name":"Shared#bad","file":"../a.rb","line":2},target]);compact["classes"][1]["method_refs"]=serde_json::json!([["run",false,1]]);
        let snapshot=Snapshot::parse(&compact.to_string(),&sources).unwrap();assert_eq!(snapshot.classes.len(),1);assert_eq!(snapshot.classes[0].name,"B");assert_eq!(snapshot.classes[0].methods[0].definition.name,"Shared#run");
    }

    #[test]
    fn viewer_modes_select_the_same_evidence_kinds() {
        let kinds = [EvidenceKind::Source,EvidenceKind::Inferred,EvidenceKind::Loaded,EvidenceKind::Observed];
        let expected = [[true,true,true,true],[true,false,false,false],[true,true,false,false],[false,false,true,false],[false,false,false,true]];
        for (mode, expected) in expected.iter().enumerate() {
            let filter = EvidenceFilter::for_mode(mode);
            assert_eq!(kinds.map(|kind| filter.allows(kind)), *expected);
        }
    }

    #[test]
    fn fingerprints_match_the_export_protocol() {
        assert_eq!(fingerprint(""), "cbf29ce484222325");
        assert_eq!(fingerprint("hello"), "a430d84680aabd0b");
    }

    #[test]
    fn malformed_versions_stale_files_and_outside_paths_cannot_supply_evidence() {
        let sources = [SourceFile { path: "a.rb".into(), text: "class A; end".into() }];
        assert!(Snapshot::parse("{", &sources).is_err());
        assert!(Snapshot::parse(r#"{"version":2,"files":{}}"#, &sources).is_err());
        let text = serde_json::json!({"version":1,"context_files":["a.rb"],"files":{"a.rb":"wrong","../a.rb":fingerprint(&sources[0].text)},"classes":[{"name":"A","file":"a.rb","line":1}]});
        assert!(Snapshot::parse(&text.to_string(), &sources).is_err());
    }

    #[test]
    fn bad_locations_and_conflicting_classes_do_not_discard_independent_valid_calls() {
        let sources = [SourceFile { path: "a.rb".into(), text: "class A; def go; end; end".into() }];
        let class = serde_json::json!({"name":"A","file":"a.rb","line":1});
        let call = serde_json::json!({"caller":{"name":"A#go","file":"a.rb","line":1},"callee":{"name":"A#go","file":"a.rb","line":1},"line":1,"method":"go","count":1});
        let mut bad_line = call.clone(); bad_line["line"] = serde_json::json!(2);
        let mut bad_name = call.clone(); bad_name["callee"]["name"] = serde_json::json!("A#");
        let json = serde_json::json!({"version":1,"context_files":["a.rb"],"files":{"a.rb":fingerprint(&sources[0].text)},"classes":[class.clone(),class],"calls":[call,bad_line,bad_name]});
        let snapshot = Snapshot::parse(&json.to_string(), &sources).unwrap();
        assert_eq!(snapshot.calls.len(), 1);
        assert!(snapshot.classes.is_empty());
        assert!(!snapshot.warnings.is_empty());
    }

    #[test]
    fn collector_incompleteness_warnings_survive_import_with_bounded_safe_text() {
        let warnings: Vec<_> = (0..40).map(|_| format!("Trace event limit reached\n{}", "x".repeat(1000))).collect();
        let json = serde_json::json!({"version":1,"context_files":[],"files":{},"warnings":warnings});
        let snapshot = Snapshot::parse(&json.to_string(), &[]).unwrap();
        assert!(snapshot.warnings[0].starts_with("Capture warning: Trace event limit reached"));
        assert!(snapshot.warnings.len() <= 32);
        assert!(snapshot.warnings.iter().all(|warning| warning.chars().count() <= 320 && !warning.chars().any(char::is_control)));
    }

    #[test]
    fn context_changes_and_missing_context_reject_the_entire_capture() {
        let sources = [SourceFile { path: "a.rb".into(), text: "class A; end".into() }, SourceFile { path: "configure.rb".into(), text: "A.include M".into() }];
        let mut json = serde_json::json!({"version":1,"files":{"a.rb":fingerprint(&sources[0].text),"configure.rb":fingerprint(&sources[1].text)},"context_files":["a.rb","configure.rb"]});
        assert!(Snapshot::parse(&json.to_string(), &sources).is_ok());
        let changed = [sources[0].clone(), SourceFile { path: "configure.rb".into(), text: "# removed include".into() }];
        assert!(Snapshot::parse(&json.to_string(), &changed).is_err());
        assert!(Snapshot::parse(&json.to_string(), &sources[..1]).is_err());
        let mut added = sources.to_vec(); added.push(SourceFile { path: "another.rb".into(), text: "class A; end".into() });
        assert!(Snapshot::parse(&json.to_string(), &added).is_err());
        json.as_object_mut().unwrap().remove("context_files");
        assert!(Snapshot::parse(&json.to_string(), &sources).is_err());
    }
}
