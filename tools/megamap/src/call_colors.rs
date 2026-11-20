use crate::{evidence::EvidenceKind, relationships::{CallEdge, SymbolRef}, syntax::HighlightedLine};
use std::collections::{BTreeMap, HashMap, HashSet};

pub const PLAIN: [f32; 3] = [0.79, 0.82, 0.86];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallMark {
    pub start: usize,
    pub end: usize,
    pub target: String,
    pub definition: SymbolRef,
    pub inference: Option<String>,
    pub evidence: EvidenceKind,
}

#[derive(Default)]
pub struct CallHighlights {
    files: HashMap<String, BTreeMap<usize, Vec<CallMark>>>,
}

impl CallHighlights {
    pub fn new(edges: &[CallEdge], visible: &HashSet<String>) -> Self {
        let mut result = Self::default();
        for edge in edges {
            if edge.caller.file == edge.callee.file || edge.start_column >= edge.end_column
                || !visible.contains(&edge.caller.file) || !visible.contains(&edge.callee.file) { continue; }
            result.files.entry(edge.caller.file.clone()).or_default().entry(edge.line).or_default().push(CallMark {
                start: edge.start_column, end: edge.end_column, target: edge.callee.file.clone(), definition: edge.callee.clone(),
                inference: edge.inference.clone(),
                evidence: edge.evidence,
            });
        }
        for lines in result.files.values_mut() {
            for marks in lines.values_mut() {
                marks.sort_by(|a, b| (a.start, a.end, &a.target, &a.definition.name, &a.definition.file, a.definition.line, std::cmp::Reverse(a.evidence), &a.inference)
                    .cmp(&(b.start, b.end, &b.target, &b.definition.name, &b.definition.file, b.definition.line, std::cmp::Reverse(b.evidence), &b.inference)));
                marks.dedup_by(|a, b| a.start == b.start && a.end == b.end && a.definition == b.definition);
            }
        }
        result
    }

    pub fn line(&self, file: &str, line: usize) -> &[CallMark] {
        self.files.get(file).and_then(|lines| lines.get(&line)).map_or(&[], Vec::as_slice)
    }

    pub fn site_count(&self) -> usize {
        self.files.values().flat_map(|lines| lines.values()).map(Vec::len).sum()
    }

    pub fn inferred_site_count(&self) -> usize {
        self.evidence_site_count(EvidenceKind::Inferred)
    }

    pub fn evidence_site_count(&self, kind: EvidenceKind) -> usize {
        self.files.values().flat_map(|lines| lines.values()).flatten().filter(|mark| mark.evidence == kind).count()
    }

    pub fn connections(&self, file: &str) -> Vec<(usize, &CallMark)> {
        self.files.get(file).into_iter().flat_map(|lines| lines.iter())
            .flat_map(|(&line, marks)| marks.iter().map(move |mark| (line, mark))).collect()
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct LinkRange<'a> {
    pub start: usize,
    pub end: usize,
    pub definition: &'a SymbolRef,
    pub inference: Option<&'a str>,
    pub evidence: EvidenceKind,
}

fn marked_columns(marks: &[CallMark], columns: usize) -> (Vec<Option<&CallMark>>, Vec<bool>) {
    let mut result: Vec<Option<&CallMark>> = vec![None; columns];
    let mut ambiguous = vec![false; columns];
    for mark in marks {
        for column in mark.start.min(columns)..mark.end.min(columns) {
            if result[column].is_some_and(|previous| previous.definition != mark.definition) {
                ambiguous[column] = true;
            }
            if result[column].is_some_and(|previous| previous.definition == mark.definition && (previous.evidence > mark.evidence || (previous.evidence == mark.evidence && previous.inference.is_some() && mark.inference.is_none()))) {
                continue;
            }
            result[column] = Some(mark);
        }
    }
    for (mark, &ambiguous) in result.iter_mut().zip(&ambiguous) {
        if ambiguous { *mark = None; }
    }
    (result, ambiguous)
}

/// Columns count rendered Unicode scalar values and each end is exclusive.
pub fn link_ranges(marks: &[CallMark], columns: usize) -> Vec<LinkRange<'_>> {
    if marks.is_empty() { return Vec::new(); }
    let (marked, _) = marked_columns(marks, columns);
    let mut result: Vec<LinkRange<'_>> = Vec::new();
    for (column, mark) in marked.into_iter().enumerate() {
        let Some(mark) = mark else { continue };
        if let Some(previous) = result.last_mut().filter(|previous| previous.end == column && *previous.definition == mark.definition && previous.inference == mark.inference.as_deref() && previous.evidence == mark.evidence) {
            previous.end = column + 1;
        } else {
            result.push(LinkRange { start: column, end: column + 1, definition: &mark.definition, inference: mark.inference.as_deref(), evidence: mark.evidence });
        }
    }
    result
}

pub fn file_rgb(path: &str, root: Option<&str>) -> [f32; 3] {
    if root == Some(path) { return [0.95, 0.73, 0.24]; }
    let hash = path.bytes().fold(2166136261u32, |hash, byte| (hash ^ byte as u32).wrapping_mul(16777619));
    let hue = (hash % 3600) as f32 / 600.0;
    let fraction = hue.fract();
    let value = 0.96;
    let minimum = value * 0.32;
    let falling = value * (1.0 - fraction * 0.68);
    let rising = value * (0.32 + fraction * 0.68);
    match hue as usize {
        0 => [value, rising, minimum],
        1 => [falling, value, minimum],
        2 => [minimum, value, rising],
        3 => [minimum, falling, value],
        4 => [rising, minimum, value],
        _ => [value, minimum, falling],
    }
}

pub struct PaintedRun<'a> {
    pub text: &'a str,
    pub color: [f32; 3],
}

pub fn paint_line<'a>(line: &'a HighlightedLine, marks: &[CallMark], root: Option<&str>, syntax: bool, columns: usize) -> Vec<PaintedRun<'a>> {
    if marks.is_empty() {
        if syntax {
            return line.clipped_spans(columns).map(|run| PaintedRun { text: run.text, color: run.category.rgb() }).collect();
        }
        let end = line.text.char_indices().nth(columns).map_or(line.text.len(), |(byte, _)| byte);
        return if end == 0 { Vec::new() } else { vec![PaintedRun { text: &line.text[..end], color: PLAIN }] };
    }
    let mut bytes: Vec<usize> = line.text.char_indices().take(columns).map(|(byte, _)| byte).collect();
    let end = line.text.char_indices().nth(columns).map_or(line.text.len(), |(byte, _)| byte);
    bytes.push(end);
    let length = bytes.len().saturating_sub(1);
    if length == 0 { return Vec::new(); }
    let mut colors = vec![PLAIN; length];
    if syntax {
        let mut column = 0;
        for run in line.clipped_spans(columns) {
            let end = column + run.text.chars().count();
            for color in &mut colors[column..end] { *color = run.category.rgb(); }
            column = end;
        }
    }
    let (marked, ambiguous) = marked_columns(marks, length);
    for (column, mark) in marked.into_iter().enumerate() {
        if let Some(mark) = mark { colors[column] = file_rgb(&mark.target, root); }
        else if ambiguous[column] { colors[column] = PLAIN; }
    }
    let mut runs = Vec::new();
    let mut start = 0;
    for column in 1..=length {
        if column == length || colors[column] != colors[start] {
            runs.push(PaintedRun { text: &line.text[bytes[start]..bytes[column]], color: colors[start] });
            start = column;
        }
    }
    runs
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::syntax::HighlightedText;

    fn mark(start: usize, end: usize, file: &str, name: &str, line: usize) -> CallMark {
        CallMark { start, end, target: file.into(), definition: SymbolRef { name: name.into(), file: file.into(), line }, inference: None, evidence: EvidenceKind::Source }
    }

    #[test]
    fn neutral_text_only_colors_exact_cross_file_calls() {
        let text = HighlightedText::new("a.ts", "const result = run(); // run is a name here");
        let mark = mark(15, 18, "b.ts", "run", 4);
        let runs = paint_line(&text.lines[0], &[mark], Some("a.ts"), false, 100);
        assert_eq!(runs.iter().map(|run| run.text).collect::<String>(), text.lines[0].text);
        let colored: Vec<_> = runs.iter().filter(|run| run.color != PLAIN).collect();
        assert_eq!(colored.len(), 1);
        assert_eq!(colored[0].text, "run");
        assert_eq!(colored[0].color, file_rgb("b.ts", Some("a.ts")));
    }

    #[test]
    fn unicode_tabs_and_clipping_keep_the_original_display_text() {
        let text = HighlightedText::new("a.rb", "\té = B.run\r\n");
        let marks = [mark(10, 13, "b.rb", "run", 4)];
        for limit in 0..=20 {
            let runs = paint_line(&text.lines[0], &marks, None, false, limit);
            assert_eq!(runs.iter().map(|run| run.text).collect::<String>(), text.lines[0].text.chars().take(limit).collect::<String>());
        }
    }

    #[test]
    fn hidden_targets_and_same_file_calls_have_no_color_marks() {
        let symbol = |file: &str| SymbolRef { name: "run".into(), file: file.into(), line: 1 };
        let edge = |target: &str| CallEdge { caller: symbol("a.ts"), callee: symbol(target), line: 1, start_column: 0, end_column: 3, inference: None, evidence: EvidenceKind::Source };
        let visible = HashSet::from(["a.ts".into(), "b.ts".into()]);
        let marks = CallHighlights::new(&[edge("b.ts"), edge("b.ts"), edge("hidden.ts"), edge("a.ts")], &visible);
        assert_eq!(marks.site_count(), 1);
        assert_eq!(marks.line("a.ts", 1)[0].target, "b.ts");
    }

    #[test]
    fn syntax_is_opt_in_and_ambiguous_targets_stay_neutral() {
        let text = HighlightedText::new("a.ts", "return run()");
        assert!(paint_line(&text.lines[0], &[], None, false, 100).iter().all(|run| run.color == PLAIN));
        assert!(paint_line(&text.lines[0], &[], None, true, 100).iter().any(|run| run.color != PLAIN));
        let marks = [mark(7, 10, "b.ts", "run", 4), mark(7, 10, "c.ts", "run", 8)];
        assert!(paint_line(&text.lines[0], &marks, None, false, 100).iter().all(|run| run.color == PLAIN));
    }

    #[test]
    fn distinct_definitions_in_one_file_never_choose_a_destination() {
        let text = HighlightedText::new("a.ts", "return run()");
        for alternate in [mark(7, 10, "b.ts", "run", 8), mark(7, 10, "b.ts", "other", 4)] {
            let marks = [mark(7, 10, "b.ts", "run", 4), alternate];
            assert!(link_ranges(&marks, 100).is_empty());
            assert!(paint_line(&text.lines[0], &marks, None, true, 100).iter().any(|run| run.text == "run" && run.color == PLAIN));
        }
    }

    #[test]
    fn exact_duplicates_keep_one_definition_and_distinct_definitions_are_retained() {
        let caller = SymbolRef { name: "caller".into(), file: "a.ts".into(), line: 1 };
        let first = mark(0, 3, "b.ts", "run", 4);
        let second = mark(0, 3, "b.ts", "run", 8);
        let edge = |mark: &CallMark| CallEdge { caller: caller.clone(), callee: mark.definition.clone(), line: 2, start_column: mark.start, end_column: mark.end, inference: mark.inference.clone(), evidence: mark.evidence };
        let visible = HashSet::from(["a.ts".into(), "b.ts".into()]);
        let highlights = CallHighlights::new(&[edge(&first), edge(&second), edge(&first)], &visible);
        assert_eq!(highlights.site_count(), 2);
        assert!(link_ranges(highlights.line("a.ts", 2), 3).is_empty());
        let marks = [first.clone(), first];
        assert_eq!(link_ranges(&marks, 3), vec![LinkRange { start: 0, end: 3, definition: &marks[0].definition, inference: None, evidence: EvidenceKind::Source }]);
    }

    #[test]
    fn links_clip_rendered_unicode_columns_and_exclude_overlap_and_boundaries() {
        let text = HighlightedText::new("a.rb", "\té = B.run");
        let marks = [mark(10, 13, "b.rb", "run", 4), mark(11, 12, "b.rb", "other", 8), mark(2, 2, "b.rb", "empty", 1), mark(8, 3, "b.rb", "backward", 1)];
        let ranges = link_ranges(&marks, 12);
        assert_eq!(ranges, vec![LinkRange { start: 10, end: 11, definition: &marks[0].definition, inference: None, evidence: EvidenceKind::Source }]);
        assert_eq!(text.lines[0].text.chars().skip(ranges[0].start).take(ranges[0].end - ranges[0].start).collect::<String>(), "r");
        assert!(link_ranges(&marks, 10).is_empty());
        assert!(link_ranges(&marks, 0).is_empty());
        assert_eq!(link_ranges(&marks, 13), vec![LinkRange { start: 10, end: 11, definition: &marks[0].definition, inference: None, evidence: EvidenceKind::Source }, LinkRange { start: 12, end: 13, definition: &marks[0].definition, inference: None, evidence: EvidenceKind::Source }]);
    }

    #[test]
    fn inferred_calls_keep_destination_colors_reasons_and_visible_site_counts() {
        let reason = "Rails belongs_to association";
        let caller = SymbolRef { name: "caller".into(), file: "a.rb".into(), line: 1 };
        let edge = |file: &str, inference: Option<&str>| CallEdge {
            caller: caller.clone(), callee: SymbolRef { name: "run".into(), file: file.into(), line: 8 },
            line: 1, start_column: 0, end_column: 3, inference: inference.map(str::to_owned), evidence: if inference.is_some() { EvidenceKind::Inferred } else { EvidenceKind::Source },
        };
        let visible = HashSet::from(["a.rb".into(), "b.rb".into()]);
        let highlights = CallHighlights::new(&[edge("b.rb", Some(reason)), edge("hidden.rb", Some(reason)), edge("a.rb", Some(reason))], &visible);
        assert_eq!(highlights.site_count(), 1);
        assert_eq!(highlights.inferred_site_count(), 1);
        let marks = highlights.line("a.rb", 1);
        assert_eq!(link_ranges(marks, 100)[0].inference, Some(reason));
        let text = HighlightedText::new("a.rb", "run()");
        assert!(paint_line(&text.lines[0], marks, None, true, 100).iter().any(|run| run.text == "run" && run.color == file_rgb("b.rb", None)));

        let exact = mark(0, 3, "b.rb", "run", 8);
        for marks in [vec![marks[0].clone(), exact.clone()], vec![exact, marks[0].clone()]] {
            assert_eq!(link_ranges(&marks, 100)[0].inference, Some(reason));
        }
    }

    #[test]
    fn inferred_alternative_definitions_remain_neutral_and_unclickable() {
        let mut inferred = mark(7, 10, "b.rb", "run", 8);
        inferred.inference = Some("Inferred receiver type".into());
        inferred.evidence = EvidenceKind::Inferred;
        let marks = [mark(7, 10, "b.rb", "run", 4), inferred];
        let text = HighlightedText::new("a.rb", "return run()");
        assert!(link_ranges(&marks, 100).is_empty());
        assert!(paint_line(&text.lines[0], &marks, None, true, 100).iter().any(|run| run.text == "run" && run.color == PLAIN));
    }

    #[test]
    fn observed_provenance_counts_one_site_and_keeps_ambiguous_definitions_unclickable() {
        let caller = SymbolRef { name: "caller".into(), file: "a.rb".into(), line: 1 };
        let edge = |kind, file: &str| CallEdge {
            caller: caller.clone(), callee: SymbolRef { name: "run".into(), file: file.into(), line: 8 },
            line: 2, start_column: 0, end_column: 3,
            inference: (kind != EvidenceKind::Source).then(|| "capture example".into()), evidence: kind,
        };
        let visible = HashSet::from(["a.rb".into(), "b.rb".into(), "c.rb".into()]);
        let observed = edge(EvidenceKind::Observed, "b.rb");
        let marks = CallHighlights::new(&[edge(EvidenceKind::Source, "b.rb"), observed.clone()], &visible);
        assert_eq!(marks.site_count(), 1);
        assert_eq!(marks.inferred_site_count(), 0);
        assert_eq!(marks.evidence_site_count(EvidenceKind::Observed), 1);
        assert_eq!(link_ranges(marks.line("a.rb", 2), 20)[0].evidence, EvidenceKind::Observed);
        let ambiguous = CallHighlights::new(&[observed, edge(EvidenceKind::Inferred, "c.rb")], &visible);
        assert!(link_ranges(ambiguous.line("a.rb", 2), 20).is_empty());
    }
}
