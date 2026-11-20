//! Git activity per file, for the heatmap: how many commits touched a file
//! and when it last changed. One `git log` call, parsed in a background thread.

use std::{collections::HashMap, path::Path, process::Command};

/// Only look at this many recent commits, so huge histories stay fast.
const MAX_COMMITS: usize = 20_000;

#[derive(Default)]
pub struct History {
    /// path (relative to the mapped folder) -> (commit count, last change unix time)
    pub files: HashMap<String, (u32, i64)>,
    pub commits_read: usize,
}

pub fn load(root: &Path) -> Result<History, String> {
    // %x00 puts a NUL byte before each commit so commits are easy to split.
    // --relative makes paths relative to the mapped folder, even if it is a
    // subfolder of the repo, and hides changes outside it.
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["log", "--relative", "--name-only", "--no-renames", "--format=%x00%ct"])
        .arg(format!("-n{MAX_COMMITS}"))
        .output()
        .map_err(|e| format!("could not run git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut history = History::default();
    for commit in text.split('\0').filter(|c| !c.trim().is_empty()) {
        let mut lines = commit.lines();
        let Some(time) = lines.next().and_then(|t| t.trim().parse::<i64>().ok()) else { continue };
        history.commits_read += 1;
        for path in lines.map(str::trim).filter(|l| !l.is_empty()) {
            let entry = history.files.entry(path.to_string()).or_insert((0, time));
            entry.0 += 1;
            entry.1 = entry.1.max(time);
        }
    }
    Ok(history)
}
