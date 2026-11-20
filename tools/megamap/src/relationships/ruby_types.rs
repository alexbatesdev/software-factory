use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum RubyValue {
    Class(String),
    Instance(String),
    Relation(String),
}

#[derive(Clone, Copy, Debug, Default)]
pub(super) struct RubyArgs {
    pub count: usize,
    pub array: bool,
    pub splat: bool,
    pub block: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum AssociationKind { BelongsTo, HasOne, HasMany }

#[derive(Clone)]
struct ConstantName { raw: String, nesting: Vec<String> }

struct Association {
    kind: AssociationKind,
    target: Option<ConstantName>,
}

#[derive(Default)]
pub(super) struct RubyTypes {
    classes: HashMap<String, Vec<ConstantName>>,
    loaded_models: HashSet<String>,
    loaded_targets: HashMap<(String, String), RubyValue>,
    parents: HashMap<String, Option<String>>,
    readers: HashMap<(String, String), Option<String>>,
    associations: HashMap<(String, String), Vec<Association>>,
    targets: HashMap<(String, String), RubyValue>,
}

impl RubyTypes {
    pub fn record_class(&mut self, owner: &str, parent: Option<&str>, nesting: &[String]) {
        let parents = self.classes.entry(owner.into()).or_default();
        if let Some(raw) = parent {
            parents.push(ConstantName { raw: raw.into(), nesting: nesting.to_vec() });
        }
    }

    pub fn record_reader(&mut self, owner: &str, name: &str, ivar: &str) {
        self.readers.entry((owner.into(), name.into()))
            .and_modify(|value| { if value.as_deref() != Some(ivar) { *value = None; } })
            .or_insert_with(|| Some(ivar.into()));
    }

    pub fn reader(&self, owner: &str, name: &str) -> Option<&str> {
        self.readers.get(&(owner.into(), name.into()))?.as_deref()
    }

    pub fn record_association(&mut self, owner: &str, name: &str, kind: AssociationKind,
        class_name: Option<&str>, unsupported: bool, nesting: &[String]) {
        let raw = class_name.map(str::to_owned).unwrap_or_else(|| {
            let singular = if kind == AssociationKind::HasMany { singular(name) } else { name.into() };
            singular.split('_').map(|part| {
                let mut chars = part.chars();
                chars.next().map(|first| first.to_uppercase().collect::<String>() + chars.as_str()).unwrap_or_default()
            }).collect::<String>()
        });
        let target = (!unsupported && !raw.is_empty()).then(|| ConstantName { raw, nesting: nesting.to_vec() });
        self.associations.entry((owner.into(), name.into())).or_default().push(Association { kind, target });
    }

    /// The resolver explicitly accepts the external ActiveRecord::Base root after checking shadowing.
    pub fn resolve(&mut self, resolve: impl Fn(&str, &[String]) -> Option<String>) {
        self.parents.clear();
        self.targets.clear();
        for (owner, declarations) in &self.classes {
            let values: Option<HashSet<String>> = declarations.iter().map(|parent| resolve(&parent.raw, &parent.nesting)).collect();
            let parent = values.filter(|values| values.len() == 1).and_then(|values| values.into_iter().next());
            self.parents.insert(owner.clone(), parent);
        }
        for (key, declarations) in &self.associations {
            if declarations.len() != 1 || !self.is_active_record(&key.0) { continue; }
            let declaration = &declarations[0];
            let Some(target) = &declaration.target else { continue };
            let Some(owner) = resolve(&target.raw, &target.nesting) else { continue };
            if !self.classes.contains_key(&owner) || !self.is_active_record(&owner) { continue; }
            let value = if declaration.kind == AssociationKind::HasMany { RubyValue::Relation(owner) } else { RubyValue::Instance(owner) };
            self.targets.insert(key.clone(), value);
        }
    }

    pub fn load_model(&mut self, owner: &str) { self.loaded_models.insert(owner.into()); }

    pub fn load_association(&mut self, owner: &str, name: &str, target: &str, collection: bool) {
        let value = if collection { RubyValue::Relation(target.into()) } else { RubyValue::Instance(target.into()) };
        self.loaded_targets.insert((owner.into(), name.into()), value);
    }

    pub fn loaded_association(&self, owner: &str, name: &str) -> Option<RubyValue> {
        self.loaded_targets.get(&(owner.into(), name.into())).cloned()
    }

    pub fn is_active_record(&self, owner: &str) -> bool {
        self.loaded_models.contains(owner) || self.source_active_record(owner)
    }

    pub fn requires_loaded_model(&self, owner: &str) -> bool {
        self.loaded_models.contains(owner) && !self.source_active_record(owner)
    }

    fn source_active_record(&self, owner: &str) -> bool {
        let mut current = owner;
        let mut seen = HashSet::new();
        loop {
            if !seen.insert(current) { return false; }
            let Some(Some(parent)) = self.parents.get(current) else { return false };
            if parent == "ActiveRecord::Base" { return true; }
            current = parent;
        }
    }

    pub fn parent(&self, owner: &str) -> Option<&str> {
        let first = self.parents.get(owner)?.as_deref()?;
        let mut current = owner;
        let mut seen = HashSet::new();
        while let Some(Some(parent)) = self.parents.get(current) {
            if !seen.insert(current) { return None; }
            current = parent;
        }
        Some(first)
    }

    pub fn association(&self, owner: &str, name: &str) -> Option<RubyValue> {
        self.targets.get(&(owner.into(), name.into())).cloned()
    }

    /// Results are labeled Rails conventions, including the single dynamic ID assumption for find.
    pub fn factory(&self, receiver: &RubyValue, method: &str, args: RubyArgs, overridden: bool) -> Option<RubyValue> {
        let owner = match receiver { RubyValue::Class(owner) | RubyValue::Relation(owner) => owner, _ => return None };
        if overridden || args.block || args.splat || !self.is_active_record(owner) { return None; }
        let instance = match method {
            "new" | "build" | "create" | "create!" => !args.array && args.count <= 1,
            "find" => !args.array && args.count == 1,
            "find_by" | "find_by!" | "find_or_create_by" | "find_or_create_by!" | "find_or_initialize_by" => !args.array && args.count == 1,
            "first" | "last" | "take" | "first!" | "last!" | "take!" => args.count == 0,
            "first_or_create" | "first_or_create!" | "first_or_initialize" => matches!(receiver, RubyValue::Relation(_)) && !args.array && args.count <= 1,
            _ => false,
        };
        if instance { return Some(RubyValue::Instance(owner.clone())); }
        let relation = match method {
            "all" | "none" => args.count == 0,
            "where" | "includes" | "preload" | "eager_load" | "joins" | "left_joins" | "left_outer_joins" |
            "references" | "order" | "reorder" | "select" | "reselect" | "group" | "having" | "limit" |
            "offset" | "unscope" | "except" | "only" | "annotate" => args.count > 0,
            "distinct" | "readonly" | "lock" => args.count <= 1,
            _ => false,
        };
        relation.then(|| RubyValue::Relation(owner.clone()))
    }
}

fn singular(name: &str) -> String {
    if let Some(prefix) = name.strip_suffix("people") { return format!("{prefix}person"); }
    if let Some(prefix) = name.strip_suffix("children") { return format!("{prefix}child"); }
    if let Some(prefix) = name.strip_suffix("ies") { return format!("{prefix}y"); }
    if let Some(prefix) = name.strip_suffix("sses") { return format!("{prefix}ss"); }
    if name.ends_with('s') && !name.ends_with("ss") { return name[..name.len() - 1].into(); }
    name.into()
}
