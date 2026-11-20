#![cfg(unix)]
use std::{fs, path::{Path, PathBuf}, process::{Child, Command, Stdio}, time::{Duration, Instant}};
use std::os::unix::process::CommandExt;

fn binary() -> PathBuf {
    option_env!("CARGO_BIN_EXE_megamap-capture").map(PathBuf::from)
        .or_else(|| std::env::var_os("MEGAMAP_CAPTURE_TEST_BINARY").map(PathBuf::from)).expect("capture binary")
}
fn directory() -> PathBuf {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let path = std::env::temp_dir().join(format!("spamton-capture-test-{}-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(), NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
    fs::create_dir(&path).unwrap(); path
}
fn wait_for(path: &Path) -> String {
    let start = Instant::now();
    loop {
        if let Ok(text) = fs::read_to_string(path) { if !text.is_empty() { return text; } }
        assert!(start.elapsed() < Duration::from_secs(5), "missing {}", path.display());
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn running(pid: &str) -> bool {
    let output = Command::new("/bin/ps").args(["-p", pid.trim(), "-o", "stat="]).output().unwrap();
    let state = String::from_utf8_lossy(&output.stdout);
    !state.trim().is_empty() && !state.trim().starts_with('Z')
}
fn assert_stopped(pid: &str) {
    let start = Instant::now();
    while running(pid) {
        assert!(start.elapsed() < Duration::from_secs(3), "process {pid} is still running");
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn spawn_supervisor(path: &Path, timeout: u64, complete: bool) -> Child {
    Command::new(binary()).arg(path.join("status")).arg(timeout.to_string())
        .arg(std::env::current_exe().unwrap()).args(["--exact", "fixture_target", "--ignored", "--nocapture"])
        .env("MEGAMAP_CAPTURE_FIXTURE", path).env("MEGAMAP_CAPTURE_COMPLETE", if complete {"1"} else {"0"})
        .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).process_group(0).spawn().unwrap()
}

#[test]
#[ignore]
fn fixture_target() {
    let path = PathBuf::from(std::env::var_os("MEGAMAP_CAPTURE_FIXTURE").expect("fixture only"));
    fs::write(path.join("target"), std::process::id().to_string()).unwrap();
    let mut descendant = Command::new("/bin/sleep").arg("60").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
    fs::write(path.join("descendant"), descendant.id().to_string()).unwrap();
    if std::env::var("MEGAMAP_CAPTURE_COMPLETE").unwrap() == "0" { let _ = descendant.wait(); }
}

#[test]
#[ignore]
fn fixture_viewer_exits_before_lifeline_registration() {
    let path = PathBuf::from(std::env::var_os("MEGAMAP_CAPTURE_FIXTURE").expect("fixture only"));
    let _unregistered_child = spawn_supervisor(&path, 5000, false);
    wait_for(&path.join("descendant"));
    // Process exit closes the writer while it is still unregistered in the viewer.
    std::process::exit(0);
}

#[test]
fn viewer_exit_before_registration_stops_target_and_descendant() {
    let path = directory();
    let mut viewer = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "fixture_viewer_exits_before_lifeline_registration", "--ignored", "--nocapture"])
        .env("MEGAMAP_CAPTURE_FIXTURE", &path).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
    assert!(viewer.wait().unwrap().success());
    assert_stopped(&wait_for(&path.join("target")));
    assert_stopped(&wait_for(&path.join("descendant")));
    fs::remove_dir_all(path).unwrap();
}

#[test]
fn successful_target_keeps_supervisor_alive_until_lifeline_closes() {
    let path = directory();
    let mut supervisor = spawn_supervisor(&path, 5000, true);
    let descendant = wait_for(&path.join("descendant"));
    assert_eq!(wait_for(&path.join("status")), "ok");
    assert!(supervisor.try_wait().unwrap().is_none());
    assert!(running(&descendant));
    drop(supervisor.stdin.take());
    assert!(!supervisor.wait().unwrap().success());
    assert_stopped(&descendant);
    fs::remove_dir_all(path).unwrap();
}

#[test]
fn timeout_stops_target_and_descendant_with_lifeline_still_open() {
    let path = directory();
    let started = Instant::now();
    let mut supervisor = spawn_supervisor(&path, 500, false);
    let descendant = wait_for(&path.join("descendant"));
    let target = wait_for(&path.join("target"));
    while supervisor.try_wait().unwrap().is_none() {
        assert!(started.elapsed() < Duration::from_secs(3), "supervisor ignored its timeout");
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(started.elapsed() >= Duration::from_millis(450), "lifeline closed before the timeout");
    assert!(supervisor.stdin.is_some());
    assert_stopped(&target);
    assert_stopped(&descendant);
    assert!(!path.join("status").exists());
    fs::remove_dir_all(path).unwrap();
}
