use crate::{call_colors::{self, CallHighlights}, evidence::EvidenceFilter, filter::Filter, model::{self, Kind, R, Tree}, palette, relationships::{self, CallEdge, Direction, Graph, SymbolRef}, scan::{self, Entry, EntryKind}, source_cache::SourceCache, syntax::HighlightedText};
use serde_json::{json, Value};
use std::{collections::{BTreeMap, BTreeSet, HashMap, HashSet}, fs, io::Read, path::{Component, Path, PathBuf}, sync::Arc, time::Instant};

const MAX_FILE: usize = 8 * 1024 * 1024;
const MAX_PREVIEW: usize = 2 * 1024 * 1024;
const MAX_MANIFEST: u64 = 64 * 1024 * 1024;
const MAX_FILES: usize = 100_000;
const MAX_HUNK_LINES: usize = 400;
const MAX_RELATIONSHIPS: usize = 2000;

struct SnapshotFile { bytes: u64, text: Option<Arc<String>>, omitted: Option<String> }
struct Side { files: BTreeMap<String, SnapshotFile>, graph: Graph, cache: SourceCache }
#[derive(Clone)]
struct Hunk { old_start: usize, old_count: usize, new_start: usize, new_count: usize }
struct Change { status: String, old: Option<String>, new: Option<String>, hunks: Vec<Hunk> }
struct File { path: String, old: Option<String>, new: Option<String>, status: String, node: usize, before_lines: usize, after_lines: usize, change: Option<usize> }
struct Seed { id: String, name: String, file: String, before: Vec<usize>, after: Vec<usize>, kind: &'static str, change: &'static str }
#[derive(Clone, PartialEq)]
struct Options { side: bool, scope: String, seed: Option<String>, depth: usize, filter: String, hide_tests: bool, search: String, evidence: String }
impl Default for Options {
    fn default() -> Self { Self { side:true, scope:"all".into(), seed:None, depth:1, filter:String::new(), hide_tests:false, search:String::new(), evidence:"all".into() } }
}
impl Options {
    fn parse(value: Option<&Value>) -> Result<Self,String> {
        let mut out=Self::default(); let Some(v)=value else {return Ok(out)};
        if !v.is_object() { return Err("options must be an object".into()); }
        if let Some(side)=v.get("prSide") { out.side=match side.as_str() {Some("before")=>false,Some("after")=>true,_=>return Err("invalid PR side".into())}; }
        for (key,dest) in [("prScope",&mut out.scope),("filter",&mut out.filter),("search",&mut out.search),("evidence",&mut out.evidence)] {if let Some(v)=v.get(key) {*dest=v.as_str().ok_or_else(||format!("{key} must be a string"))?.into();}}
        if !matches!(out.scope.as_str(),"all"|"changed"|"impact") {return Err("invalid PR scope".into());}
        if !matches!(out.evidence.as_str(),"all"|"source"|"static"|"loaded"|"observed") {return Err("invalid evidence mode".into());}
        if let Some(v)=v.get("hideTests") {out.hide_tests=v.as_bool().ok_or("hideTests must be a boolean")?;}
        if let Some(v)=v.get("depth") {out.depth=v.as_u64().filter(|n|(1..=relationships::MAX_DEPTH as u64).contains(n)).ok_or_else(||format!("depth must be between 1 and {}",relationships::MAX_DEPTH))? as usize;}
        if let Some(v)=v.get("prSeed").filter(|v|!v.is_null()) {out.seed=Some(v.as_str().ok_or("prSeed must be a seed ID")?.into());}
        Ok(out)
    }
    fn evidence_filter(&self)->EvidenceFilter {EvidenceFilter::for_mode(match self.evidence.as_str(){"source"=>1,"static"=>2,"loaded"=>3,"observed"=>4,_=>0})}
    fn json(&self)->Value {json!({"prSide":if self.side{"after"}else{"before"},"prScope":self.scope,"prSeed":self.seed,"depth":self.depth,"filter":self.filter,"hideTests":self.hide_tests,"search":self.search,"evidence":self.evidence})}
}

struct Projection { witnesses: HashMap<String,(bool,Vec<CallEdge>)>, changed: HashSet<String>, visible: HashSet<String> }

pub struct ComparisonProject {
    tree: Tree, geometry: Vec<(R,u32,f64)>, before: Side, after: Side, files: Vec<File>, changes: Vec<Change>,
    before_paths: HashMap<String,String>, after_paths: HashMap<String,String>, seeds: Vec<Seed>, pr: Value,
    warnings: Vec<String>, options: Options, projected_options: Option<Options>, filter: Filter, revision: u64, relationships: Value, highlights: CallHighlights,
}

impl ComparisonProject {
    pub fn new(manifest: &Path, expected_head: &Path) -> Result<Self,String> {
        Self::new_with_progress(manifest, expected_head, |_| {})
    }
    pub fn new_with_progress(manifest: &Path, expected_head: &Path, mut progress: impl FnMut(Value)) -> Result<Self,String> {
        let started=Instant::now();
        let mut report=|phase:&str,message:&str,completed:usize,total:usize|progress(json!({"phase":phase,"message":message,"completed":completed,"total":total,"elapsedMs":started.elapsed().as_millis() as u64}));
        report("manifest","Validating comparison manifest",0,1);
        let parent=manifest.parent().ok_or("comparison manifest needs a parent directory")?.canonicalize().map_err(|_|"comparison directory is unavailable")?;
        let input=read_regular(manifest,MAX_MANIFEST as usize)?;
        let v:Value=serde_json::from_slice(&input).map_err(|_|"comparison manifest must be valid JSON")?;
        if v.get("version").and_then(Value::as_u64)!=Some(1) {return Err("unsupported comparison manifest version".into());}
        let root=|key:&str|->Result<PathBuf,String>{let p=PathBuf::from(string(&v,key)?);if fs::symlink_metadata(&p).map_err(|_|"comparison root is unavailable")?.file_type().is_symlink(){return Err("comparison roots cannot be symlinks".into())}let p=p.canonicalize().map_err(|_|"comparison root is unavailable")?;if !p.is_dir() || !p.starts_with(&parent) || p==parent {return Err("comparison roots must be inside the owned comparison directory".into())}Ok(p)};
        let base_root=root("baseRoot")?;let head_root=root("headRoot")?;
        if base_root==head_root || head_root!=expected_head.canonicalize().map_err(|_|"comparison head is unavailable")? {return Err("comparison root does not match the worker root".into());}
        let mut warnings:Vec<String>=v.get("warnings").and_then(Value::as_array).ok_or("comparison warnings must be an array")?.iter().map(|s|s.as_str().map(str::to_owned).ok_or_else(||"comparison warning must be text".to_string())).collect::<Result<_,_>>()?;
        report("manifest","Validated comparison manifest",1,1);
        let mut before=Side::load(&base_root,v.get("baseFiles").ok_or("baseFiles is required")?,&mut warnings,"before",None,&mut report)?;
        let mut after=Side::load(&head_root,v.get("headFiles").ok_or("headFiles is required")?,&mut warnings,"after",Some(&before),&mut report)?;
        let (old_graph,new_graph,stats)=Graph::build_pair(&before.sources(),&after.sources(),before.base_url().as_deref(),after.base_url().as_deref(),&mut |phase,completed,total|{
            let message=if phase=="parse"{"Parsing both revisions (sharing unchanged files)".to_owned()}else{format!("Building {} revision: {}",if phase.starts_with("before-"){"before"}else{"after"},phase.rsplit('-').next().unwrap_or(phase))};
            report(phase,&message,completed,total);
        });
        report("parse-summary",&format!("Parsed {} source files; reused {} unchanged parses",stats.parsed_files,stats.reused_files),stats.parsed_files,stats.parsed_files);
        before.graph=old_graph;after.graph=new_graph;
        report("comparison","Building stable comparison map",0,1);
        let pr=v.get("pr").filter(|v|v.is_object()).ok_or("PR metadata is required")?.clone();
        if pr.get("number").and_then(Value::as_u64).filter(|n|*n>0).is_none(){return Err("PR number must be positive".into())}
        for key in ["title","url","baseSha","headSha","mergeBaseSha"] {string(&pr,key)?;}
        let mut changes=Vec::new();let mut claimed_old=HashSet::new();let mut claimed_new=HashSet::new();
        for c in v.get("changes").and_then(Value::as_array).ok_or("changes must be an array")? {
            let status=string(c,"status")?.to_owned();if !matches!(status.as_str(),"added"|"modified"|"deleted"|"renamed"|"type") {return Err("invalid file change status".into())}
            let old=optional_path(c,"oldPath")?;let new=optional_path(c,"newPath")?;
            if old.is_none() && new.is_none(){return Err("file change has no path".into())}
            if status=="added" && (old.is_some()||new.is_none()) || status=="deleted" && (new.is_some()||old.is_none()) || matches!(status.as_str(),"modified"|"renamed"|"type") && (old.is_none()||new.is_none()){return Err("file change status does not match its paths".into())}
            if let Some(p)=&old {if !before.files.contains_key(p)||!claimed_old.insert(p.clone()){return Err("duplicate or unknown before path in changes".into())}}
            if let Some(p)=&new {if !after.files.contains_key(p)||!claimed_new.insert(p.clone()){return Err("duplicate or unknown after path in changes".into())}}
            let mut hunks=Vec::new();
            for h in c.get("hunks").and_then(Value::as_array).ok_or("hunks must be an array")? {
                let parse=|key:&str|h.get(key).and_then(Value::as_u64).and_then(|n|usize::try_from(n).ok()).ok_or_else(||format!("invalid hunk {key}"));
                let h=Hunk{old_start:parse("oldStart")?,old_count:parse("oldCount")?,new_start:parse("newStart")?,new_count:parse("newCount")?};
                for (start,count,side,path) in [(h.old_start,h.old_count,&before,&old),(h.new_start,h.new_count,&after,&new)] {
                    if count>0 {let file=path.as_ref().and_then(|p|side.files.get(p)).ok_or("hunk refers to an absent file")?;
                        if start==0 || start.checked_add(count).is_none() || file.text.as_ref().is_some_and(|text|start+count-1>line_count(text)){return Err("hunk range is outside snapshot source".into())}
                    }
                }
                hunks.push(h);
            }
            changes.push(Change{status,old,new,hunks});
        }
        let mut files=Vec::new();let mut used=HashSet::new();
        for (i,c) in changes.iter().enumerate(){let path=c.new.as_ref().or(c.old.as_ref()).unwrap().clone();files.push(File{path,old:c.old.clone(),new:c.new.clone(),status:c.status.clone(),node:0,before_lines:0,after_lines:0,change:Some(i)});}
        for path in before.files.keys().chain(after.files.keys()) {
            if claimed_old.contains(path)||claimed_new.contains(path)||!used.insert(path.clone()){continue}
            let old=before.files.contains_key(path).then(||path.clone());let new=after.files.contains_key(path).then(||path.clone());
            if old.is_none()||new.is_none(){return Err("snapshot inventory changes are missing from the diff".into())}
            files.push(File{path:path.clone(),old,new,status:"unchanged".into(),node:0,before_lines:0,after_lines:0,change:None});
        }
        files.sort_by(|a,b|a.path.cmp(&b.path).then_with(||b.new.is_some().cmp(&a.new.is_some())));
        let original_paths:BTreeSet<_>=files.iter().map(|f|f.path.clone()).collect();let mut logical=HashSet::new();
        for f in &mut files {
            let prefix=f.path.clone()+"/";
            if original_paths.range(prefix.clone()..).next().is_some_and(|p|p.starts_with(&prefix)) || !logical.insert(f.path.clone()) {
                let original=f.path.clone();let mut index=0;
                loop {let candidate=format!("{original}/[snapshot file {index}]");if !original_paths.contains(&candidate)&&logical.insert(candidate.clone()){f.path=candidate;break}index+=1;}
                warnings.push(format!("Path changed between a file and folder or replaced a renamed file: {original}; its snapshot file has a labeled separate box"));
            }
            f.before_lines=f.old.as_ref().and_then(|p|before.files.get(p)).and_then(|f|f.text.as_ref()).map_or(0,|s|line_count(s));
            f.after_lines=f.new.as_ref().and_then(|p|after.files.get(p)).and_then(|f|f.text.as_ref()).map_or(0,|s|line_count(s));
        }
        files.sort_by(|a,b|a.path.cmp(&b.path));
        let before_paths=files.iter().filter_map(|f|f.old.as_ref().map(|p|(p.clone(),f.path.clone()))).collect();
        let after_paths=files.iter().filter_map(|f|f.new.as_ref().map(|p|(p.clone(),f.path.clone()))).collect();
        let mut tree=Tree::new("PR comparison");
        for f in &files {
            let old=f.old.as_ref().and_then(|p|before.files.get(p));let new=f.new.as_ref().and_then(|p|after.files.get(p));
            let bytes=old.map_or(0,|f|f.bytes).max(new.map_or(0,|f|f.bytes));
            let text=if f.before_lines>f.after_lines {old.and_then(|f|f.text.as_ref())}else{new.and_then(|f|f.text.as_ref()).or_else(||old.and_then(|f|f.text.as_ref()))};
            let kind=match text {Some(text)=>EntryKind::Text{bytes,lines:summarize(text)},None=>EntryKind::Binary{bytes}};
            tree.insert(Entry{path:f.path.clone(),kind,ignored:false});
        }
        tree.update_weights(false);tree.layout(R{x:0.0,y:0.0,w:1000.0,h:700.0});
        let geometry=tree.nodes.iter().map(|n|(n.rect,n.cols,n.line_h)).collect();
        for f in &mut files {f.node=tree.find(&f.path).unwrap();}
        let seeds=make_seeds(&before,&after,&files,&changes,&mut warnings);
        let skipped_before=before.graph.edges.len()-comparable_edges(&before.graph).len();
        let skipped_after=after.graph.edges.len()-comparable_edges(&after.graph).len();
        if skipped_before>0||skipped_after>0 {warnings.push(format!("Relationship delta excludes {skipped_before} before and {skipped_after} after call sites with anonymous/location-based or duplicate symbol identities; they remain in the side's impact graph"));}
        if before.graph.parse_errors>0||after.graph.parse_errors>0 {warnings.push("Files with parse errors have no method graph; their edits remain visible but impact coverage is incomplete".into());}
        warnings.push("Potential impact follows source-resolved and labeled inferred calls; dynamic dispatch, framework scheduling and unexercised runtime behavior may be missing".into());
        if warnings.len()>200 {let omitted=warnings.len()-200;warnings.truncate(200);warnings.push(format!("{omitted} additional coverage warnings omitted"));}
        let mut project=Self{tree,geometry,before,after,files,changes,before_paths,after_paths,seeds,pr,warnings,options:Options::default(),projected_options:None,filter:Filter::default(),revision:0,relationships:Value::Null,highlights:CallHighlights::default()};
        report("comparison","Building stable comparison map",1,1);
        report("relationship-delta","Comparing method relationships",0,1);
        project.relationships=project.relationship_delta();
        report("relationship-delta","Compared method relationships",1,1);
        Ok(project)
    }
    pub fn request(&mut self,request:&Value)->Value {let id=request.get("id").cloned().unwrap_or(Value::Null);match self.execute(request){Ok(result)=>json!({"id":id,"result":result}),Err(error)=>json!({"id":id,"error":error})}}
    fn execute(&mut self,request:&Value)->Result<Value,String>{
        match request.get("op").and_then(Value::as_str) {
            Some("ready")=>Ok(json!({"ready":true})),
            Some("view")=>{let mut options=Options::parse(request.get("options"))?;
                self.validate_options(&options)?;
                if let Some(previous)=request.get("previousOptions"){self.restore_context(previous)?;}
                let notice=match Filter::parse(&options.filter){Ok(filter)=>{self.filter=filter;None},Err(error)=>{options.filter=self.options.filter.clone();Some(format!("Invalid filter: {error}. Keeping previous valid filter"))}};
                self.options=options;self.view(notice)
            },
            Some("source")=>{let node=request.get("node").and_then(Value::as_u64).and_then(|n|usize::try_from(n).ok()).ok_or("node must be an indexed numeric ID")?;let syntax=request.get("syntax").map(|v|v.as_bool().ok_or("syntax must be boolean")).transpose()?.unwrap_or(true);
                if let Some(context)=request.get("contextOptions"){self.restore_context(context)?;if self.projected_options.as_ref()!=Some(&self.options){self.prepare_projection();}}
                self.source(node,syntax)},
            Some("capture"|"evidence"|"expand")=>Err("PR revisions are immutable; app evidence, capture and ignored expansion are unavailable in PR mode".into()),
            _=>Err("unknown operation".into()),
        }
    }
    fn validate_options(&self,options:&Options)->Result<(),String>{if options.seed.as_ref().is_some_and(|s|!self.seeds.iter().any(|seed|&seed.id==s)){Err("unknown changed method ID".into())}else{Ok(())}}
    fn restore_context(&mut self,value:&Value)->Result<(),String>{let options=Options::parse(Some(value))?;self.validate_options(&options)?;let filter=Filter::parse(&options.filter).map_err(|error|format!("invalid context filter: {error}"))?;self.options=options;self.filter=filter;Ok(())}
    fn roots(&self,after:bool)->Vec<usize>{self.seeds.iter().filter(|s|self.options.seed.as_ref().is_none_or(|id|&s.id==id)).flat_map(|s|if after {s.after.clone()} else{s.before.clone()}).collect()}
    fn paths(&self,after:bool)->&HashMap<String,String>{if after {&self.after_paths}else{&self.before_paths}}
    fn side(&self,after:bool)->&Side {if after {&self.after}else{&self.before}}
    fn canonical(&self,path:&str,after:bool)->String {self.paths(after).get(path).cloned().unwrap_or_else(||path.into())}
    fn edge(&self,edge:&CallEdge,after:bool)->Value {
        let symbol=|s:&SymbolRef|{let path=self.canonical(&s.file,after);json!({"name":s.name,"file":path,"line":s.line,"node":self.tree.find(&path)})};
        json!({"caller":symbol(&edge.caller),"callee":symbol(&edge.callee),"line":edge.line,"evidence":edge.evidence.label(),"reason":edge.inference,"side":if after{"after"}else{"before"}})
    }
    fn edge_key(&self,edge:&CallEdge,after:bool)->String {json!([self.canonical(&edge.caller.file,after),edge.caller.name,self.canonical(&edge.callee.file,after),edge.callee.name]).to_string()}
    fn relationship_delta(&self)->Value {
        let before_edges=comparable_edges(&self.before.graph);let after_edges=comparable_edges(&self.after.graph);
        let before:BTreeMap<_,_>=before_edges.iter().map(|&e|(self.edge_key(e,false),e)).collect();
        let after:BTreeMap<_,_>=after_edges.iter().map(|&e|(self.edge_key(e,true),e)).collect();
        let added:Vec<_>=after.iter().filter(|(key,_)|!before.contains_key(*key)).map(|(_,e)|*e).collect();
        let removed:Vec<_>=before.iter().filter(|(key,_)|!after.contains_key(*key)).map(|(_,e)|*e).collect();
        json!({"addedCount":added.len(),"removedCount":removed.len(),"uncomparedBeforeCount":self.before.graph.edges.len()-before_edges.len(),"uncomparedAfterCount":self.after.graph.edges.len()-after_edges.len(),"added":added.iter().take(MAX_RELATIONSHIPS).map(|e|self.edge(e,true)).collect::<Vec<_>>(),"removed":removed.iter().take(MAX_RELATIONSHIPS).map(|e|self.edge(e,false)).collect::<Vec<_>>()})
    }
    fn prepare_projection(&mut self)->Projection{
        let filter=self.options.evidence_filter();
        let before=self.before.graph.related_symbols(&self.roots(false),Direction::Callers,self.options.depth,filter);
        let after=self.after.graph.related_symbols(&self.roots(true),Direction::Callers,self.options.depth,filter);
        let mut witnesses:HashMap<String,(bool,Vec<CallEdge>)>=HashMap::new();
        for (side,reached) in [(false,&before),(true,&after)] {for (path,chain) in &reached.witnesses {let logical=self.canonical(path,side);let replace=witnesses.get(&logical).is_none_or(|(old_side,old)|chain.len()<old.len()||(chain.len()==old.len()&&side==self.options.side&&*old_side!=side));if replace{witnesses.insert(logical,(side,chain.clone()));}}}
        let changed:HashSet<_>=self.files.iter().filter(|f|f.status!="unchanged").map(|f|f.path.clone()).collect();
        let allowed:HashSet<String>=self.files.iter().filter(|f|match self.options.scope.as_str(){"changed"=>changed.contains(&f.path),"impact"=>changed.contains(&f.path)||witnesses.contains_key(&f.path),_=>true}).map(|f|f.path.clone()).collect();
        self.tree.update_weights(false);self.tree.apply_filter(&self.filter,self.options.hide_tests,Some(&allowed));self.tree.search(&self.options.search);
        for (node,(rect,cols,line_h)) in self.tree.nodes.iter_mut().zip(&self.geometry){node.rect=*rect;node.cols=*cols;node.line_h=*line_h;}
        let visible:HashSet<_>=self.tree.nodes.iter().enumerate().filter(|(i,n)|n.is_file()&&self.tree.is_visible(*i)).map(|(_,n)|n.path.clone()).collect();
        let edges:Vec<_>=self.side(self.options.side).graph.edges.iter().filter(|e|filter.allows(e.evidence)).map(|e|self.canonical_edge(e,self.options.side)).collect();
        self.highlights=CallHighlights::new(&edges,&visible);
        self.projected_options=Some(self.options.clone());
        Projection{witnesses,changed,visible}
    }
    fn view(&mut self,notice:Option<String>)->Result<Value,String>{
        let Projection{witnesses,changed,visible}=self.prepare_projection();
        let files:Vec<_>=self.files.iter().map(|f|{
            let hit=witnesses.get(&f.path);json!({"node":f.node,"status":f.status,"oldPath":f.old,"newPath":f.new,"beforeLines":f.before_lines,"afterLines":f.after_lines,"impact":if changed.contains(&f.path){"changed"}else if hit.is_some(){"caller"}else{"none"},"distance":if changed.contains(&f.path){Some(0)}else{hit.map(|(_,chain)|chain.len())},"witness":hit.map_or(Vec::new(),|(side,chain)|chain.iter().map(|e|self.edge(e,*side)).collect())})
        }).collect();
        let nodes:Vec<_>=self.tree.nodes.iter().enumerate().map(|(id,n)|{
            let kind=match n.kind{Kind::Dir=>"dir",Kind::Text=>"text",_=>"binary"};let color=if n.is_file(){call_colors::file_rgb(&n.path,None)}else{palette::file_type_color(&n.name,false)};
            json!({"id":id,"parent":n.parent,"children":n.children,"name":n.name,"path":n.path,"kind":kind,"ignored":false,"visible":self.tree.is_visible(id),"rect":rect(n.rect),"inner":rect(model::code_inner(n.rect)),"cols":n.cols,"lineHeight":n.line_h,"lineCount":n.lines.len(),"totalLines":n.total_lines,"totalFiles":n.total_files,"bytes":n.bytes,"commits":0,"lastChange":0,"color":color,"lit":n.lit,"onPath":n.on_path})
        }).collect();
        let seed_json:Vec<_>=self.seeds.iter().map(|s|json!({"id":s.id,"name":s.name,"file":s.file,"beforeLine":s.before.first().map(|id|self.before.graph.symbols[*id].line),"afterLine":s.after.first().map(|id|self.after.graph.symbols[*id].line),"kind":s.kind,"change":s.change})).collect();
        let diagnostics=|g:&Graph|json!({"analyzedFiles":g.analyzed_files,"parseErrors":g.parse_errors,"unresolvedSites":g.unresolved_sites});
        let mut pr=self.pr.clone();let p=pr.as_object_mut().unwrap();
        p.extend(json!({"side":if self.options.side{"after"}else{"before"},"scope":self.options.scope,"seed":self.options.seed,"seeds":seed_json,"files":files,"relationships":self.relationships,"counts":{"changedFiles":changed.iter().filter(|p|visible.contains(*p)).count(),"changedMethods":self.seeds.iter().filter(|s|s.kind=="method"&&visible.contains(&s.file)).count(),"directCallers":witnesses.iter().filter(|(p,(_,chain))|!changed.contains(*p)&&visible.contains(*p)&&chain.len()==1).count(),"indirectCallers":witnesses.iter().filter(|(p,(_,chain))|!changed.contains(*p)&&visible.contains(*p)&&chain.len()>1).count()},"diagnostics":{"before":diagnostics(&self.before.graph),"after":diagnostics(&self.after.graph)},"warnings":self.warnings}).as_object().unwrap().clone());
        self.revision=self.revision.wrapping_add(1);let root=&self.tree.nodes[0];
        Ok(json!({"revision":self.revision,"root":"PR comparison","nodes":nodes,"contextOptions":self.options.json(),"geometry":{"columnChars":model::COL_CHARS,"charWidth":model::CHAR_W},"status":notice.unwrap_or_else(||format!("PR #{} · potential caller impact · immutable {} revision",self.pr["number"],if self.options.side{"after"}else{"before"})),"evidenceStatus":"Source analysis and labeled inferences; no app code executed","counts":{"files":root.total_files,"lines":root.total_lines,"nodes":self.tree.nodes.iter().enumerate().filter(|(id,_)|self.tree.is_visible(*id)).count()},"trace":{"root":null},"capabilities":{"capture":false,"maxDepth":relationships::MAX_DEPTH},"pr":pr}))
    }
    fn source(&mut self,node:usize,syntax:bool)->Result<Value,String>{
        let file=self.files.iter().find(|f|f.node==node).ok_or("source requires a comparison file ID")?;
        let side_flag=self.options.side;let side=self.side(side_flag);let path=if side_flag{&file.new}else{&file.old};
        let record=path.as_ref().and_then(|p|side.files.get(p));
        let text=record.and_then(|f|f.text.clone());
        let message=if path.is_none(){Some(format!("This file is absent in the {} revision; switch to {} to inspect it",if side_flag{"after"}else{"before"},if side_flag{"before"}else{"after"}))}else if let Some(reason)=record.and_then(|r|r.omitted.as_ref()){Some(format!("Source unavailable: {reason}"))}else if text.is_none(){Some("Binary or unsupported UTF-8 source has no preview".into())}else if text.as_ref().is_some_and(|s|s.len()>MAX_PREVIEW){Some("Source exceeds the 2 MiB preview limit".into())}else{None};
        let mut changed_lines=Vec::new();let mut hunk_json=Vec::new();let mut diff_truncated=false;let mut total_hunk_lines=0;
        if let Some(change)=file.change.map(|i|&self.changes[i]) {
            let old=change.old.as_ref().and_then(|p|self.before.files.get(p)).and_then(|f|f.text.as_ref());let new=change.new.as_ref().and_then(|p|self.after.files.get(p)).and_then(|f|f.text.as_ref());
            let old_lines=old.map(|s|s.lines().collect::<Vec<_>>()).unwrap_or_default();let new_lines=new.map(|s|s.lines().collect::<Vec<_>>()).unwrap_or_default();
            for h in &change.hunks {
                let (start,count)=if side_flag{(h.new_start,h.new_count)}else{(h.old_start,h.old_count)};
                if text.as_ref().is_some_and(|s|s.len()<=MAX_PREVIEW){changed_lines.extend(start..start+count);}
                if total_hunk_lines>=MAX_HUNK_LINES{diff_truncated=true;hunk_json.push(json!({"oldStart":h.old_start,"oldCount":h.old_count,"newStart":h.new_start,"newCount":h.new_count,"oldLines":[],"newLines":[]}));continue}
                let remaining=MAX_HUNK_LINES-total_hunk_lines;
                let old_excerpt=excerpt(&old_lines,h.old_start,h.old_count,remaining);total_hunk_lines+=old_excerpt.len();
                let remaining=MAX_HUNK_LINES-total_hunk_lines;let new_excerpt=excerpt(&new_lines,h.new_start,h.new_count,remaining);total_hunk_lines+=new_excerpt.len();
                diff_truncated|=old_excerpt.len()<h.old_count||new_excerpt.len()<h.new_count;
                hunk_json.push(json!({"oldStart":h.old_start,"oldCount":h.old_count,"newStart":h.new_start,"newCount":h.new_count,"oldLines":old_excerpt,"newLines":new_excerpt}));
            }
        }
        let pr=json!({"side":if side_flag{"after"}else{"before"},"path":path,"status":file.status,"changedLines":changed_lines,"hunks":hunk_json,"message":if diff_truncated{Some("Diff excerpt is truncated; full changed-line counts remain in each hunk")}else{None}});
        let logical=file.path.clone();
        if let Some(message)=message{return Ok(json!({"node":node,"path":logical,"lines":[],"strips":[],"message":message,"pr":pr}))}
        let text=text.unwrap();
        let highlights=&self.highlights;
        let side=if side_flag{&mut self.after}else{&mut self.before};
        if !side.cache.files.contains_key(&node){side.cache.accept(side.cache.generation,node,HighlightedText::new(path.as_deref().unwrap_or(&logical),&text));}
        let lines:Vec<_>=side.cache.files[&node].lines.iter().enumerate().map(|(index,line)|{
            let marks=highlights.line(&logical,index+1);let columns=line.text.chars().count();
            let runs:Vec<_>=call_colors::paint_line(line,marks,None,syntax,columns).into_iter().map(|r|json!({"text":r.text,"color":r.color})).collect();
            let links:Vec<_>=call_colors::link_ranges(marks,columns).into_iter().filter_map(|link|{let target=self.tree.find(&link.definition.file).filter(|id|self.tree.is_visible(*id))?;Some(json!({"start":link.start,"end":link.end,"definition":{"node":target,"name":link.definition.name,"file":link.definition.file,"line":link.definition.line},"reason":link.inference,"evidence":link.evidence.label()}))}).collect();
            json!({"text":line.text,"runs":runs,"links":links})
        }).collect();
        let strips:Vec<_>=summarize(&text).into_iter().map(|l|json!([l.indent,l.len,l.comment])).collect();
        Ok(json!({"node":node,"path":logical,"lines":lines,"strips":strips,"message":null,"pr":pr}))
    }
    fn canonical_edge(&self,edge:&CallEdge,after:bool)->CallEdge {let mut edge=edge.clone();edge.caller.file=self.canonical(&edge.caller.file,after);edge.callee.file=self.canonical(&edge.callee.file,after);edge}
}

impl Side {
    fn load(root:&Path,files:&Value,warnings:&mut Vec<String>,label:&str,previous:Option<&Side>,progress:&mut impl FnMut(&str,&str,usize,usize))->Result<Self,String>{
        let files=files.as_array().filter(|files|files.len()<=MAX_FILES).ok_or("invalid or excessive snapshot inventory")?;let mut records:BTreeMap<String,SnapshotFile>=BTreeMap::new();let mut total=0usize;
        let scan_phase=format!("{label}-scan");let scan_message=format!("Reading {label} revision files");
        progress(&scan_phase,&scan_message,0,files.len());
        for (index,f) in files.iter().enumerate() {
            if index>0&&index%100==0{progress(&scan_phase,&scan_message,index,files.len());}
            let path=string(f,"path")?;validate_path(path)?;if records.contains_key(path){return Err("duplicate snapshot path".into())}
            let bytes=f.get("bytes").and_then(Value::as_u64).ok_or("snapshot file size must be non-negative")?;
            let omitted=match f.get("omitted"){Some(Value::Null)|None=>None,Some(Value::String(s))=>Some(s.clone()),_=>return Err("omission reason must be text or null".into())};
            let text=if omitted.is_some(){warnings.push(format!("{label} {path}: {}",omitted.as_deref().unwrap()));None}else{
                if bytes>MAX_FILE as u64{return Err("unmarked snapshot file exceeds 8 MiB".into())}
                let mut full=root.to_path_buf();for part in Path::new(path).components(){full.push(part);let meta=fs::symlink_metadata(&full).map_err(|_|"snapshot source is unavailable")?;if meta.file_type().is_symlink(){return Err("snapshot symlink reads are forbidden".into())}}
                let data=read_regular(&full,MAX_FILE)?;if data.len() as u64!=bytes{return Err("snapshot source size does not match its manifest".into())}
                total=total.checked_add(data.len()).filter(|n|*n<=512*1024*1024).ok_or("snapshot text exceeds 512 MiB")?;
                if data.contains(&0){None}else{String::from_utf8(data).ok().map(|text|{
                    if let Some(existing)=previous.and_then(|side|side.files.get(path)).and_then(|file|file.text.as_ref()).filter(|old|old.as_str()==text.as_str()){Arc::clone(existing)}else{Arc::new(text)}
                })}
            };
            records.insert(path.into(),SnapshotFile{bytes,text,omitted});
        }
        progress(&scan_phase,&scan_message,files.len(),files.len());
        Ok(Self{files:records,graph:Graph::default(),cache:SourceCache::default()})
    }
    fn sources(&self)->Vec<(&str,&str)>{self.files.iter().filter(|(p,_)|relationships::supports_path(p)).filter_map(|(path,f)|f.text.as_ref().map(|text|(path.as_str(),text.as_str()))).collect()}
    fn base_url(&self)->Option<String>{self.files.get("tsconfig.json").and_then(|f|f.text.as_ref()).and_then(|s|serde_json::from_str::<Value>(s).ok()).and_then(|v|v.pointer("/compilerOptions/baseUrl").and_then(Value::as_str).map(str::to_owned))}
}
fn make_seeds(before:&Side,after:&Side,files:&[File],changes:&[Change],warnings:&mut Vec<String>)->Vec<Seed>{
    let mut seeds=Vec::new();
    for file in files.iter().filter(|f|f.change.is_some()) {
        let change=&changes[file.change.unwrap()];let mut changed_before=HashSet::new();let mut changed_after=HashSet::new();let mut fallback=change.status=="renamed"&&change.hunks.is_empty();let mut identity_fallback=false;
        for (side,path,selected,after_flag) in [(before,&file.old,&mut changed_before,false),(after,&file.new,&mut changed_after,true)] {
            let Some(path)=path else{continue};if !relationships::supports_path(path){continue}
            let methods:Vec<_>=side.graph.symbols.iter().enumerate().filter(|(id,s)|&s.file==path&&side.graph.symbol_spans.get(*id).is_some_and(Option::is_some)).collect();
            for h in &change.hunks {let (start,count)=if after_flag{(h.new_start,h.new_count)}else{(h.old_start,h.old_count)};for line in start..start+count {
                let covering:Vec<_>=methods.iter().filter(|(id,_)|side.graph.symbol_spans[*id].is_some_and(|(a,b)|a<=line&&line<=b)).collect();
                let smallest=covering.iter().map(|(id,_)|{let(a,b)=side.graph.symbol_spans[*id].unwrap();b-a}).min();
                if let Some(smallest)=smallest {for(id,_)in covering {let(a,b)=side.graph.symbol_spans[*id].unwrap();if b-a==smallest{selected.insert(*id);}}}else{fallback=true;}
            }}
            if change.hunks.is_empty()&&change.status!="renamed" {fallback=true;}
        }
        let mut paired_after=HashSet::new();let mut old:Vec<_>=changed_before.into_iter().collect();old.sort_unstable();let mut new:Vec<_>=changed_after.into_iter().collect();new.sort_unstable();
        for id in old {
            let symbol=&before.graph.symbols[id];let candidates:Vec<_>=after.graph.symbols.iter().enumerate().filter(|(other,s)|file.new.as_ref()==Some(&s.file)&&same_method(&before.graph,id,&after.graph,*other)).map(|(i,_)|i).collect();
            if file.old.is_some() && file.new.is_some() && (!unique_method(&before.graph,id)||candidates.len()>1||!after.graph.symbols.iter().any(|s|file.new.as_ref()==Some(&s.file))) {fallback=true;identity_fallback=true;continue}
            let target=if candidates.len()==1{Some(candidates[0])}else{None};if let Some(target)=target{paired_after.insert(target);}
            seeds.push(Seed{id:String::new(),name:symbol.name.clone(),file:file.path.clone(),before:vec![id],after:target.into_iter().collect(),kind:"method",change:if target.is_some(){"modified"}else{"deleted"}});
        }
        for id in new.into_iter().filter(|id|!paired_after.contains(id)) {
            let symbol=&after.graph.symbols[id];let candidates:Vec<_>=before.graph.symbols.iter().enumerate().filter(|(other,s)|file.old.as_ref()==Some(&s.file)&&same_method(&after.graph,id,&before.graph,*other)).map(|(i,_)|i).collect();
            if file.old.is_some() && file.new.is_some() && (!unique_method(&after.graph,id)||candidates.len()>1||!before.graph.symbols.iter().any(|s|file.old.as_ref()==Some(&s.file))) {fallback=true;identity_fallback=true;continue}
            let source=if candidates.len()==1{Some(candidates[0])}else{None};
            seeds.push(Seed{id:String::new(),name:symbol.name.clone(),file:file.path.clone(),before:source.into_iter().collect(),after:vec![id],kind:"method",change:if source.is_some(){"modified"}else{"added"}});
        }
        if fallback {
            let ids=|side:&Side,path:&Option<String>|side.graph.symbols.iter().enumerate().filter(|(_,s)|path.as_ref()==Some(&s.file)).map(|(id,_)|id).collect::<Vec<_>>();let old=ids(before,&file.old);let new=ids(after,&file.new);
            if !old.is_empty()||!new.is_empty(){seeds.push(Seed{id:String::new(),name:format!("{} (file-level fallback)",file.path),file:file.path.clone(),before:old,after:new,kind:"file",change:if file.old.is_none(){"added"}else if file.new.is_none(){"deleted"}else{"modified"}});warnings.push(if identity_fallback {format!("{} has an unmatchable or ambiguous method identity; its file-level seed conservatively includes sibling methods",file.path)}else{format!("{} has edits outside attributable methods or a path change; its file-level seed conservatively includes sibling methods",file.path)});}
        }
        if !seeds.iter().any(|s|s.file==file.path){warnings.push(format!("{}: edits are visible, but no supported source graph can infer caller impact",file.path));}
    }
    seeds.sort_by(|a,b|(&a.file,&a.name,a.before.first(),a.after.first()).cmp(&(&b.file,&b.name,b.before.first(),b.after.first())));
    for (i,seed) in seeds.iter_mut().enumerate(){seed.id=format!("{}-{i}",seed.kind);}
    seeds
}
fn same_method(left:&Graph,a:usize,right:&Graph,b:usize)->bool {
    left.symbol_keys.get(a).and_then(Option::as_ref).zip(right.symbol_keys.get(b).and_then(Option::as_ref)).is_some_and(|(a,b)|a==b)
}
fn unique_method(graph:&Graph,id:usize)->bool {
    graph.symbol_keys.get(id).and_then(Option::as_ref).is_some() && graph.symbols.iter().enumerate().filter(|(other,s)|s.file==graph.symbols[id].file&&same_method(graph,id,graph,*other)).count()==1
}
fn comparable_edges(graph:&Graph)->Vec<&CallEdge> {
    let mut counts:HashMap<(&str,&str),usize>=HashMap::new();
    for symbol in &graph.symbols {*counts.entry((&symbol.file,&symbol.name)).or_default()+=1;}
    let stable=|s:&SymbolRef|!s.name.contains("<block@")&&!s.name.contains("<initializer@")&&!s.name.contains("<function@")&&counts.get(&(s.file.as_str(),s.name.as_str()))==Some(&1);
    graph.edges.iter().filter(|e|stable(&e.caller)&&stable(&e.callee)).collect()
}
fn validate_path(path:&str)->Result<(),String>{if path.is_empty()||path.len()>4096||path.contains('\0')||Path::new(path).components().any(|p|!matches!(p,Component::Normal(_)))||path.split('/').any(|p|p.is_empty()||p=="."||p==".."||p.eq_ignore_ascii_case(".git")){Err("invalid snapshot relative path".into())}else{Ok(())}}
fn optional_path(v:&Value,key:&str)->Result<Option<String>,String>{match v.get(key){Some(Value::Null)=>Ok(None),Some(Value::String(s))=>{validate_path(s)?;Ok(Some(s.clone()))},_=>Err(format!("{key} must be a path or null"))}}
fn string<'a>(v:&'a Value,key:&str)->Result<&'a str,String>{v.get(key).and_then(Value::as_str).ok_or_else(||format!("{key} must be text"))}
fn read_regular(path:&Path,limit:usize)->Result<Vec<u8>,String>{let m=fs::symlink_metadata(path).map_err(|_|"snapshot file is unavailable")?;if !m.file_type().is_file()||m.len()>limit as u64{return Err("snapshot file is not regular or exceeds its size limit".into())}let mut bytes=Vec::new();fs::File::open(path).map_err(|_|"snapshot file cannot be opened")?.take(limit as u64+1).read_to_end(&mut bytes).map_err(|_|"snapshot file cannot be read")?;if bytes.len()>limit{return Err("snapshot file exceeds its size limit".into())}Ok(bytes)}
fn line_count(text:&str)->usize{text.split_inclusive('\n').count()}
fn summarize(text:&str)->Vec<scan::Line>{let mut lines=scan::summarize_lines(text.as_bytes());lines.resize(line_count(text),scan::Line::default());lines}
fn excerpt(lines:&[&str],start:usize,count:usize,limit:usize)->Vec<String>{lines.iter().skip(start.saturating_sub(1)).take(count.min(limit)).map(|s|s.chars().take(4000).collect()).collect()}
fn rect(r:R)->[f64;4]{[r.x,r.y,r.w,r.h]}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64,Ordering};
    static NEXT:AtomicU64=AtomicU64::new(1);
    struct Fixture { root:PathBuf, manifest:Value }
    impl Fixture {
        fn new(before:&[(&str,&str)],after:&[(&str,&str)],changes:Value)->Self {
            let root=std::env::temp_dir().join(format!("spamton-pr-rust-{}-{}",std::process::id(),NEXT.fetch_add(1,Ordering::Relaxed)));
            fs::create_dir_all(root.join("before")).unwrap();fs::create_dir_all(root.join("after")).unwrap();
            let side=|name:&str,files:&[(&str,&str)]|files.iter().map(|(path,text)|{let full=root.join(name).join(path);fs::create_dir_all(full.parent().unwrap()).unwrap();fs::write(full,text).unwrap();json!({"path":path,"bytes":text.len(),"omitted":null})}).collect::<Vec<_>>();
            let manifest=json!({"version":1,"pr":{"number":7,"title":"fixture PR","url":"https://github.com/example/repo/pull/7","baseSha":"1111111111111111111111111111111111111111","headSha":"2222222222222222222222222222222222222222","mergeBaseSha":"1111111111111111111111111111111111111111"},"baseRoot":root.join("before"),"headRoot":root.join("after"),"baseFiles":side("before",before),"headFiles":side("after",after),"changes":changes,"warnings":[]});
            Self{root,manifest}
        }
        fn open(&self)->Result<ComparisonProject,String>{let p=self.root.join("comparison.json");fs::write(&p,self.manifest.to_string()).unwrap();ComparisonProject::new(&p,&self.root.join("after"))}
    }
    impl Drop for Fixture {fn drop(&mut self){let _=fs::remove_dir_all(&self.root);}}
    fn result(response:Value)->Value {assert!(response.get("error").is_none(),"{response}");response["result"].clone()}
    fn view(project:&mut ComparisonProject,options:Value)->Value{result(project.request(&json!({"id":1,"op":"view","options":options})))}
    fn file<'a>(view:&'a Value,path:&str)->&'a Value{let node=view["nodes"].as_array().unwrap().iter().find(|n|n["path"]==path).unwrap()["id"].clone();view["pr"]["files"].as_array().unwrap().iter().find(|f|f["node"]==node).unwrap()}
    fn modified(path:&str,old_start:usize,old_count:usize,new_start:usize,new_count:usize)->Value{json!([{"status":"modified","oldPath":path,"newPath":path,"hunks":[{"oldStart":old_start,"oldCount":old_count,"newStart":new_start,"newCount":new_count}]}])}

    #[test]
    fn shared_index_restores_each_clients_source_and_invalid_filter_history() {
        let old="class Service\n def self.changed; 1; end\n def self.other; 2; end\nend\n";
        let new=old.replace("changed; 1","changed; 9");
        let caller="class Caller; def self.run; Service.changed; end; end\n";
        let fixture=Fixture::new(&[("service.rb",old),("caller.rb",caller)],&[("service.rb",&new),("caller.rb",caller)],modified("service.rb",2,1,2,1));
        let mut project=fixture.open().unwrap();let initial=view(&mut project,json!({}));
        let seed=initial["pr"]["seeds"][0]["id"].clone();let node=file(&initial,"service.rb")["node"].clone();let caller_node=file(&initial,"caller.rb")["node"].clone();
        let client_a=json!({"prSide":"before","prScope":"impact","prSeed":seed,"depth":2,"filter":"service | caller","hideTests":true,"search":"caller","evidence":"source"});
        let a=view(&mut project,client_a.clone());
        let expected=result(project.request(&json!({"op":"source","node":node,"syntax":false})));
        let expected_links=result(project.request(&json!({"op":"source","node":caller_node,"syntax":false})));
        let b=view(&mut project,json!({"prSide":"after","filter":"service","evidence":"observed"}));
        let expected_b=result(project.request(&json!({"op":"source","node":node,"syntax":false})));
        let expected_b_links=result(project.request(&json!({"op":"source","node":caller_node,"syntax":false})));
        let actual=result(project.request(&json!({"op":"source","node":node,"syntax":false,"contextOptions":client_a})));
        assert_eq!(actual,expected,"client A must keep its before source after client B's view");
        let links=result(project.request(&json!({"op":"source","node":caller_node,"syntax":false,"contextOptions":client_a})));
        assert_eq!(links,expected_links,"source visibility and call links must use client A's context");
        assert!(!links["lines"][0]["links"].as_array().unwrap().is_empty());
        assert_eq!(a["contextOptions"],client_a,"views return their complete normalized context");
        assert_eq!(b["contextOptions"]["prSide"],"after");
        assert_eq!(result(project.request(&json!({"op":"source","node":node,"syntax":false,"contextOptions":b["contextOptions"]}))),expected_b);
        assert_eq!(result(project.request(&json!({"op":"source","node":caller_node,"syntax":false,"contextOptions":b["contextOptions"]}))),expected_b_links);
        // Another client's valid filter must never become A's invalid-filter fallback.
        view(&mut project,json!({"filter":"service","evidence":"observed"}));
        let mut invalid=client_a.clone();invalid["filter"]=json!("|");
        let restored=result(project.request(&json!({"op":"view","previousOptions":client_a,"options":invalid})));
        assert_eq!(restored["contextOptions"]["filter"],"service | caller");
        assert!(restored["nodes"][caller_node.as_u64().unwrap() as usize]["visible"].as_bool().unwrap());
        let first=result(project.request(&json!({"op":"view","previousOptions":{},"options":{"filter":"|"}})));
        assert_eq!(first["contextOptions"]["filter"],"");
    }

    #[test]
    fn construction_progress_reports_real_bounded_stages_without_changing_results() {
        let old="class Service; def self.run; 1; end; end\n";let new=old.replace("run; 1","run; 2");
        let fixture=Fixture::new(&[("service.rb",old)],&[("service.rb",&new)],modified("service.rb",1,1,1,1));
        let mut ordinary=fixture.open().unwrap();let mut events=Vec::new();
        let mut reported=ComparisonProject::new_with_progress(&fixture.root.join("comparison.json"),&fixture.root.join("after"),|event|events.push(event)).unwrap();
        assert_eq!(result(reported.request(&json!({"id":1,"op":"ready"}))),json!({"ready":true}));
        assert_eq!(view(&mut reported,json!({})),view(&mut ordinary,json!({})));
        for phase in ["manifest","before-scan","after-scan","parse","before-resolve","before-index","after-resolve","after-index","comparison","relationship-delta"] {
            let stage:Vec<_>=events.iter().filter(|event|event["phase"]==phase).collect();
            assert!(stage.len()>=2,"missing progress for {phase}");
            assert_eq!(stage[0]["completed"],0);
            let final_event=stage.last().unwrap();assert_eq!(final_event["completed"],final_event["total"]);
            assert!(stage.windows(2).all(|events|events[0]["completed"].as_u64()<=events[1]["completed"].as_u64()));
        }
        assert!(events.windows(2).all(|events|events[0]["elapsedMs"].as_u64()<=events[1]["elapsedMs"].as_u64()));
    }

    #[test]
    fn body_edit_starts_at_its_method_and_keeps_geometry_stable_across_sides_and_depth() {
        let old="class Service\n def self.changed\n  1\n end\n def self.untouched; 2; end\nend\n";
        let new=old.replace("  1","  3");
        let caller="class Caller; def self.run; Service.changed; end; end\n";
        let unrelated="class Unrelated; def self.run; Service.untouched; end; end\n";
        let outer="class Outer; def self.run; Caller.run; end; end\n";
        let fixture=Fixture::new(&[("service.rb",old),("caller.rb",caller),("unrelated.rb",unrelated),("outer.rb",outer)],&[("service.rb",&new),("caller.rb",caller),("unrelated.rb",unrelated),("outer.rb",outer)],modified("service.rb",3,1,3,1));
        let mut project=fixture.open().unwrap();let first=view(&mut project,json!({"depth":1}));
        assert_eq!(first["pr"]["counts"]["changedMethods"],1);assert_eq!(first["pr"]["seeds"][0]["name"],"Service.changed");
        assert_eq!(file(&first,"caller.rb")["distance"],1);assert_eq!(file(&first,"unrelated.rb")["impact"],"none");assert_eq!(file(&first,"outer.rb")["impact"],"none");
        let second=view(&mut project,json!({"depth":2,"prSide":"before","prScope":"impact"}));
        assert_eq!(file(&second,"outer.rb")["distance"],2);assert_eq!(file(&second,"outer.rb")["witness"].as_array().unwrap().len(),2);
        for a in first["nodes"].as_array().unwrap(){let b=&second["nodes"][a["id"].as_u64().unwrap() as usize];assert_eq!(a["rect"],b["rect"]);assert_eq!(a["cols"],b["cols"]);assert_eq!(a["lineHeight"],b["lineHeight"]);}
        let source=result(project.request(&json!({"id":2,"op":"source","node":file(&second,"service.rb")["node"]})));
        assert_eq!(source["pr"]["changedLines"],json!([3]));assert_eq!(source["pr"]["hunks"][0]["oldLines"],json!(["  1"]));assert_eq!(source["lines"][2]["text"],"  1");
        assert_eq!(second["pr"]["relationships"]["addedCount"],0);assert_eq!(second["pr"]["relationships"]["removedCount"],0);
    }

    #[test]
    fn removed_method_keeps_before_callers_without_seeding_the_remaining_sibling() {
        let old="class Service\n def self.changed\n  1\n end\n def self.untouched; 2; end\nend\n";
        let new="class Service\n def self.untouched; 2; end\nend\n";
        let caller="class Caller; def self.run; Service.changed; end; end\n";let unrelated="class Unrelated; def self.run; Service.untouched; end; end\n";
        let fixture=Fixture::new(&[("service.rb",old),("caller.rb",caller),("unrelated.rb",unrelated)],&[("service.rb",new),("caller.rb",caller),("unrelated.rb",unrelated)],modified("service.rb",2,3,1,0));
        let mut project=fixture.open().unwrap();let v=view(&mut project,json!({}));
        assert_eq!(v["pr"]["seeds"][0]["change"],"deleted");assert_eq!(v["pr"]["seeds"][0]["afterLine"],Value::Null);assert_eq!(file(&v,"caller.rb")["witness"][0]["side"],"before");assert_eq!(file(&v,"unrelated.rb")["impact"],"none");
        assert_eq!(v["pr"]["relationships"]["removedCount"],1);assert_eq!(v["pr"]["relationships"]["removed"][0]["callee"]["name"],"Service.changed");
        let before=view(&mut project,json!({"prSide":"before"}));let source=result(project.request(&json!({"op":"source","node":file(&before,"caller.rb")["node"]})));
        assert!(source["lines"][0]["links"].as_array().unwrap().iter().any(|l|l["definition"]["name"]=="Service.changed"));
    }

    #[test]
    fn semantic_relationship_delta_ignores_line_shifts_but_records_changed_destinations() {
        let old="class Service\n def self.run; Old.go; end\nend\n";let new="\nclass Service\n def self.run; New.go; end\nend\n";
        let targets="class Old; def self.go; end; end\nclass New; def self.go; end; end\n";
        let fixture=Fixture::new(&[("service.rb",old),("targets.rb",targets)],&[("service.rb",new),("targets.rb",targets)],modified("service.rb",1,2,1,3));let mut project=fixture.open().unwrap();let v=view(&mut project,json!({}));
        assert_eq!(v["pr"]["relationships"]["addedCount"],1);assert_eq!(v["pr"]["relationships"]["removedCount"],1);
        assert_eq!(v["pr"]["relationships"]["added"][0]["callee"]["name"],"New.go");assert_eq!(v["pr"]["relationships"]["removed"][0]["callee"]["name"],"Old.go");
        let shifted=Fixture::new(&[("service.rb",old),("targets.rb",targets)],&[("service.rb",&format!("\n\n{old}")),("targets.rb",targets)],modified("service.rb",0,0,1,2));let mut project=shifted.open().unwrap();let v=view(&mut project,json!({}));assert_eq!(v["pr"]["relationships"]["addedCount"],0);assert_eq!(v["pr"]["relationships"]["removedCount"],0);
    }

    #[test]
    fn renamed_and_deleted_files_retain_both_source_identities() {
        let service="class Service; def self.run; end; end\n";let caller="class Caller; def self.run; Service.run; end; end\n";
        let fixture=Fixture::new(&[("old_service.rb",service),("caller.rb",caller),("gone.txt","gone\n")],&[("new_service.rb",service),("caller.rb",caller)],json!([{"status":"renamed","oldPath":"old_service.rb","newPath":"new_service.rb","hunks":[]},{"status":"deleted","oldPath":"gone.txt","newPath":null,"hunks":[{"oldStart":1,"oldCount":1,"newStart":0,"newCount":0}]}]));
        let mut project=fixture.open().unwrap();let after=view(&mut project,json!({}));let renamed=file(&after,"new_service.rb");assert_eq!(renamed["oldPath"],"old_service.rb");assert_eq!(renamed["status"],"renamed");assert_eq!(file(&after,"caller.rb")["impact"],"caller");assert_eq!(after["pr"]["relationships"]["addedCount"],0);
        let absent=result(project.request(&json!({"op":"source","node":file(&after,"gone.txt")["node"]})));assert!(absent["message"].as_str().unwrap().contains("absent"));assert!(absent["lines"].as_array().unwrap().is_empty());
        let before=view(&mut project,json!({"prSide":"before"}));let source=result(project.request(&json!({"op":"source","node":file(&before,"new_service.rb")["node"]})));assert_eq!(source["pr"]["path"],"old_service.rb");assert_eq!(file(&before,"new_service.rb")["node"],renamed["node"]);
    }

    #[test]
    fn typescript_function_body_change_selects_its_actual_span() {
        let service="export function changed() {\n return 1;\n}\nexport const untouched = () => 2;\n";let edited=service.replace("return 1","return 9");
        let caller="import {changed} from './service'; export function caller() { return changed(); }\n";let other="import {untouched} from './service'; export function other() { return untouched(); }\n";
        let fixture=Fixture::new(&[("service.ts",service),("caller.ts",caller),("other.ts",other)],&[("service.ts",&edited),("caller.ts",caller),("other.ts",other)],modified("service.ts",2,1,2,1));let mut project=fixture.open().unwrap();let v=view(&mut project,json!({}));assert_eq!(v["pr"]["seeds"].as_array().unwrap().len(),1);assert_eq!(v["pr"]["seeds"][0]["name"],"changed");assert_eq!(file(&v,"caller.ts")["impact"],"caller");assert_eq!(file(&v,"other.ts")["impact"],"none");
    }

    #[test]
    fn invalid_paths_symlinks_and_mismatched_roots_are_rejected() {
        let mut fixture=Fixture::new(&[("a.rb","1\n")],&[("a.rb","2\n")],modified("a.rb",1,1,1,1));fixture.manifest["headFiles"][0]["path"]=json!("../escape.rb");assert!(fixture.open().err().unwrap().contains("invalid snapshot"));
        fixture.manifest["headFiles"][0]["path"]=json!("a.rb");fixture.manifest["headRoot"]=json!(fixture.root.join("before"));assert!(fixture.open().is_err());
        #[cfg(unix)] {
            fixture.manifest["headRoot"]=json!(fixture.root.join("after"));fs::remove_file(fixture.root.join("after/a.rb")).unwrap();std::os::unix::fs::symlink(fixture.root.join("before/a.rb"),fixture.root.join("after/a.rb")).unwrap();assert!(fixture.open().err().unwrap().contains("symlink"));
        }
    }

    #[test]
    fn unsupported_and_failed_parse_edits_are_visible_with_explicit_coverage_gaps() {
        let fixture=Fixture::new(&[("readme.txt","old\n"),("broken.rb","class Broken(\n")],&[("readme.txt","new\n"),("broken.rb","class Broken(1\n")],json!([{"status":"modified","oldPath":"readme.txt","newPath":"readme.txt","hunks":[{"oldStart":1,"oldCount":1,"newStart":1,"newCount":1}]},{"status":"modified","oldPath":"broken.rb","newPath":"broken.rb","hunks":[{"oldStart":1,"oldCount":1,"newStart":1,"newCount":1}]}]));
        let mut project=fixture.open().unwrap();let v=view(&mut project,json!({"prScope":"impact"}));assert_eq!(v["counts"]["files"],2);assert_eq!(v["pr"]["counts"]["changedMethods"],0);assert_eq!(v["pr"]["diagnostics"]["before"]["parseErrors"],1);assert!(v["pr"]["warnings"].as_array().unwrap().iter().any(|w|w.as_str().unwrap().contains("no supported source graph")));
        assert!(project.request(&json!({"op":"capture"}))["error"].is_string());assert!(project.request(&json!({"op":"view","options":{"prSeed":"missing"}}))["error"].is_string());
    }
    #[test]
    fn moving_anonymous_blocks_and_field_initializers_does_not_invent_relationship_changes() {
        let ruby="class Service; def self.run; end; end\n[1].each do\n Service.run\nend\n";
        let js="import {go} from './target';\nclass Worker { value = go(); }\n";
        let target="export function go() { return 1; }\n";
        let new_ruby=format!("\n\n{ruby}");let new_js=format!("\n\n{js}");
        let fixture=Fixture::new(&[("block.rb",ruby),("field.js",js),("target.js",target)],&[("block.rb",&new_ruby),("field.js",&new_js),("target.js",target)],json!([
            {"status":"modified","oldPath":"block.rb","newPath":"block.rb","hunks":[{"oldStart":0,"oldCount":0,"newStart":1,"newCount":2}]},
            {"status":"modified","oldPath":"field.js","newPath":"field.js","hunks":[{"oldStart":0,"oldCount":0,"newStart":1,"newCount":2}]}
        ]));
        let mut project=fixture.open().unwrap();
        assert!(project.before.graph.edges.iter().any(|e|e.caller.name.starts_with("<block@")));
        assert!(project.before.graph.edges.iter().any(|e|e.caller.name.starts_with("<initializer@")));
        let v=view(&mut project,json!({}));
        assert_eq!(v["pr"]["relationships"]["addedCount"],0);assert_eq!(v["pr"]["relationships"]["removedCount"],0);
        assert_eq!(v["pr"]["relationships"]["uncomparedBeforeCount"],2);
        assert!(v["pr"]["warnings"].as_array().unwrap().iter().any(|w|w.as_str().unwrap().contains("anonymous/location-based")));
    }

    #[test]
    fn diff_excerpt_limit_does_not_hide_later_changed_lines() {
        let old=(0..600).map(|_|"old\n").collect::<String>();let new=(0..600).map(|_|"new\n").collect::<String>();
        let fixture=Fixture::new(&[("note.txt",&old)],&[("note.txt",&new)],json!([{"status":"modified","oldPath":"note.txt","newPath":"note.txt","hunks":[
            {"oldStart":1,"oldCount":401,"newStart":1,"newCount":401},
            {"oldStart":500,"oldCount":1,"newStart":500,"newCount":1},
            {"oldStart":600,"oldCount":1,"newStart":600,"newCount":1}
        ]}]));let mut project=fixture.open().unwrap();let v=view(&mut project,json!({}));
        let source=result(project.request(&json!({"op":"source","node":file(&v,"note.txt")["node"]})));
        assert!(source["pr"]["changedLines"].as_array().unwrap().contains(&json!(600)));
        assert_eq!(source["pr"]["hunks"].as_array().unwrap().len(),3);
        assert!(source["pr"]["hunks"].as_array().unwrap().iter().map(|h|h["oldLines"].as_array().unwrap().len()+h["newLines"].as_array().unwrap().len()).sum::<usize>()<=MAX_HUNK_LINES);
        assert!(source["pr"]["message"].as_str().unwrap().contains("truncated"));
    }

    #[test]
    fn confidence_change_does_not_add_and_remove_the_same_method_relationship() {
        let old="class Company\n def name; 'name'; end\n def entry; self.name; end\nend\n";
        let new="class Company\n def name; 'name'; end\n def entry; receiver = Company.new; receiver.name; end\nend\n";
        let fixture=Fixture::new(&[("company.rb",old)],&[("company.rb",new)],modified("company.rb",3,1,3,1));
        let mut project=fixture.open().unwrap();
        let before=project.before.graph.edges.iter().find(|e|e.caller.name=="Company#entry"&&e.callee.name=="Company#name").unwrap();
        let after=project.after.graph.edges.iter().find(|e|e.caller.name=="Company#entry"&&e.callee.name=="Company#name").unwrap();
        assert_ne!(before.evidence,after.evidence);
        let v=view(&mut project,json!({}));
        assert_eq!(v["pr"]["relationships"]["addedCount"],0);assert_eq!(v["pr"]["relationships"]["removedCount"],0);
    }

    #[test]
    fn a_new_blank_line_is_valid_git_source_with_matching_preview_geometry() {
        let fixture=Fixture::new(&[("empty.txt","")],&[("empty.txt","\n")],modified("empty.txt",0,0,1,1));
        let mut project=fixture.open().unwrap();let v=view(&mut project,json!({}));let f=file(&v,"empty.txt");
        assert_eq!(f["beforeLines"],0);assert_eq!(f["afterLines"],1);
        let node=f["node"].as_u64().unwrap() as usize;assert_eq!(v["nodes"][node]["lineCount"],1);
        let source=result(project.request(&json!({"op":"source","node":node})));
        assert_eq!(source["lines"].as_array().unwrap().len(),1);assert_eq!(source["pr"]["changedLines"],json!([1]));
    }

    #[test]
    fn same_named_methods_in_separate_classes_match_their_own_counterpart() {
        let old="export class A {\n static go() { return 1; }\n}\nexport class B {\n static go() { return 2; }\n}\n";
        let new=old.replace("return 1","return 9");let caller="import {A} from './service'; export function caller() { return A.go(); }\n";let other="import {B} from './service'; export function other() { return B.go(); }\n";
        let fixture=Fixture::new(&[("service.ts",old),("caller.ts",caller),("other.ts",other)],&[("service.ts",&new),("caller.ts",caller),("other.ts",other)],modified("service.ts",2,1,2,1));
        let mut project=fixture.open().unwrap();let v=view(&mut project,json!({}));
        assert_eq!(v["pr"]["seeds"].as_array().unwrap().len(),1);assert_eq!(v["pr"]["seeds"][0]["change"],"modified");assert_eq!(v["pr"]["seeds"][0]["beforeLine"],2);assert_eq!(v["pr"]["seeds"][0]["afterLine"],2);
        let id=v["pr"]["seeds"][0]["id"].clone();
        for side in ["before","after"]{let v=view(&mut project,json!({"prSide":side,"prSeed":id}));assert_eq!(file(&v,"caller.ts")["impact"],"caller");assert_eq!(file(&v,"other.ts")["impact"],"none");}
    }

    #[test]
    fn default_exports_accessors_and_unmatchable_callbacks_have_honest_change_seeds() {
        let cases=[
            ("default function","export default function() {\n return 1;\n}\n",1),
            ("default arrow","export default () => {\n return 1;\n};\n",1),
            ("accessor","export class A {\n get value() { return 1; }\n set value(value: number) {}\n}\n",2),
        ];
        let mut results=Vec::new();
        for (label,old,line) in cases {
            let new=old.replace("return 1","return 2");let fixture=Fixture::new(&[("service.ts",old)],&[("service.ts",&new)],modified("service.ts",2,1,2,1));
            let mut project=fixture.open().unwrap();let v=view(&mut project,json!({}));let seeds=&v["pr"]["seeds"];
            results.push(json!({"case":label,"count":seeds.as_array().unwrap().len(),"kind":seeds[0]["kind"],"change":seeds[0]["change"],"before":seeds[0]["beforeLine"],"after":seeds[0]["afterLine"],"expectedLine":line}));
        }
        let old="[1].map(() => {\n return 1;\n});\n";let new=old.replace("return 1","return 2");
        let fixture=Fixture::new(&[("callback.ts",old)],&[("callback.ts",&new)],modified("callback.ts",2,1,2,1));let mut project=fixture.open().unwrap();let unknown=view(&mut project,json!({}));
        for r in &results {assert_eq!(r["count"],1,"{r}");assert_eq!(r["kind"],"method","{r}");assert_eq!(r["change"],"modified","{r}");assert_eq!(r["before"],r["expectedLine"],"{r}");assert_eq!(r["after"],r["expectedLine"],"{r}");}
        assert_eq!(unknown["pr"]["seeds"].as_array().unwrap().len(),1);assert_eq!(unknown["pr"]["seeds"][0]["kind"],"file");assert_eq!(unknown["pr"]["seeds"][0]["change"],"modified");assert_eq!(unknown["pr"]["counts"]["changedMethods"],0);
        assert!(unknown["pr"]["warnings"].as_array().unwrap().iter().any(|w|w.as_str().unwrap().contains("method identity")));
    }

}
