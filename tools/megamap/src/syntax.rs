use std::{cell::RefCell, ops::Range, path::Path, sync::OnceLock};
use tree_sitter_highlight::{HighlightConfiguration, HighlightEvent, Highlighter};

const MAX_HIGHLIGHT_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Category {
    Plain,
    Keyword,
    String,
    Comment,
    Number,
    Type,
    Function,
    Variable,
    Operator,
    Punctuation,
}

impl Category {
    pub fn rgb(self) -> [f32; 3] {
        let hex = match self {
            Self::Plain => 0xc9d1d9,
            Self::Keyword => 0xff7b72,
            Self::String => 0xa5d6ff,
            Self::Comment => 0x8b949e,
            Self::Number => 0x79c0ff,
            Self::Type => 0xffa657,
            Self::Function => 0xd2a8ff,
            Self::Variable => 0xe6edf3,
            Self::Operator => 0xff7b72,
            Self::Punctuation => 0xb1bac4,
        };
        [
            ((hex >> 16) & 255) as f32 / 255.0,
            ((hex >> 8) & 255) as f32 / 255.0,
            (hex & 255) as f32 / 255.0,
        ]
    }

    fn capture(name: &str) -> Self {
        match name.split('.').next().unwrap_or(name) {
            "keyword" | "boolean" => Self::Keyword,
            "string" | "escape" => Self::String,
            "comment" => Self::Comment,
            "number" => Self::Number,
            "type" | "constructor" | "tag" => Self::Type,
            "function" => Self::Function,
            "variable" | "property" | "attribute" | "constant" => Self::Variable,
            "operator" => Self::Operator,
            "punctuation" => Self::Punctuation,
            _ => Self::Plain,
        }
    }
}

#[derive(Debug)]
pub struct HighlightSpan {
    pub columns: Range<usize>,
    pub bytes: Range<usize>,
    pub category: Category,
}

#[derive(Debug, Default)]
pub struct HighlightedLine {
    pub text: String,
    pub spans: Vec<HighlightSpan>,
}

#[derive(Debug)]
pub struct HighlightRun<'a> {
    pub text: &'a str,
    pub category: Category,
}

impl HighlightedLine {
    /// Columns count Unicode scalar values, matching the map's character clipping.
    pub fn clipped_spans(&self, max_columns: usize) -> impl Iterator<Item = HighlightRun<'_>> {
        self.spans
            .iter()
            .take_while(move |span| span.columns.start < max_columns)
            .map(move |span| {
                let text = &self.text[span.bytes.clone()];
                let remaining = max_columns - span.columns.start;
                let end = if remaining >= span.columns.len() {
                    text.len()
                } else {
                    text.char_indices()
                        .nth(remaining)
                        .map_or(text.len(), |(byte, _)| byte)
                };
                HighlightRun {
                    text: &text[..end],
                    category: span.category,
                }
            })
    }

    fn push(&mut self, character: char, category: Category) {
        let start = self.text.len();
        let width = if character == '\t' { 4 } else { 1 };
        if character == '\t' {
            self.text.push_str("    ");
        } else {
            self.text.push(character);
        }
        let column = self.spans.last().map_or(0, |span| span.columns.end);
        if let Some(span) = self.spans.last_mut().filter(|span| span.category == category) {
            span.columns.end += width;
            span.bytes.end = self.text.len();
        } else {
            self.spans.push(HighlightSpan {
                columns: column..column + width,
                bytes: start..self.text.len(),
                category,
            });
        }
    }
}

#[derive(Debug)]
pub struct HighlightedText {
    pub lines: Vec<HighlightedLine>,
}

impl HighlightedText {
    pub fn from_bytes(path: &str, bytes: &[u8]) -> Self {
        Self::new(path, &String::from_utf8_lossy(bytes))
    }

    /// Unsupported languages and files above 2 MiB retain all text in the plain palette.
    pub fn new(path: &str, text: &str) -> Self {
        let source_spans = if text.len() <= MAX_HIGHLIGHT_BYTES {
            configuration(path).and_then(|config| highlight(config, text))
        } else {
            None
        }
        .unwrap_or_default();
        let mut span_index = 0;
        let mut offset = 0;
        let mut lines = Vec::new();
        for raw in text.split_inclusive('\n') {
            let body = raw.strip_suffix('\n').map_or(raw, |line| {
                line.strip_suffix('\r').unwrap_or(line)
            });
            let mut line = HighlightedLine::default();
            for (byte, character) in body.char_indices() {
                let position = offset + byte;
                while source_spans
                    .get(span_index)
                    .is_some_and(|span| span.bytes.end <= position)
                {
                    span_index += 1;
                }
                let category = source_spans
                    .get(span_index)
                    .filter(|span| span.bytes.contains(&position))
                    .map_or(Category::Plain, |span| span.category);
                line.push(character, category);
            }
            lines.push(line);
            offset += raw.len();
        }
        Self { lines }
    }
}

struct Configuration {
    engine: HighlightConfiguration,
    categories: Vec<Category>,
}

fn configuration(path: &str) -> Option<&'static Configuration> {
    static RUBY: OnceLock<Option<Configuration>> = OnceLock::new();
    static JAVASCRIPT: OnceLock<Option<Configuration>> = OnceLock::new();
    static TYPESCRIPT: OnceLock<Option<Configuration>> = OnceLock::new();
    static TSX: OnceLock<Option<Configuration>> = OnceLock::new();
    let path = Path::new(path);
    let extension = path.extension().and_then(|extension| extension.to_str());
    let ruby_name = path.file_name().and_then(|name| name.to_str()).is_some_and(|name| {
        matches!(name, "Gemfile" | "Rakefile" | "Guardfile" | "Brewfile" | "Podfile")
    });
    let config = match extension {
        Some("rb" | "rake" | "gemspec" | "ru") => RUBY.get_or_init(ruby_configuration),
        Some("js" | "jsx" | "mjs" | "cjs") => JAVASCRIPT.get_or_init(|| {
            make_configuration(
                tree_sitter_javascript::LANGUAGE.into(),
                "javascript",
                &format!(
                    "{}\n{}",
                    tree_sitter_javascript::HIGHLIGHT_QUERY,
                    tree_sitter_javascript::JSX_HIGHLIGHT_QUERY
                ),
                tree_sitter_javascript::LOCALS_QUERY,
            )
        }),
        Some("ts" | "mts" | "cts") => TYPESCRIPT.get_or_init(|| {
            make_configuration(
                tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
                "typescript",
                &format!(
                    "{}\n{}",
                    tree_sitter_javascript::HIGHLIGHT_QUERY,
                    tree_sitter_typescript::HIGHLIGHTS_QUERY
                ),
                &format!(
                    "{}\n{}",
                    tree_sitter_javascript::LOCALS_QUERY,
                    tree_sitter_typescript::LOCALS_QUERY
                ),
            )
        }),
        Some("tsx") => TSX.get_or_init(|| {
            make_configuration(
                tree_sitter_typescript::LANGUAGE_TSX.into(),
                "tsx",
                &format!(
                    "{}\n{}\n{}",
                    tree_sitter_javascript::HIGHLIGHT_QUERY,
                    tree_sitter_javascript::JSX_HIGHLIGHT_QUERY,
                    tree_sitter_typescript::HIGHLIGHTS_QUERY
                ),
                tree_sitter_javascript::LOCALS_QUERY,
            )
        }),
        _ if ruby_name => RUBY.get_or_init(ruby_configuration),
        _ => return None,
    };
    config.as_ref()
}

fn ruby_configuration() -> Option<Configuration> {
    make_configuration(
        tree_sitter_ruby::LANGUAGE.into(),
        "ruby",
        tree_sitter_ruby::HIGHLIGHTS_QUERY,
        tree_sitter_ruby::LOCALS_QUERY,
    )
}

fn make_configuration(
    language: tree_sitter::Language,
    name: &str,
    highlights: &str,
    locals: &str,
) -> Option<Configuration> {
    let mut engine = HighlightConfiguration::new(language, name, highlights, "", locals).ok()?;
    let names: Vec<String> = engine.names().iter().map(|name| (*name).to_owned()).collect();
    let categories = names.iter().map(|name| Category::capture(name)).collect();
    engine.configure(&names);
    Some(Configuration { engine, categories })
}

struct SourceSpan {
    bytes: Range<usize>,
    category: Category,
}

fn highlight(config: &Configuration, text: &str) -> Option<Vec<SourceSpan>> {
    thread_local! {
        static HIGHLIGHTER: RefCell<Highlighter> = RefCell::new(Highlighter::new());
    }
    HIGHLIGHTER.with(|highlighter| {
        let mut highlighter = highlighter.borrow_mut();
        let events = highlighter.highlight(&config.engine, text.as_bytes(), None, |_| None).ok()?;
        let mut stack = Vec::new();
        let mut spans = Vec::new();
        for event in events {
            match event.ok()? {
                HighlightEvent::HighlightStart(highlight) => {
                    stack.push(config.categories[highlight.0]);
                }
                HighlightEvent::HighlightEnd => {
                    stack.pop();
                }
                HighlightEvent::Source { start, end } => spans.push(SourceSpan {
                    bytes: start..end,
                    category: stack.last().copied().unwrap_or(Category::Plain),
                }),
            }
        }
        Some(spans)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn category_at(line: &HighlightedLine, needle: &str) -> Category {
        let byte = line.text.find(needle).unwrap();
        line.spans.iter().find(|span| span.bytes.contains(&byte)).unwrap().category
    }

    fn assert_reconstruction(path: &str, source: &str) -> HighlightedText {
        let highlighted = HighlightedText::new(path, source);
        let expected: Vec<_> = source.lines().map(|line| line.replace('\t', "    ")).collect();
        let actual: Vec<_> = highlighted.lines.iter().map(|line| {
            let runs: Vec<_> = line.clipped_spans(usize::MAX).collect();
            let mut column = 0;
            for span in &line.spans {
                assert_eq!(span.columns.start, column);
                column = span.columns.end;
            }
            runs.iter().map(|run| run.text).collect::<String>()
        }).collect();
        assert_eq!(actual, expected);
        highlighted
    }

    #[test]
    fn non_utf8_source_keeps_its_readable_text() {
        let source = b"// caf\xe9\nconst result = 'ready';\n";
        let text = HighlightedText::from_bytes("legacy.js", source);
        assert_eq!(text.lines[0].text, "// caf\u{fffd}");
        assert_eq!(text.lines[1].text, "const result = 'ready';");
        assert_eq!(category_at(&text.lines[1], "const"), Category::Keyword);
    }

    #[test]
    fn ruby_tokens_receive_their_palettes() {
        let source = "class Example\n\tdef greet(name)\n\t\tputs \"hello\", 42 # note\n\tend\nend\n";
        let highlighted = assert_reconstruction("lib/example.rb", source);
        assert_eq!(category_at(&highlighted.lines[0], "class"), Category::Keyword);
        assert_eq!(category_at(&highlighted.lines[0], "Example"), Category::Type);
        assert_eq!(category_at(&highlighted.lines[1], "greet"), Category::Function);
        assert_eq!(category_at(&highlighted.lines[2], "\"hello\""), Category::String);
        assert_eq!(category_at(&highlighted.lines[2], "42"), Category::Number);
        assert_eq!(category_at(&highlighted.lines[2], "# note"), Category::Comment);
        assert_ne!(Category::Keyword.rgb(), Category::Plain.rgb());
        assert_ne!(Category::String.rgb(), Category::Comment.rgb());
    }

    #[test]
    fn typescript_keeps_javascript_tokens_and_typescript_types() {
        let source = "interface Person { name: string }\nconst greet = (name: string): number => 42; // note\n";
        let highlighted = assert_reconstruction("src/example.ts", source);
        assert_eq!(category_at(&highlighted.lines[0], "interface"), Category::Keyword);
        assert_eq!(category_at(&highlighted.lines[0], "Person"), Category::Type);
        assert_eq!(category_at(&highlighted.lines[0], "string"), Category::Type);
        assert_eq!(category_at(&highlighted.lines[1], "const"), Category::Keyword);
        assert_eq!(category_at(&highlighted.lines[1], "greet"), Category::Function);
        assert_eq!(category_at(&highlighted.lines[1], "42"), Category::Number);
        assert_eq!(category_at(&highlighted.lines[1], "// note"), Category::Comment);
    }

    #[test]
    fn tsx_and_javascript_use_their_grammar_queries() {
        let tsx = assert_reconstruction("view.tsx", "const View = (name: string) => <div title=\"hello\">{name}</div>;\n");
        assert_eq!(category_at(&tsx.lines[0], "const"), Category::Keyword);
        assert_eq!(category_at(&tsx.lines[0], "string"), Category::Type);
        assert_eq!(category_at(&tsx.lines[0], "div"), Category::Type);
        assert_eq!(category_at(&tsx.lines[0], "\"hello\""), Category::String);
        let js = assert_reconstruction("example.js", "function greet(name) { return \"hello\" + 42; } // note");
        assert_eq!(category_at(&js.lines[0], "function"), Category::Keyword);
        assert_eq!(category_at(&js.lines[0], "greet"), Category::Function);
        assert_eq!(category_at(&js.lines[0], "42"), Category::Number);
        assert_eq!(category_at(&js.lines[0], "// note"), Category::Comment);
    }

    #[test]
    fn comments_and_strings_keep_their_style_across_lines() {
        let js = assert_reconstruction("example.js", "/* first\r\nsecond */\r\nconst s = `hello\r\nworld`;\r\n");
        assert_eq!(category_at(&js.lines[1], "second"), Category::Comment);
        assert_eq!(category_at(&js.lines[3], "world"), Category::String);
        let ruby = assert_reconstruction("example.rb", "message = <<~TEXT\n  hello\n  world\nTEXT\n");
        assert_eq!(category_at(&ruby.lines[1], "hello"), Category::String);
        assert_eq!(category_at(&ruby.lines[2], "world"), Category::String);
    }

    #[test]
    fn unicode_clipping_uses_columns_and_keeps_valid_text() {
        let source = "\tconst café = \"🙂界e\u{301}\"; // café";
        let highlighted = assert_reconstruction("unicode.js", source);
        let line = &highlighted.lines[0];
        for limit in 0..=line.text.chars().count() + 1 {
            let actual: String = line.clipped_spans(limit).map(|run| run.text).collect();
            let expected: String = line.text.chars().take(limit).collect();
            assert_eq!(actual, expected, "column limit {limit}");
        }
        assert_eq!(category_at(line, "\"🙂界"), Category::String);
        assert_eq!(category_at(line, "// café"), Category::Comment);
    }

    #[test]
    fn unsupported_languages_and_large_files_keep_all_text() {
        for source in ["", "\n", "one\r\ntwo\n\n", "one\rtwo", "\t界🙂\nend"] {
            let highlighted = assert_reconstruction("settings.yml", source);
            assert!(highlighted.lines.iter().flat_map(|line| &line.spans).all(|span| span.category == Category::Plain));
        }
        let source = format!("{}\nconst last = 42;", "x".repeat(MAX_HIGHLIGHT_BYTES));
        let highlighted = assert_reconstruction("large.js", &source);
        assert_eq!(highlighted.lines.last().unwrap().text, "const last = 42;");
        assert!(highlighted.lines.iter().flat_map(|line| &line.spans).all(|span| span.category == Category::Plain));
    }
}
