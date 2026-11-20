use megamap::{pr_project::ComparisonProject, evidence_input, web_project::{Project, MAX_INPUT, MAX_OUTPUT}};
use serde_json::{json, Value};
use std::{io::{self, BufRead, Write}, path::PathBuf, sync::{mpsc, Arc, atomic::{AtomicUsize, Ordering}}};

fn read_frame(reader: &mut impl BufRead) -> Result<Option<Vec<u8>>, String> {
    let mut frame = Vec::new();
    loop {
        let bytes = reader.fill_buf().map_err(|_| "stdin could not be read")?;
        if bytes.is_empty() { return if frame.is_empty() { Ok(None) } else { Ok(Some(frame)) }; }
        let count = bytes.iter().position(|byte| *byte == b'\n').map(|n| n + 1).unwrap_or(bytes.len());
        if frame.len() + count > MAX_INPUT { return Err("request exceeds 64 MiB limit".into()); }
        let complete = bytes[count - 1] == b'\n';
        frame.extend_from_slice(&bytes[..count]);
        reader.consume(count);
        if complete { return Ok(Some(frame)); }
    }
}
fn write_response(writer: &mut impl Write, response: Value) -> Result<(), String> {
    let mut encoded = serde_json::to_vec(&response).map_err(|_| "response could not be encoded")?;
    if encoded.len() > MAX_OUTPUT {
        encoded = serde_json::to_vec(&json!({"id":response.get("id").unwrap_or(&Value::Null),"error":"response exceeds 128 MiB limit; narrow the filter or source request"})).map_err(|_| "response could not be encoded")?;
    }
    writer.write_all(&encoded).and_then(|_| writer.write_all(b"\n")).and_then(|_| writer.flush()).map_err(|_| "stdout could not be written".into())
}
fn read_requests(reader: &mut impl BufRead, sender: mpsc::Sender<Result<Vec<u8>,String>>, queued: &AtomicUsize) {
    loop {
        let frame = match read_frame(reader) {
            Ok(Some(frame)) => Ok(frame),
            Ok(None) => break,
            Err(error) => Err(error),
        };
        if queued.fetch_add(1, Ordering::AcqRel) >= 1 {
            let _ = sender.send(Err("request queue is full; serialize worker requests".into()));
            break;
        }
        let failed = frame.is_err();
        if sender.send(frame).is_err() || failed { break; }
    }
}
enum WorkerProject { Ordinary(Project), Comparison(ComparisonProject) }
impl WorkerProject {
    fn request(&mut self, request: &Value) -> Value {
        match self { Self::Ordinary(project) => project.request(request), Self::Comparison(project) => project.request(request) }
    }
}

fn run() -> Result<(), String> {
    let mut args = std::env::args_os().skip(1); let mut root = None; let mut capture = false; let mut comparison = None; let mut progress = false;
    while let Some(arg) = args.next() {
        if arg == "--root" { if root.is_some() { return Err("pass --root once".into()); } root = Some(PathBuf::from(args.next().ok_or("--root needs a path")?)); }
        else if arg == "--comparison" { if comparison.is_some() { return Err("pass --comparison once".into()); } comparison = Some(PathBuf::from(args.next().ok_or("--comparison needs a manifest path")?)); }
        else if arg == "--allow-capture" { capture = true; }
        else if arg == "--progress" { progress = true; }
        else if arg == "--help" { println!("megamap-data --root PATH [--allow-capture] [--comparison MANIFEST] [--progress]"); return Ok(()); }
        else { return Err("unknown argument; use --root PATH [--allow-capture]".into()); }
    }
    let root = root.ok_or("--root PATH is required")?;
    if comparison.is_some() && capture { return Err("Rails capture is unavailable for immutable PR revisions".into()); }
    let mut output = io::stdout().lock();
    let mut progress_error = None;
    let mut project = if let Some(manifest) = comparison { WorkerProject::Comparison(ComparisonProject::new_with_progress(&manifest, &root, |event| {
        if progress && progress_error.is_none() { progress_error = write_response(&mut output, json!({"progress":event})).err(); }
    })?) } else { WorkerProject::Ordinary(Project::new(&root, capture)?) };
    if let Some(error) = progress_error { return Err(error); }
    struct CaptureGuard;
    impl Drop for CaptureGuard { fn drop(&mut self) { evidence_input::cancel_capture(); } }
    let _guard = CaptureGuard;
    let (sender, receiver) = mpsc::channel();
    let queued = Arc::new(AtomicUsize::new(0));
    let reader_queued = Arc::clone(&queued);
    std::thread::Builder::new().name("worker-stdin-lifeline".into()).spawn(move || {
        read_requests(&mut io::stdin().lock(), sender, &reader_queued);
        evidence_input::cancel_capture();
    }).map_err(|_| "stdin monitor could not be started")?;
    for frame in receiver {
        queued.fetch_sub(1, Ordering::AcqRel);
        let response = match frame {
            Ok(frame) => match serde_json::from_slice::<Value>(&frame) {
                Ok(request) => project.request(&request),
                Err(_) => json!({"id":null,"error":"request must be valid JSON"}),
            },
            Err(error) => { write_response(&mut output,json!({"id":null,"error":error}))?; break; }
        };
        write_response(&mut output,response)?;
    }
    Ok(())
}
fn main() { if let Err(error) = run() { eprintln!("megamap-data: {error}"); std::process::exit(1); } }

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    #[test]
    fn frames_preserve_newline_json_boundaries_and_final_unterminated_request() {
        let mut input = io::Cursor::new(b"{\"id\":1}\n{\"id\":2}");
        assert_eq!(read_frame(&mut input).unwrap().unwrap(),b"{\"id\":1}\n");
        assert_eq!(read_frame(&mut input).unwrap().unwrap(),b"{\"id\":2}");
        assert!(read_frame(&mut input).unwrap().is_none());
    }
    #[test]
    fn oversized_input_is_rejected_without_an_unbounded_read() {
        let mut input = io::BufReader::new(io::repeat(b'a').take(MAX_INPUT as u64 + 1));
        assert!(read_frame(&mut input).unwrap_err().contains("64 MiB"));
    }
    #[test]
    fn queued_input_never_blocks_the_lifeline_monitor() {
        let (sender, receiver) = mpsc::channel();
        let queued = AtomicUsize::new(0);
        read_requests(&mut io::Cursor::new(b"{}\n{}\n{}\n"),sender,&queued);
        let frames: Vec<_> = receiver.into_iter().collect();
        assert_eq!(frames.len(),2);
        assert!(frames[0].is_ok());
        assert!(frames[1].as_ref().unwrap_err().contains("serialize"));
    }
    #[test]
    fn responses_are_single_flushed_json_frames() {
        let mut output = Vec::new();
        write_response(&mut output,json!({"id":7,"result":"line one\nline two"})).unwrap();
        assert_eq!(output.iter().filter(|byte| **byte == b'\n').count(),1);
        assert_eq!(serde_json::from_slice::<Value>(&output).unwrap()["id"],7);
    }
}
