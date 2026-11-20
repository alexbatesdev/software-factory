#[derive(Clone, Debug, Default)]
pub struct Filter {
    groups: Vec<Vec<Term>>,
}

#[derive(Clone, Debug)]
struct Term {
    negative: bool,
    pattern: String,
    glob: Option<Vec<GlobToken>>,
}

#[derive(Clone, Copy, Debug)]
enum GlobToken {
    Literal(char),
    One,
    Star,
    AnyDepth,
    Directories,
}

impl Filter {
    /// Whitespace joins terms with AND; `|` separates OR groups. `-` excludes a term.
    pub fn parse(expression: &str) -> Result<Self, String> {
        if expression.trim().is_empty() {
            return Ok(Self::default());
        }
        let mut groups = Vec::new();
        for (index, group) in expression.split('|').enumerate() {
            if group.trim().is_empty() {
                return Err(format!("OR group {} is empty; add a term on each side of |", index + 1));
            }
            let mut terms = Vec::new();
            for token in group.split_whitespace() {
                let negative = token.starts_with('-');
                let pattern = if negative { &token[1..] } else { token };
                if pattern.is_empty() {
                    return Err("An exclusion needs a term after -".into());
                }
                if pattern.contains(['(', ')', '[', ']', '{', '}', '\'', '"', '\\']) || ["&", "&&", "!"].contains(&pattern) {
                    return Err(format!("Unsupported syntax in {token:?}; use terms, -exclusions, |, * and ?"));
                }
                let pattern = pattern.to_lowercase();
                let glob = if pattern.contains(['*', '?']) { Some(parse_glob(&pattern)?) } else { None };
                terms.push(Term { negative, pattern, glob });
            }
            groups.push(terms);
        }
        Ok(Self { groups })
    }

    /// Globs containing `/` match the entire relative path; other globs match its basename.
    pub fn matches(&self, path: &str) -> bool {
        if self.groups.is_empty() {
            return true;
        }
        let path = path.to_lowercase();
        self.groups.iter().any(|group| {
            group.iter().all(|term| {
                let matched = if let Some(glob) = &term.glob {
                    let target = if term.pattern.contains('/') { path.as_str() } else { path.rsplit('/').next().unwrap_or(&path) };
                    glob_matches(glob, target)
                } else {
                    path.contains(&term.pattern)
                };
                matched != term.negative
            })
        })
    }
}

fn parse_glob(pattern: &str) -> Result<Vec<GlobToken>, String> {
    let mut chars = pattern.chars().peekable();
    let mut tokens = Vec::new();
    while let Some(c) = chars.next() {
        tokens.push(match c {
            '?' => GlobToken::One,
            '*' if chars.peek() == Some(&'*') => {
                chars.next();
                if chars.peek() == Some(&'*') {
                    return Err("Use * within a path component or ** across directories; *** is unsupported".into());
                }
                if chars.peek() == Some(&'/') {
                    chars.next();
                    GlobToken::Directories
                } else {
                    GlobToken::AnyDepth
                }
            }
            '*' => GlobToken::Star,
            literal => GlobToken::Literal(literal),
        });
    }
    Ok(tokens)
}

fn glob_matches(pattern: &[GlobToken], path: &str) -> bool {
    let chars: Vec<char> = path.chars().collect();
    let mut previous = vec![false; chars.len() + 1];
    previous[0] = true;
    for token in pattern {
        let mut next = vec![false; chars.len() + 1];
        match token {
            GlobToken::Star | GlobToken::AnyDepth => {
                next[0] = previous[0];
                for j in 1..=chars.len() {
                    next[j] = previous[j] || (next[j - 1] && (matches!(token, GlobToken::AnyDepth) || chars[j - 1] != '/'));
                }
            }
            GlobToken::Directories => {
                let mut reachable = false;
                for j in 0..=chars.len() {
                    next[j] = previous[j] || (reachable && j > 0 && chars[j - 1] == '/');
                    reachable |= previous[j];
                }
            }
            GlobToken::One | GlobToken::Literal(_) => {
                for j in 1..=chars.len() {
                    let matched = match token {
                        GlobToken::One => chars[j - 1] != '/',
                        GlobToken::Literal(c) => chars[j - 1] == *c,
                        _ => unreachable!(),
                    };
                    next[j] = previous[j - 1] && matched;
                }
            }
        }
        previous = next;
    }
    previous[chars.len()]
}

pub fn is_test_path(path: &str) -> bool {
    let path = path.to_lowercase();
    let mut components = path.split('/').peekable();
    while let Some(component) = components.next() {
        if ["spec", "test", "tests", "__tests__"].contains(&component) {
            return true;
        }
        if components.peek().is_none() {
            let stem = component.rsplit_once('.').map_or(component, |(stem, _)| stem);
            return stem.ends_with("_spec") || stem.ends_with(".spec") || stem.ends_with("_test") || stem.ends_with(".test") || stem.starts_with("test_");
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whitespace_and_binds_more_tightly_than_or() {
        let filter = Filter::parse("APP model -spec/ | lib worker").unwrap();
        assert!(filter.matches("app/models/user.rb"));
        assert!(filter.matches("lib/worker.rb"));
        assert!(!filter.matches("app/controllers/user.rb"));
        assert!(!filter.matches("spec/app/model_spec.rb"));
        assert!(!filter.matches("lib/models/user.rb"));
    }

    #[test]
    fn empty_filter_and_negative_only_filter() {
        assert!(Filter::parse("   ").unwrap().matches("anything"));
        let filter = Filter::parse("-spec/ -**/*.spec.ts").unwrap();
        assert!(filter.matches("app/special.ts"));
        assert!(!filter.matches("spec/user.rb"));
        assert!(!filter.matches("widget.spec.ts"));
        assert!(!filter.matches("src/widget.spec.ts"));
    }

    #[test]
    fn invalid_expressions_report_the_problem() {
        for expression in ["| app", "app |", "app || lib", "-", "app -", "app (lib)", "\"app model\"", "a[bc]*", "***.ts"] {
            assert!(Filter::parse(expression).is_err(), "accepted {expression:?}");
        }
    }

    #[test]
    fn globs_respect_components_and_zero_depth_double_star() {
        let filter = Filter::parse("src/**/*.?s").unwrap();
        assert!(filter.matches("SRC/main.ts"));
        assert!(filter.matches("src/deep/main.js"));
        assert!(!filter.matches("other/src/main.ts"));
        assert!(!filter.matches("src/main.tsx"));
        assert!(!Filter::parse("src/*.ts").unwrap().matches("src/deep/main.ts"));
        assert!(Filter::parse("*.ts").unwrap().matches("src/main.ts"));
        assert!(!Filter::parse("*.ts").unwrap().matches("src/main.tsx"));
        assert!(Filter::parse("**/é?.ts").unwrap().matches("src/ét.ts"));
        assert!(Filter::parse("src/**").unwrap().matches("src/deep/main.ts"));
    }

    #[test]
    fn test_paths_match_components_and_conventional_filenames() {
        for path in ["spec/user.rb", "src/TEST/widget.ts", "tests/run.py", "__tests__/x.js", "app/user_spec.rb", "user.spec.ts", "user.test.tsx", "test_user.py", "user_test.go"] {
            assert!(is_test_path(path), "missed {path}");
        }
        for path in ["app/special.rb", "contest/run.rb", "app/testing.ts", "latest_specification.rb", "testimony.py"] {
            assert!(!is_test_path(path), "hid {path}");
        }
    }
}
