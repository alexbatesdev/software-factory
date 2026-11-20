use std::{fs, io::Read, path::Path, process::{Command, Stdio}, sync::{Arc, atomic::{AtomicBool, Ordering}}, time::{Duration, Instant}};

#[cfg(unix)]
fn main() {
    extern "C" { fn getpgrp() -> i32; fn kill(pid: i32, signal: i32) -> i32; }
    let pid = std::process::id() as i32;
    if unsafe { getpgrp() } != pid { std::process::exit(2); }
    let mut args = std::env::args_os().skip(1);
    let Some(status) = args.next() else { std::process::exit(2) };
    let Some(timeout) = args.next().and_then(|s| s.to_str().and_then(|s| s.parse::<u64>().ok())) else { std::process::exit(2) };
    let Some(program) = args.next() else { std::process::exit(2) };
    let cancelled = Arc::new(AtomicBool::new(false));
    let reader_cancelled = Arc::clone(&cancelled);
    if std::thread::Builder::new().name("capture-lifeline".into()).spawn(move || {
        let mut byte = [0];
        let mut input = std::io::stdin().lock();
        while matches!(input.read(&mut byte), Ok(n) if n > 0) {}
        reader_cancelled.store(true, Ordering::Release);
    }).is_err() { std::process::exit(2); }
    let started = Instant::now();
    let timeout = Duration::from_millis(timeout);
    let stop = || {
        unsafe { kill(-pid, 9); }
        std::process::exit(2);
    };
    if cancelled.load(Ordering::Acquire) { stop(); }
    let mut command = Command::new(program);
    command.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    let mut child = match command.spawn() {
        Ok(child) => Some(child),
        Err(_) => { write_status(Path::new(&status), "failed"); None }
    };
    loop {
        if cancelled.load(Ordering::Acquire) || started.elapsed() >= timeout { stop(); }
        if let Some(target) = &mut child {
            match target.try_wait() {
                Ok(Some(result)) => {
                    write_status(Path::new(&status), if result.success() { "ok" } else { "failed" });
                    child = None;
                }
                Err(_) => stop(),
                Ok(None) => {}
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn write_status(path: &Path, status: &str) {
    let temporary = path.with_extension("pending");
    if fs::write(&temporary, status).is_ok() { let _ = fs::rename(temporary, path); }
}

#[cfg(not(unix))]
fn main() { std::process::exit(2); }
