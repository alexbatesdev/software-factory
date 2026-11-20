//! Reading a project from disk: which files exist, which are ignored, and
//! a tiny summary of every line (indent, length, comment or code).
//!
//! Ignore rules come from git itself when the folder is a git repo, so the
//! result matches `git status` exactly (nested .gitignore files, global
//! excludes, .git/info/exclude). Outside git we fall back to a simple
//! .gitignore reader that handles the common pattern shapes.

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    thread,
};

/// Files bigger than this are treated as binary blobs, not read line by line.
const MAX_TEXT_BYTES: u64 = 8 * 1024 * 1024;
/// When expanding an ignored folder (think `node_modules`), stop after this
/// many files so a click never turns into a minute-long wait.
const MAX_EXPAND_FILES: usize = 200_000;

/// One line of source, squeezed into 3 bytes. This is all the minimap needs.
#[derive(Clone, Copy, Debug, Default)]
pub struct Line {
    pub indent: u8,
    pub len: u8,
    pub comment: bool,
}

#[derive(Debug)]
pub enum EntryKind {
    Text { bytes: u64, lines: Vec<Line> },
    Binary { bytes: u64 },
    /// Ignored and not read. Shown collapsed until clicked.
    Ghost { dir: bool },
}

#[derive(Debug)]
pub struct Entry {
    /// Relative to the project root, always '/' separated.
    pub path: String,
    pub kind: EntryKind,
    /// True for things found inside an ignored folder the user expanded.
    pub ignored: bool,
}

pub struct ProjectScan {
    pub entries: Vec<Entry>,
    pub used_git: bool,
}

pub fn scan_project(root: &Path) -> Result<ProjectScan, String> {
    if !root.is_dir() {
        return Err(format!("not a folder: {}", root.display()));
    }
    if is_git_repo(root) {
        let listed = git_ls(root, &["--cached", "--others", "--exclude-standard"])?;
        let ignored = git_ls(root, &["--others", "--ignored", "--exclude-standard", "--directory"])?;
        let mut files = Vec::new();
        let mut entries = Vec::new();
        for path in listed {
            let full = root.join(&path);
            match fs::symlink_metadata(&full) {
                // a git submodule shows up as a folder: treat it like an ignored one
                Ok(meta) if meta.is_dir() => entries.push(ghost(path, true)),
                Ok(meta) if meta.is_file() => files.push(path),
                // deleted but still tracked, or a symlink: skip
                _ => {}
            }
        }
        for path in ignored {
            let dir = path.ends_with('/');
            entries.push(ghost(path.trim_end_matches('/').to_string(), dir));
        }
        entries.extend(read_files(root, files, false));
        Ok(ProjectScan { entries, used_git: true })
    } else {
        let mut files = Vec::new();
        let mut entries = Vec::new();
        walk_with_gitignore(root, "", &mut Vec::new(), &mut files, &mut entries);
        entries.extend(read_files(root, files, false));
        Ok(ProjectScan { entries, used_git: false })
    }
}

/// Read an ignored file or folder the user clicked on. Everything below it
/// is ignored too, so there are no rules to apply: take it all.
pub fn scan_ignored(root: &Path, rel: &str) -> Vec<Entry> {
    let full = root.join(rel);
    if full.is_file() {
        return read_files(root, vec![rel.to_string()], true);
    }
    let mut files = Vec::new();
    let mut stack = vec![rel.to_string()];
    while let Some(dir) = stack.pop() {
        let Ok(read) = fs::read_dir(root.join(&dir)) else { continue };
        for item in read.flatten() {
            let Ok(kind) = item.file_type() else { continue };
            let path = format!("{}/{}", dir, item.file_name().to_string_lossy());
            if kind.is_dir() {
                stack.push(path);
            } else if kind.is_file() {
                files.push(path);
                if files.len() >= MAX_EXPAND_FILES {
                    return read_files(root, files, true);
                }
            }
        }
    }
    read_files(root, files, true)
}

fn ghost(path: String, dir: bool) -> Entry {
    Entry { path, kind: EntryKind::Ghost { dir }, ignored: true }
}

fn is_git_repo(root: &Path) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["rev-parse", "--is-inside-work-tree"])
        .output()
        .map(|out| out.status.success() && out.stdout.starts_with(b"true"))
        .unwrap_or(false)
}

/// `git ls-files -z ...`: paths come back NUL separated so odd file names survive.
fn git_ls(root: &Path, args: &[&str]) -> Result<Vec<String>, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["ls-files", "-z"])
        .args(args)
        .output()
        .map_err(|e| format!("could not run git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    Ok(out
        .stdout
        .split(|b| *b == 0)
        .filter(|p| !p.is_empty())
        .map(|p| String::from_utf8_lossy(p).into_owned())
        .collect())
}

/// Read files on every CPU core. `thread::scope` lets the threads borrow
/// `root` safely because Rust knows they all finish before the scope ends.
fn read_files(root: &Path, paths: Vec<String>, ignored: bool) -> Vec<Entry> {
    let cores = thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    let chunk = paths.len().div_ceil(cores).max(1);
    thread::scope(|s| {
        let workers: Vec<_> = paths
            .chunks(chunk)
            .map(|part| {
                s.spawn(move || {
                    part.iter()
                        .map(|p| Entry { kind: read_file(&root.join(p)), path: p.clone(), ignored })
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        workers.into_iter().flat_map(|w| w.join().unwrap_or_default()).collect()
    })
}

fn read_file(path: &Path) -> EntryKind {
    let bytes = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    if bytes > MAX_TEXT_BYTES {
        return EntryKind::Binary { bytes };
    }
    let Ok(data) = fs::read(path) else {
        return EntryKind::Binary { bytes };
    };
    // the same trick git uses: a NUL byte near the start means binary
    if data[..data.len().min(8000)].contains(&0) {
        return EntryKind::Binary { bytes };
    }
    EntryKind::Text { bytes, lines: summarize_lines(&data) }
}

pub fn summarize_lines(data: &[u8]) -> Vec<Line> {
    let body = data.strip_suffix(b"\n").unwrap_or(data);
    if body.is_empty() {
        return Vec::new();
    }
    body.split(|b| *b == b'\n')
        .map(|raw| {
            let mut indent = 0usize;
            for b in raw {
                match b {
                    b' ' => indent += 1,
                    b'\t' => indent += 4,
                    _ => break,
                }
            }
            let text = raw.trim_ascii();
            let comment = [&b"//"[..], b"#", b";", b"--", b"/*", b"*", b"<!--"]
                .iter()
                .any(|p| text.starts_with(p));
            Line {
                indent: indent.min(255) as u8,
                len: text.len().min(255) as u8,
                comment,
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Fallback for folders that are not git repos: a small .gitignore reader.
// Supports `name`, `dir/`, `*.ext`, `/anchored` and `a/b` patterns.
// Not supported: `!negation` and `**`. Good enough for typical projects.

struct Rule {
    /// Folder (relative to root) that holds the .gitignore.
    base: String,
    pattern: String,
    anchored: bool,
    dir_only: bool,
}

fn walk_with_gitignore(
    root: &Path,
    rel: &str,
    rules: &mut Vec<Rule>,
    files: &mut Vec<String>,
    ghosts: &mut Vec<Entry>,
) {
    let dir = if rel.is_empty() { root.to_path_buf() } else { root.join(rel) };
    let added = load_gitignore(&dir, rel, rules);
    if let Ok(read) = fs::read_dir(&dir) {
        let mut items: Vec<(String, PathBuf, fs::FileType)> = read
            .flatten()
            .filter_map(|i| Some((i.file_name().to_string_lossy().into_owned(), i.path(), i.file_type().ok()?)))
            .collect();
        items.sort_by(|a, b| a.0.cmp(&b.0));
        for (name, _full, kind) in items {
            let path = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            if name == ".git" {
                continue;
            }
            let is_dir = kind.is_dir();
            if rules.iter().any(|r| rule_matches(r, &path, &name, is_dir)) {
                if is_dir || kind.is_file() {
                    ghosts.push(ghost(path, is_dir));
                }
            } else if is_dir {
                walk_with_gitignore(root, &path, rules, files, ghosts);
            } else if kind.is_file() {
                files.push(path);
            }
        }
    }
    rules.truncate(rules.len() - added);
}

fn load_gitignore(dir: &Path, rel: &str, rules: &mut Vec<Rule>) -> usize {
    let Ok(text) = fs::read_to_string(dir.join(".gitignore")) else { return 0 };
    let before = rules.len();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with('!') {
            continue;
        }
        let dir_only = line.ends_with('/');
        let line = line.trim_end_matches('/');
        let anchored = line.contains('/');
        rules.push(Rule {
            base: rel.to_string(),
            pattern: line.trim_start_matches('/').to_string(),
            anchored,
            dir_only,
        });
    }
    rules.len() - before
}

fn rule_matches(rule: &Rule, path: &str, name: &str, is_dir: bool) -> bool {
    if rule.dir_only && !is_dir {
        return false;
    }
    if rule.anchored {
        let local = if rule.base.is_empty() {
            path
        } else {
            match path.strip_prefix(&rule.base).and_then(|p| p.strip_prefix('/')) {
                Some(p) => p,
                None => return false,
            }
        };
        glob(rule.pattern.as_bytes(), local.as_bytes())
    } else {
        glob(rule.pattern.as_bytes(), name.as_bytes())
    }
}

/// Minimal glob: `*` matches anything except '/', `?` matches one character.
fn glob(p: &[u8], s: &[u8]) -> bool {
    match (p.first(), s.first()) {
        (None, None) => true,
        (Some(b'*'), _) => glob(&p[1..], s) || (!s.is_empty() && s[0] != b'/' && glob(p, &s[1..])),
        (Some(b'?'), Some(c)) if *c != b'/' => glob(&p[1..], &s[1..]),
        (Some(a), Some(b)) if a == b => glob(&p[1..], &s[1..]),
        _ => false,
    }
}
