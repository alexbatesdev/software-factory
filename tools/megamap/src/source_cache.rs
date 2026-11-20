use crate::{relationships::SourceFile, scan::{self, Entry, EntryKind}, syntax::HighlightedText};
use std::{collections::{HashMap, HashSet, VecDeque}, sync::Arc};

#[derive(Default)]
pub struct SourceCache {
    pub generation: u64,
    pub originals: HashMap<String, Arc<String>>,
    pub files: HashMap<usize, HighlightedText>,
    pub pending: HashSet<usize>,
    order: VecDeque<usize>,
    bytes: usize,
}

impl SourceCache {
    pub fn replace(&mut self, originals: HashMap<String, Arc<String>>) {
        self.generation = self.generation.wrapping_add(1);
        self.originals = originals;
        self.files.clear();
        self.pending.clear();
        self.order.clear();
        self.bytes = 0;
    }

    pub fn accept(&mut self, generation: u64, index: usize, text: HighlightedText) -> bool {
        if generation != self.generation { return false; }
        self.pending.remove(&index);
        self.bytes += text.lines.iter().map(|line| line.text.len()).sum::<usize>();
        self.files.insert(index, text);
        self.order.push_back(index);
        while self.files.len() > 64 || (self.bytes > 32 * 1024 * 1024 && self.files.len() > 1) {
            let Some(oldest) = self.order.pop_front() else { break };
            if let Some(old) = self.files.remove(&oldest) {
                self.bytes = self.bytes.saturating_sub(old.lines.iter().map(|line| line.text.len()).sum::<usize>());
            }
        }
        true
    }
}

pub fn prepare(sources: Vec<SourceFile>) -> (Vec<Entry>, HashMap<String, Arc<String>>) {
    let mut entries = Vec::with_capacity(sources.len());
    let mut originals = HashMap::with_capacity(sources.len());
    for source in sources {
        entries.push(Entry { path: source.path.clone(), ignored: false, kind: EntryKind::Text {
            bytes: source.text.len() as u64, lines: scan::summarize_lines(source.text.as_bytes()),
        } });
        originals.insert(source.path, Arc::new(source.text));
    }
    (entries, originals)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Tree;

    #[test]
    fn replacement_uses_matching_layout_and_text_and_rejects_old_worker_results() {
        let mut tree = Tree::new("fixture");
        let mut cache = SourceCache::default();
        let old = "class Worker\n def perform; record.old; end\nend\n";
        let new = "\n\nclass Worker\n def perform; record.new; end\nend\n";
        let (entries, originals) = prepare(vec![SourceFile { path: "worker.rb".into(), text: old.into() }]);
        for entry in entries { tree.insert(entry); }
        cache.replace(originals);
        let index = tree.find("worker.rb").unwrap();
        let old_generation = cache.generation;
        cache.pending.insert(index);
        assert!(cache.accept(old_generation, index, HighlightedText::new("worker.rb", old)));
        let (entries, originals) = prepare(vec![SourceFile { path: "worker.rb".into(), text: new.into() }]);
        for entry in entries { tree.insert(entry); }
        cache.replace(originals);
        cache.pending.insert(index);
        assert!(!cache.accept(old_generation, index, HighlightedText::new("worker.rb", old)));
        assert!(cache.pending.contains(&index));
        assert!(cache.files.is_empty());
        assert_eq!(tree.nodes[index].lines.len(), 5);
        let text = cache.originals["worker.rb"].clone();
        assert!(cache.accept(cache.generation, index, HighlightedText::new("worker.rb", &text)));
        assert_eq!(cache.files[&index].lines[3].text.trim(), "def perform; record.new; end");
        assert!(!cache.pending.contains(&index));
    }
}
