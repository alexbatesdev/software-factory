use crate::{evidence::Snapshot, relationships::SourceFile};
use std::{fs, io::Read, path::{Path, PathBuf}, process::{Command, Stdio}, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

static CAPTURE_PIPE: AtomicU64 = AtomicU64::new(0);
static PIPE_NONCE: AtomicU64 = AtomicU64::new(1);
static STOPPING: AtomicBool = AtomicBool::new(false);

pub fn cancel_capture() {
    STOPPING.store(true, Ordering::Release);
    close_pipe(CAPTURE_PIPE.swap(0, Ordering::AcqRel));
}

fn close_pipe(token: u64) {
    #[cfg(unix)] unsafe {
        extern "C" { fn close(fd: i32) -> i32; }
        if token != 0 { close((token as u32 - 1) as i32); }
    }
    #[cfg(not(unix))] { let _ = token; }
}

struct CapturePipe(u64);
impl Drop for CapturePipe {
    fn drop(&mut self) {
        if CAPTURE_PIPE.compare_exchange(self.0, 0, Ordering::AcqRel, Ordering::Acquire).is_ok() {
            close_pipe(self.0);
        }
    }
}

const MAX_SNAPSHOT_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone, Debug, Default)]
pub enum EvidenceInput {
    #[default]
    Static,
    File(PathBuf),
    Rails,
}

pub struct EvidenceResult {
    pub snapshot: Option<Snapshot>,
    pub status: String,
}

pub fn load(root: &Path, sources: &[SourceFile], input: &EvidenceInput) -> EvidenceResult {
    let result = match input {
        EvidenceInput::Static => return EvidenceResult { snapshot: None, status: "Static analysis; optional app data is off".into() },
        EvidenceInput::File(path) => read(&if path.is_absolute() { path.clone() } else { root.join(path) }).and_then(|text| Snapshot::parse(&text, sources)),
        EvidenceInput::Rails => capture(root, Duration::from_secs(45)).and_then(|text| Snapshot::parse(&text, sources)),
    };
    match result {
        Ok(snapshot) => {
            let warnings = snapshot.warnings.len();
            let status = format!("Loaded evidence: {}{}", snapshot.label, if warnings == 0 { String::new() } else {
                format!(" · {warnings} warnings/ignored entries: {}", snapshot.warnings.iter().take(2).cloned().collect::<Vec<_>>().join("; "))
            });
            EvidenceResult { snapshot: Some(snapshot), status }
        }
        Err(error) => EvidenceResult { snapshot: None, status: format!("Optional evidence unavailable: {error}. Using static analysis") },
    }
}

fn read(path: &Path) -> Result<String, String> {
    let file = fs::File::open(path).map_err(|_| "snapshot file could not be opened".to_owned())?;
    let mut bytes = Vec::new();
    file.take(MAX_SNAPSHOT_BYTES + 1).read_to_end(&mut bytes).map_err(|_| "snapshot file could not be read".to_owned())?;
    if bytes.len() as u64 > MAX_SNAPSHOT_BYTES { return Err("snapshot exceeds 64 MiB".into()); }
    String::from_utf8(bytes).map_err(|_| "snapshot must be UTF-8 JSON".into())
}

struct CaptureDir(PathBuf);
impl Drop for CaptureDir {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
}

#[cfg(unix)]
fn capture(root: &Path, timeout: Duration) -> Result<String, String> {
    if STOPPING.load(Ordering::Acquire) { return Err("the viewer is closing".into()); }
    if !root.join("bin/rails").is_file() { return Err("this repository has no bin/rails".into()); }
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let path = std::env::temp_dir().join(format!("spamton-megamap-evidence-{}-{nonce}", std::process::id()));
    fs::create_dir(&path).map_err(|_| "could not create capture directory".to_owned())?;
    let dir = CaptureDir(path);
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dir.0, fs::Permissions::from_mode(0o700)).map_err(|_| "could not secure capture directory".to_owned())?;
    }
    let script = dir.0.join("runtime_evidence.rb");
    let output = dir.0.join("snapshot.json");
    fs::write(&script, include_str!("../tools/runtime_evidence.rb")).map_err(|_| "could not prepare capture".to_owned())?;
    let supervisor = std::env::current_exe().ok().and_then(|exe| exe.parent().map(|dir| dir.join("megamap-capture")))
        .filter(|path| path.is_file()).ok_or("capture helper is missing; build megamap with cargo build --release --bins")?;
    let status = dir.0.join("status");
    let mut command = Command::new(supervisor);
    command.current_dir(root).arg(&status).arg(timeout.as_millis().to_string()).arg(root.join("bin/rails")).arg("runner").arg(&script)
        .env("RAILS_ENV", "development").env("DISABLE_SPRING", "1")
        .env("MEGAMAP_EVIDENCE_MODE", "snapshot")
        .env("MEGAMAP_EVIDENCE_LABEL", "Rails development metadata")
        .env("MEGAMAP_EVIDENCE_OUT", &output)
        .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(unix)] {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|_| "capture helper could not be started".to_owned())?;
    use std::os::fd::IntoRawFd;
    let fd = child.stdin.take().ok_or("capture lifeline is unavailable")?.into_raw_fd();
    let token = (PIPE_NONCE.fetch_add(1, Ordering::Relaxed) << 32) | (fd as u64 + 1);
    if CAPTURE_PIPE.compare_exchange(0, token, Ordering::AcqRel, Ordering::Acquire).is_err() {
        close_pipe(token);
        let _ = child.wait();
        return Err("a capture is already running".into());
    }
    let pipe = CapturePipe(token);
    let result = wait_capture(&mut child, &status, timeout);
    drop(pipe);
    let _ = child.wait();
    result?;
    read(&output)
}

#[cfg(not(unix))]
fn capture(_root: &Path, _timeout: Duration) -> Result<String, String> {
    Err("live capture is unavailable on this platform; import an evidence snapshot instead".into())
}

#[cfg(unix)]
fn wait_capture(child: &mut std::process::Child, status: &Path, timeout: Duration) -> Result<(), String> {
    let started = Instant::now();
    loop {
        if STOPPING.load(Ordering::Acquire) { return Err("the viewer is closing".into()); }
        match fs::read(status) {
            Ok(bytes) if bytes == b"ok" => return Ok(()),
            Ok(_) => return Err("Rails capture failed".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(_) => return Err("capture status could not be read".into()),
        }
        match child.try_wait() {
            Ok(Some(_)) => return Err("capture helper stopped before completion".into()),
            Err(_) => return Err("capture helper status could not be read".into()),
            Ok(None) => {},
        }
        if started.elapsed() >= timeout { return Err("Rails capture timed out".into()); }
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_optional_file_or_app_keeps_static_analysis_available() {
        let root = std::env::temp_dir().join(format!("spamton-missing-evidence-{}", std::process::id()));
        for input in [EvidenceInput::Static, EvidenceInput::File(root.join("missing.json")), EvidenceInput::Rails] {
            let result = load(&root, &[], &input);
            assert!(result.snapshot.is_none());
            assert!(result.status.to_lowercase().contains("static analysis"));
        }
    }

    #[test]
    #[cfg(unix)]
    fn closing_a_capture_pipe_cannot_close_a_reused_descriptor() {
        use std::os::fd::{AsRawFd, IntoRawFd};
        let file = fs::File::open("/dev/null").unwrap();
        let fd = file.into_raw_fd();
        let token = (PIPE_NONCE.fetch_add(1, Ordering::Relaxed) << 32) | (fd as u64 + 1);
        CAPTURE_PIPE.store(token, Ordering::Release);
        let guard = CapturePipe(token);
        close_pipe(CAPTURE_PIPE.swap(0, Ordering::AcqRel));
        let replacement = fs::File::open("/dev/null").unwrap();
        assert_eq!(replacement.as_raw_fd(), fd);
        let replacement_token = (PIPE_NONCE.fetch_add(1, Ordering::Relaxed) << 32) | (fd as u64 + 1);
        CAPTURE_PIPE.store(replacement_token, Ordering::Release);
        drop(guard);
        assert_eq!(CAPTURE_PIPE.swap(0, Ordering::AcqRel), replacement_token);
        assert!(replacement.metadata().is_ok());
    }
}
