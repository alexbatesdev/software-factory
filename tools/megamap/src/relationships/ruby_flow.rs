use super::*;
use std::cell::RefCell;

#[derive(Clone)]
pub(super) enum RubyExpr {
    Unknown,
    Other,
    Nil,
    SelfValue,
    Constant(String),
    Name(String, usize),
    Ivar(String),
    Send(Box<RubyExpr>, String, RubyArgs),
    Alternatives(Vec<RubyExpr>),
}

#[derive(Clone)]
pub(super) struct RubyFact {
    pub expr: RubyExpr,
    pub context: RubyContext,
    pub file: usize,
    pub byte: usize,
    pub valid: bool,
}

#[derive(Clone)]
pub(super) struct RubyTyped {
    pub value: RubyValue,
    pub reason: Option<String>,
    pub loaded: bool,
}

#[derive(Default)]
pub(super) struct RubyFlow {
    pub locals: HashMap<(usize, String), Vec<RubyFact>>,
    pub blocked: HashSet<(usize, String)>,
    pub ivars: HashMap<(String, bool, String), Vec<RubyFact>>,
    pub returns: HashMap<usize, RubyFact>,
    pub helpers: HashSet<String>,
    pub models: HashMap<String, (usize, usize)>,
    pub generated: HashMap<usize, String>,
    pub loaded_methods: HashMap<(String, bool, String), usize>,
    pub loaded_symbols: HashSet<usize>,
    declarations: Vec<(String, String, usize, usize, String)>,
    summaries: RefCell<HashMap<(usize, String), Option<RubyTyped>>>,
    active_ivars: RefCell<HashSet<(String, bool, String)>>,
}

impl Builder<'_> {
    pub(super) fn ruby_load_snapshot(&mut self) {
        let Some(snapshot) = self.snapshot else { return };
        self.ruby_index_evidence_symbols();
        for class in &snapshot.classes {
            if !class.file.ends_with(".rb") { continue; }
            let Some(file) = self.module_paths.get(&class.file).filter(|ids| ids.len() == 1).map(|ids| ids[0]).filter(|&file| self.file_scopes[file].is_some()) else { continue };
            self.ruby_classes.insert(class.name.clone());
            self.ruby_constants.insert(class.name.clone());
            if class.active_record { self.ruby_types.load_model(&class.name); }
            self.ruby_flow.models.entry(class.name.clone()).or_insert((file, class.line));
        }
        for class in &snapshot.classes {
            let valid_file = class.file.ends_with(".rb") && self.module_paths.get(&class.file).filter(|ids| ids.len() == 1).is_some_and(|ids| self.file_scopes[ids[0]].is_some());
            if !valid_file || !self.ruby_classes.contains(&class.name) { continue; }
            for method in &class.methods {
                let Some(id) = self.ruby_evidence_symbol(&method.definition) else { continue };
                if self.ruby_source_method(&class.name, method.singleton, &method.name) != Ok(Some(id)) {
                    self.ruby_flow.loaded_methods.insert((class.name.clone(), method.singleton, method.name.clone()), id);
                }
            }
            if !class.active_record { continue; }
            for name in &class.attributes {
                self.ruby_loaded_generated(&class.name, name, &class.file, class.line, format!("Loaded app attribute in {}; target is its supporting declaration ({})", class.name, snapshot.label));
            }
            for association in &class.associations {
                if !self.ruby_classes.contains(&association.target) { continue; }
                self.ruby_types.load_association(&class.name, &association.name, &association.target, association.collection);
                self.ruby_loaded_generated(&class.name, &association.name, &class.file, class.line, format!("Loaded app association {}#{} → {} ({})", class.name, association.name, association.target, snapshot.label));
            }
        }
    }

    fn ruby_loaded_generated(&mut self, owner: &str, name: &str, file: &str, line: usize, reason: String) {
        if self.ruby_method(owner, false, name).ok().flatten().is_some() { return; }
        let Some(file) = self.module_paths.get(file).filter(|ids| ids.len() == 1).map(|ids| ids[0]) else { return };
        let (file, line) = self.ruby_flow.declarations.iter().find(|(at, method, ..)| at == owner && method == name)
            .map(|(_, _, file, line, _)| (*file, *line)).unwrap_or((file, line));
        self.ruby_generate(owner, false, name, file, line, reason, true);
        if let Some(ids) = self.ruby_methods.get(&(owner.into(), false, name.into())).filter(|ids| ids.len() == 1) {
            self.ruby_flow.loaded_symbols.insert(ids[0]);
        }
    }

    pub(super) fn ruby_loaded_dispatch_reason(&self, owner: &str, singleton: bool, method: &str, id: usize) -> Option<String> {
        (self.ruby_flow.loaded_methods.get(&(owner.into(), singleton, method.into())) == Some(&id))
            .then(|| format!("Loaded app method lookup: {owner}{}{method} resolves to {} ({})", if singleton { "." } else { "#" }, self.graph.symbols[id].name, self.snapshot.map_or("capture", |s| s.label.as_str())))
    }

    fn ruby_evidence_symbol(&mut self, definition: &SymbolRef) -> Option<usize> {
        if !definition.file.ends_with(".rb") { return None; }
        let file = *self.module_paths.get(&definition.file).filter(|ids| ids.len() == 1)?.first()?;
        if self.file_scopes[file].is_none() { return None; }
        match self.evidence_symbols.get(definition) {
            Some(id) => *id,
            None => {
                let id = self.symbol(file, definition.name.clone(), definition.line);
                self.evidence_symbols.insert(definition.clone(), Some(id));
                Some(id)
            }
        }
    }

    fn ruby_index_evidence_symbols(&mut self) {
        self.evidence_symbols.clear();
        for (id, symbol) in self.graph.symbols.iter().enumerate() {
            self.evidence_symbols.entry(symbol.clone()).and_modify(|value| *value = None).or_insert(Some(id));
        }
    }

    pub(super) fn ruby_observed_links(&mut self, links: &mut Vec<(usize, usize, CallSite, Option<String>, EvidenceKind)>) {
        let Some(snapshot) = self.snapshot else { return };
        self.ruby_index_evidence_symbols();
        let mut sites: HashMap<String, HashMap<usize, HashMap<String, Vec<CallSite>>>> = HashMap::new();
        for call in &snapshot.calls {
            sites.entry(call.caller.file.clone()).or_default().entry(call.line).or_default().entry(call.method.clone()).or_default();
        }
        for call in &self.ruby_calls {
            if let Some(matching) = sites.get_mut(&self.sources[call.file].path).and_then(|lines| lines.get_mut(&call.site.line)).and_then(|methods| methods.get_mut(&call.method)) {
                matching.push(call.site);
            }
        }
        for observed in &snapshot.calls {
            let Some(caller) = self.ruby_evidence_symbol(&observed.caller) else { continue };
            let Some(callee) = self.ruby_evidence_symbol(&observed.callee) else { continue };
            let matching = &sites[&observed.caller.file][&observed.line][&observed.method];
            let site = if matching.len() == 1 { matching[0] } else { CallSite { line: observed.line, start_column: 0, end_column: 0 } };
            links.push((caller, callee, site, Some(format!("Observed in {}: {} call(s); only exercised execution is covered", snapshot.label, observed.count)), EvidenceKind::Observed));
        }
    }

    pub(super) fn ruby_expression(&self, node: Node<'_>, file: usize) -> RubyExpr {
        match node.kind() {
            "self" => RubyExpr::SelfValue,
            "nil" => RubyExpr::Nil,
            "integer" | "float" | "string" | "true" | "false" | "array" | "hash" | "symbol" | "simple_symbol" | "regex" | "range" => RubyExpr::Other,
            "constant" | "scope_resolution" => RubyExpr::Constant(self.text(file, node).into()),
            "identifier" => RubyExpr::Name(self.text(file, node).into(), node.start_byte()),
            "instance_variable" => RubyExpr::Ivar(self.text(file, node).into()),
            "call" => {
                let Some(method) = node.child_by_field_name("method") else { return RubyExpr::Unknown };
                let receiver = node.child_by_field_name("receiver").map(|n| self.ruby_expression(n, file)).unwrap_or(RubyExpr::SelfValue);
                let arguments = node.child_by_field_name("arguments").map(named).unwrap_or_default();
                let args = RubyArgs {
                    count: arguments.len(), array: arguments.first().is_some_and(|n| n.kind() == "array"),
                    splat: arguments.iter().any(|n| matches!(n.kind(), "splat_argument" | "hash_splat_argument" | "forward_argument")),
                    block: node.child_by_field_name("block").is_some(),
                };
                RubyExpr::Send(Box::new(receiver), self.text(file, method).into(), args)
            }
            "assignment" | "operator_assignment" => node.child_by_field_name("right").map(|n| self.ruby_expression(n, file)).unwrap_or(RubyExpr::Unknown),
            "body_statement" | "then" | "else" | "parenthesized_statements" => named(node).into_iter().filter(|n| n.kind() != "comment").last().map(|n| self.ruby_expression(n, file)).unwrap_or(RubyExpr::Nil),
            "return" | "argument_list" => {
                let children = named(node);
                if children.len() > 1 { RubyExpr::Unknown }
                else { children.first().map(|&n| self.ruby_expression(n, file)).unwrap_or(RubyExpr::Nil) }
            }
            _ => RubyExpr::Unknown,
        }
    }

    pub(super) fn ruby_return_expression(&self, body: Node<'_>, file: usize) -> RubyExpr {
        fn returns<'a>(node: Node<'a>, result: &mut Vec<Node<'a>>) {
            if matches!(node.kind(), "method" | "singleton_method" | "lambda" | "class" | "module") { return; }
            if node.kind() == "return" { result.push(node); return; }
            for child in named(node) { returns(child, result); }
        }
        let mut explicit = Vec::new();
        returns(body, &mut explicit);
        let mut expressions: Vec<_> = explicit.into_iter().map(|n| self.ruby_expression(n, file)).collect();
        expressions.push(self.ruby_expression(body, file));
        RubyExpr::Alternatives(expressions)
    }

    pub(super) fn ruby_block_parameters(&mut self, scope: usize) {
        self.ruby_flow.blocked.extend(self.scopes[scope].bindings.keys().map(|name| (scope, name.clone())));
    }

    fn ruby_binding_scope(&self, mut scope: usize, name: &str) -> Option<usize> {
        loop {
            if self.scopes[scope].bindings.contains_key(name) { return Some(scope); }
            scope = self.scopes[scope].parent?;
        }
    }

    pub(super) fn ruby_value_assignment(&mut self, node: Node<'_>, file: usize, context: &RubyContext) {
        let Some(left) = node.child_by_field_name("left") else { return };
        let expr = node.child_by_field_name("right").map(|n| self.ruby_expression(n, file)).unwrap_or(RubyExpr::Unknown);
        let mut valid = node.kind() == "assignment" || (node.kind() == "operator_assignment" && self.text(file, node).contains("||="));
        let mut parent = node.parent();
        while let Some(at) = parent {
            if matches!(at.kind(), "method" | "singleton_method" | "block" | "do_block" | "lambda" | "class" | "module") { break; }
            if matches!(at.kind(), "if" | "unless" | "if_modifier" | "unless_modifier" | "case" | "when" | "while" | "until" | "for" | "rescue" | "rescue_modifier") { valid = false; }
            parent = at.parent();
        }
        self.ruby_record_write(left, file, context, expr, valid, node.start_byte());
    }

    pub(super) fn ruby_record_loop_binding(&mut self, node: Node<'_>, file: usize, context: &RubyContext) {
        self.ruby_record_write(node, file, context, RubyExpr::Unknown, false, node.start_byte());
    }

    fn ruby_record_write(&mut self, left: Node<'_>, file: usize, context: &RubyContext, expr: RubyExpr, valid: bool, byte: usize) {
        let name = self.text(file, left).to_owned();
        let mut fact = RubyFact { expr, context: context.clone(), file, byte, valid };
        match left.kind() {
            "identifier" => {
                let scope = self.ruby_binding_scope(context.scope, &name).unwrap_or(context.scope);
                if scope != context.scope { fact.valid = false; }
                self.ruby_flow.locals.entry((scope, name)).or_default().push(fact);
            }
            "instance_variable" => if let Some(owner) = &context.class {
                self.ruby_flow.ivars.entry((owner.clone(), context.singleton, name)).or_default().push(fact);
            },
            "left_assignment_list" | "destructured_left_assignment" | "rest_assignment" => {
                for child in named(left) { self.ruby_record_write(child, file, context, RubyExpr::Unknown, false, byte); }
            }
            _ => {}
        }
    }

    pub(super) fn ruby_declaration(&mut self, node: Node<'_>, file: usize, context: &RubyContext) {
        if node.child_by_field_name("receiver").is_some() || !context.singleton { return; }
        let Some(owner) = &context.class else { return };
        let Some(method) = node.child_by_field_name("method").map(|n| self.text(file, n).to_owned()) else { return };
        let arguments = node.child_by_field_name("arguments").map(named).unwrap_or_default();
        if matches!(method.as_str(), "attr_reader" | "attr_accessor" | "helper_method") {
            let names: Vec<_> = arguments.iter().filter_map(|&n| ruby_symbol(self.text(file, n))).collect();
            for name in names {
                if method == "helper_method" { self.ruby_flow.helpers.insert(name); }
                else {
                    self.ruby_types.record_reader(owner, &name, &format!("@{name}"));
                    self.ruby_flow.declarations.push((owner.clone(), name, file, node.start_position().row + 1, format!("Ruby generated reader declared by {method}")));
                }
            }
        }
        if method == "attribute" {
            if let Some(name) = arguments.first().and_then(|&n| ruby_symbol(self.text(file, n))) {
                self.ruby_flow.declarations.push((owner.clone(), name, file, node.start_position().row + 1, "Rails attribute declaration".into()));
            }
        }
        let kind = match method.as_str() {
            "belongs_to" => AssociationKind::BelongsTo,
            "has_one" => AssociationKind::HasOne,
            "has_many" => AssociationKind::HasMany,
            _ => return,
        };
        let Some(name) = arguments.first().and_then(|&n| ruby_symbol(self.text(file, n))) else { return };
        let mut class_name = None;
        let mut unsupported = false;
        for argument in arguments.iter().skip(1) {
            if !matches!(argument.kind(), "pair" | "hash") { unsupported = true; }
            if matches!(argument.kind(), "lambda" | "block" | "do_block") { unsupported = true; }
            let pairs = if argument.kind() == "pair" { vec![*argument] } else { named(*argument) };
            if pairs.iter().any(|n| n.kind() != "pair") { unsupported = true; }
            for pair in pairs.into_iter().filter(|n| n.kind() == "pair") {
                let key = pair.child_by_field_name("key").and_then(|n| {
                    let text = self.text(file, n);
                    match n.kind() {
                        "hash_key_symbol" => Some(text.trim_end_matches(':').to_owned()),
                        "simple_symbol" => ruby_symbol(text),
                        "delimited_symbol" if named(n).iter().all(|child| child.kind() == "string_content") => text.strip_prefix(':').and_then(literal),
                        _ => None,
                    }
                });
                let Some(key) = key else { unsupported = true; continue };
                let value = pair.child_by_field_name("value");
                match key.as_str() {
                    "class_name" => {
                        class_name = value.and_then(|n| literal(self.text(file, n)));
                        if class_name.is_none() { unsupported = true; }
                    }
                    "polymorphic" | "through" | "source" | "source_type" => unsupported = true,
                    _ => {}
                }
            }
        }
        self.ruby_types.record_association(owner, &name, kind, class_name.as_deref(), unsupported, &context.nesting);
        self.ruby_flow.declarations.push((owner.clone(), name, file, node.start_position().row + 1, format!("Rails generated association declared by {method}")));
    }

    pub(super) fn ruby_generated_methods(&mut self) {
        let mut counts = HashMap::new();
        for (owner, name, ..) in &self.ruby_flow.declarations { *counts.entry((owner.clone(), name.clone())).or_insert(0) += 1; }
        for (owner, name, file, line, reason) in self.ruby_flow.declarations.clone() {
            if !reason.starts_with("Rails") || self.ruby_types.is_active_record(&owner) {
                if counts[&(owner.clone(), name.clone())] > 1 {
                    self.ruby_methods.entry((owner, false, name)).or_default();
                } else {
                    self.ruby_generate(&owner, false, &name, file, line, reason, true);
                }
            }
        }
        let methods: HashSet<String> = self.ruby_calls.iter().map(|call| call.method.clone()).collect();
        let models = self.ruby_flow.models.clone();
        for (owner, (file, line)) in models {
            if !self.ruby_types.is_active_record(&owner) { continue; }
            for method in &methods {
                let args = RubyArgs { count: if matches!(method.as_str(), "first" | "last" | "take" | "first!" | "last!" | "take!" | "all" | "none") { 0 } else { 1 }, ..RubyArgs::default() };
                if self.ruby_types.factory(&RubyValue::Class(owner.clone()), method, args, false).is_some() {
                    self.ruby_generate(&owner, true, method, file, line, format!("Rails inherited `{method}`; target is the {owner} model declaration, not a source method body"), false);
                }
            }
            self.ruby_generate(&owner, false, "id", file, line, format!("Rails record identity getter; target is the {owner} model declaration"), false);
            let other_models = self.ruby_flow.models.iter().filter(|(_, (f, _))| *f == file).count();
            if other_models != 1 { continue; }
            let attributes: Vec<(usize, String)> = self.sources[file].text.lines().take(line.saturating_sub(1)).enumerate().filter_map(|(row, text)| {
                let content = text.strip_prefix("#  ")?;
                let mut fields = content.split_whitespace();
                let name = fields.next()?;
                let kind = fields.next()?.trim_start_matches(':');
                if !matches!(kind.split('(').next()?, "integer" | "bigint" | "string" | "text" | "boolean" | "float" | "decimal" | "datetime" | "date" | "time" | "json" | "jsonb" | "binary") { return None; }
                if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') || !methods.contains(name) { return None; }
                Some((row + 1, name.to_owned()))
            }).collect();
            for (row, name) in attributes {
                self.ruby_generate(&owner, false, &name, file, row, format!("Rails attribute inferred from {owner}'s schema annotation; runtime schema is unverified"), false);
            }
        }
    }

    fn ruby_generate(&mut self, owner: &str, singleton: bool, name: &str, file: usize, line: usize, reason: String, declared: bool) {
        let key = (owner.to_owned(), singleton, name.to_owned());
        if reason.starts_with("Ruby generated reader") && self.ruby_methods.contains_key(&key) {
            self.ruby_methods.insert(key, Vec::new());
            return;
        }
        let mut current = Some(owner.to_owned());
        while let Some(at) = current {
            if self.ruby_methods.get(&(at.clone(), singleton, name.into())).is_some_and(|ids| ids.iter().any(|id| !self.ruby_flow.generated.contains_key(id))) { return; }
            if declared { break; }
            current = self.ruby_types.parent(&at).map(str::to_owned);
        }
        if self.ruby_methods.contains_key(&(owner.into(), singleton, name.into())) { return; }
        let id = self.symbol(file, format!("{owner}{}{name}", if singleton { "." } else { "#" }), line);
        self.ruby_methods.insert((owner.into(), singleton, name.into()), vec![id]);
        self.ruby_flow.generated.insert(id, reason);
        if self.ruby_types.requires_loaded_model(owner) { self.ruby_flow.loaded_symbols.insert(id); }
    }

    pub(super) fn ruby_framework_constant(&self, raw: &str, nesting: &[String]) -> Option<String> {
        if let Some(value) = self.ruby_constant(raw, nesting) { return Some(value); }
        if raw.trim_start_matches("::") != "ActiveRecord::Base" { return None; }
        if self.ruby_assigned_constants.contains("ActiveRecord") || self.ruby_assigned_constants.contains("ActiveRecord::Base") { return None; }
        if !raw.starts_with("::") && nesting.iter().any(|n| self.ruby_constants.contains(&format!("{n}::ActiveRecord"))) { return None; }
        Some("ActiveRecord::Base".into())
    }

    pub(super) fn ruby_method(&self, owner: &str, singleton: bool, method: &str) -> Result<Option<usize>, ()> {
        if let Some(id) = self.ruby_flow.loaded_methods.get(&(owner.into(), singleton, method.into())) { return Ok(Some(*id)); }
        self.ruby_source_method(owner, singleton, method)
    }

    fn ruby_source_method(&self, owner: &str, singleton: bool, method: &str) -> Result<Option<usize>, ()> {
        let mut current = owner;
        let mut seen = HashSet::new();
        loop {
            if !seen.insert(current) { return Err(()); }
            if let Some(ids) = self.ruby_methods.get(&(current.into(), singleton, method.into())) {
                return if ids.len() == 1 { Ok(Some(ids[0])) } else { Err(()) };
            }
            let Some(parent) = self.ruby_types.parent(current) else { return Ok(None) };
            current = parent;
        }
    }

    fn ruby_ivar(&self, owner: &str, singleton: bool, name: &str, seen: &mut HashSet<usize>, depth: usize) -> Option<RubyTyped> {
        let facts = self.ruby_flow.ivars.get(&(owner.into(), singleton, name.into()))?;
        let mut result: Option<RubyTyped> = None;
        for fact in facts {
            if !fact.valid { return None; }
            if matches!(fact.expr, RubyExpr::Nil) { continue; }
            let mut value = self.ruby_value(&fact.expr, fact.file, &fact.context, seen, depth + 1)?;
            if result.as_ref().is_some_and(|old| old.value != value.value) { return None; }
            if let Some(old) = &result { value = with_receiver_reason(value, old.reason.as_deref(), old.loaded); }
            result = Some(value);
        }
        result
    }

    pub(super) fn ruby_value(&self, expr: &RubyExpr, file: usize, context: &RubyContext, seen: &mut HashSet<usize>, depth: usize) -> Option<RubyTyped> {
        if depth > 24 { return None; }
        match expr {
            RubyExpr::Constant(raw) => Some(RubyTyped { value: RubyValue::Class(self.ruby_constant(raw, &context.nesting)?), reason: None, loaded: false }),
            RubyExpr::SelfValue => Some(RubyTyped { value: if context.singleton { RubyValue::Class(context.class.clone()?) } else { RubyValue::Instance(context.class.clone()?) }, reason: None, loaded: false }),
            RubyExpr::Name(name, byte) => {
                if let Some(scope) = self.ruby_binding_scope(context.scope, name) {
                    if self.ruby_flow.blocked.contains(&(scope, name.clone())) { return None; }
                    let facts = self.ruby_flow.locals.get(&(scope, name.clone()))?;
                    if facts.len() != 1 || !facts[0].valid || facts[0].byte >= *byte { return None; }
                    let fact = &facts[0];
                    let mut result = self.ruby_value(&fact.expr, fact.file, &fact.context, seen, depth + 1)?;
                    result.reason.get_or_insert_with(|| format!("Source assignment to `{name}`"));
                    return Some(result);
                }
                self.ruby_send(&RubyExpr::SelfValue, name, RubyArgs::default(), file, context, seen, depth + 1)
            }
            RubyExpr::Ivar(name) => {
                let owner = context.class.as_ref()?;
                let key = (owner.clone(), context.singleton, name.clone());
                if !self.ruby_flow.active_ivars.borrow_mut().insert(key.clone()) { return None; }
                let result = self.ruby_ivar(owner, context.singleton, name, seen, depth + 1).or_else(|| {
                    let hint = self.ruby_named_hint(name.trim_start_matches('@'), file, context, true)?;
                    if let Some(facts) = self.ruby_flow.ivars.get(&(owner.clone(), context.singleton, name.clone())) {
                        for fact in facts {
                            if ruby_known_scalar(&fact.expr) { return None; }
                            if self.ruby_value(&fact.expr, fact.file, &fact.context, seen, depth + 1).is_some_and(|v| v.value != hint.value) { return None; }
                        }
                    }
                    Some(hint)
                });
                self.ruby_flow.active_ivars.borrow_mut().remove(&key);
                result
            }
            RubyExpr::Send(receiver, method, args) => self.ruby_send(receiver, method, *args, file, context, seen, depth + 1),
            RubyExpr::Alternatives(expressions) => {
                let mut result: Option<RubyTyped> = None;
                for expr in expressions {
                    if matches!(expr, RubyExpr::Nil) { continue; }
                    let mut value = self.ruby_value(expr, file, context, seen, depth + 1)?;
                    if result.as_ref().is_some_and(|old| old.value != value.value) { return None; }
                    if let Some(old) = &result { value = with_receiver_reason(value, old.reason.as_deref(), old.loaded); }
                    result = Some(value);
                }
                result
            }
            _ => None,
        }
    }

    fn ruby_send(&self, receiver: &RubyExpr, method: &str, args: RubyArgs, file: usize, context: &RubyContext, seen: &mut HashSet<usize>, depth: usize) -> Option<RubyTyped> {
        let typed = self.ruby_value(receiver, file, context, seen, depth + 1)?;
        let (owner, singleton) = match &typed.value { RubyValue::Class(owner) | RubyValue::Relation(owner) => (owner.clone(), true), RubyValue::Instance(owner) => (owner.clone(), false) };
        let owner = &owner;
        let found = self.ruby_method(owner, singleton, method).ok()?;
        let mut typed = typed;
        if let Some(reason) = found.and_then(|id| self.ruby_loaded_dispatch_reason(owner, singleton, method, id)) {
            typed = with_receiver_reason(typed, Some(&reason), true);
        }
        if let Some(id) = found {
            let key = (id, owner.clone());
            let cached = self.ruby_flow.summaries.borrow().get(&key).cloned();
            if let Some(value) = cached {
                if let Some(value) = value { return Some(with_receiver_reason(value, typed.reason.as_deref(), typed.loaded)); }
            } else if seen.insert(id) {
                let result = self.ruby_flow.returns.get(&id).and_then(|fact| {
                    if fact.context.class.as_deref() != Some(owner) {
                        return ruby_returns_self(&fact.expr).then(|| RubyTyped {
                            value: if singleton { RubyValue::Class(owner.clone()) } else { RubyValue::Instance(owner.clone()) }, reason: None, loaded: false,
                        });
                    }
                    self.ruby_value(&fact.expr, fact.file, &fact.context, seen, depth + 1)
                });
                seen.remove(&id);
                self.ruby_flow.summaries.borrow_mut().insert(key, result.clone());
                if let Some(value) = result { return Some(with_receiver_reason(value, typed.reason.as_deref(), typed.loaded)); }
            }
        }
        if let Some(value) = self.ruby_types.factory(&typed.value, method, args, found.is_some_and(|id| !self.ruby_flow.generated.contains_key(&id))) {
            let loaded = self.ruby_types.requires_loaded_model(owner);
            let reason = format!("{}Rails single-record/query convention: {owner}.{method}", if loaded { "Loaded app model ancestry; " } else { "" });
            return Some(with_receiver_reason(RubyTyped { value, reason: Some(reason), loaded }, typed.reason.as_deref(), typed.loaded));
        }
        if singleton && method == "new" && found.is_none() && !self.ruby_inherited_classes.contains(owner) {
            return Some(with_receiver_reason(RubyTyped { value: RubyValue::Instance(owner.clone()), reason: Some(format!("Constructed receiver: {owner}.new")), loaded: false }, typed.reason.as_deref(), typed.loaded));
        }
        if !singleton {
            if let Some(value) = self.ruby_types.loaded_association(owner, method).filter(|_| !found.is_some_and(|id| !self.ruby_flow.generated.contains_key(&id))) {
                return Some(with_receiver_reason(RubyTyped { value, reason: Some(format!("Loaded app association: {owner}#{method}")), loaded: true }, typed.reason.as_deref(), typed.loaded));
            }
            let mut current = Some(owner.as_str());
            while let Some(at) = current {
                if self.ruby_methods.get(&(at.into(), false, method.into())).is_some_and(|ids| ids.iter().any(|id| !self.ruby_flow.generated.contains_key(id))) { break; }
                if let Some(value) = self.ruby_types.association(at, method) {
                    return Some(with_receiver_reason(RubyTyped { value, reason: Some(format!("Rails association: {at}#{method}")), loaded: false }, typed.reason.as_deref(), typed.loaded));
                }
                if let Some(ivar) = self.ruby_types.reader(at, method) {
                    if let Some(value) = self.ruby_ivar(at, false, ivar, seen, depth + 1) { return Some(with_receiver_reason(value, typed.reason.as_deref(), typed.loaded)); }
                }
                current = self.ruby_types.parent(at);
            }
        }
        if args.count == 0 && !args.block && !args.splat {
            let declared = found.is_some() || self.ruby_types.reader(owner, method).is_some();
            if matches!(receiver, RubyExpr::SelfValue) {
                if found.and_then(|id| self.ruby_flow.returns.get(&id)).is_some_and(|fact| ruby_known_scalar(&fact.expr)) { return None; }
                return self.ruby_named_hint(method, file, context, declared).map(|value| with_receiver_reason(value, typed.reason.as_deref(), typed.loaded));
            }
        }
        None
    }

    fn ruby_named_hint(&self, method: &str, file: usize, context: &RubyContext, declared: bool) -> Option<RubyTyped> {
        let suffix = method.strip_prefix("current_")?;
        if !declared && !(self.sources[file].path.starts_with("app/helpers/") && self.ruby_flow.helpers.contains(method)) { return None; }
        let raw = suffix.split('_').map(|part| {
            let mut chars = part.chars();
            chars.next().map(|c| c.to_uppercase().collect::<String>() + chars.as_str()).unwrap_or_default()
        }).collect::<String>();
        let owner = self.ruby_constant(&raw, &context.nesting)?;
        if !self.ruby_types.is_active_record(&owner) { return None; }
        let loaded = self.ruby_types.requires_loaded_model(&owner);
        Some(RubyTyped { value: RubyValue::Instance(owner.clone()), reason: Some(format!("{}Rails naming convention: `{method}` is treated as {owner}; runtime type is unverified", if loaded { "Loaded app model ancestry; " } else { "" })), loaded })
    }
}

fn ruby_symbol(text: &str) -> Option<String> {
    text.strip_prefix(':').filter(|s| !s.is_empty() && s.chars().all(|c| c.is_alphanumeric() || c == '_')).map(str::to_owned)
}

fn ruby_known_scalar(expr: &RubyExpr) -> bool {
    match expr {
        RubyExpr::Other | RubyExpr::Nil => true,
        RubyExpr::Alternatives(values) => values.iter().any(|v| matches!(v, RubyExpr::Other)) || (!values.is_empty() && values.iter().all(ruby_known_scalar)),
        _ => false,
    }
}

fn with_receiver_reason(mut value: RubyTyped, receiver: Option<&str>, loaded: bool) -> RubyTyped {
    value.loaded |= loaded;
    if let Some(receiver) = receiver {
        value.reason = Some(match value.reason {
            Some(reason) if reason == receiver => reason,
            Some(reason) => format!("{receiver}; {reason}"),
            None => receiver.to_owned(),
        });
    }
    value
}

fn ruby_returns_self(expr: &RubyExpr) -> bool {
    match expr {
        RubyExpr::SelfValue => true,
        RubyExpr::Alternatives(values) => !values.is_empty() && values.iter().all(|v| matches!(v, RubyExpr::Nil) || ruby_returns_self(v)) && values.iter().any(ruby_returns_self),
        _ => false,
    }
}
