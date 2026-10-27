//! A small, fixed-schema launcher journal. Never serialize errors, paths,
//! command arguments, environment variables, credentials or document content.
use serde::{Deserialize, Serialize};
use std::{fs::{self, OpenOptions}, io::{Read, Write}, path::{Path, PathBuf}, sync::{Mutex, OnceLock}, time::{SystemTime, UNIX_EPOCH}};

pub const MAX_BYTES: u64 = 128 * 1024;
static DIRECTORY: OnceLock<PathBuf> = OnceLock::new();
static WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Event { NativeStart, NativeReady, NativeStartupFailed, NativeBackendReady, NativeBackendStopped, NativeShutdownStart, NativeShutdownComplete, NativePanic }
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record { format: u8, at_millis: u64, event: Event }

fn directory(data: &Path) -> Option<PathBuf> {
    if !data.is_absolute() || fs::symlink_metadata(data).ok()?.file_type().is_symlink() { return None; }
    let root = data.canonicalize().ok()?;
    let path = root.join("diagnostics");
    if !path.exists() {
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)] { use std::os::unix::fs::DirBuilderExt; builder.mode(0o700); }
        if builder.create(&path).is_err() && !path.exists() { return None; }
    }
    let meta = fs::symlink_metadata(&path).ok()?;
    if !meta.is_dir() || meta.file_type().is_symlink() || path.canonicalize().ok()? != path { return None; }
    #[cfg(unix)] {
        use std::os::unix::fs::MetadataExt;
        if meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 { return None; }
    }
    #[cfg(windows)] {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 { return None; }
    }
    Some(path)
}
fn regular(path: &Path) -> bool {
    let Ok(meta) = fs::symlink_metadata(path) else { return false; };
    if !meta.is_file() || meta.file_type().is_symlink() { return false; }
    #[cfg(unix)] {
        use std::os::unix::fs::MetadataExt;
        if meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 || meta.nlink() != 1 { return false; }
    }
    #[cfg(windows)] {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 { return false; }
    }
    true
}
fn options() -> OpenOptions {
    let mut options = OpenOptions::new();
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600).custom_flags(libc::O_NOFOLLOW); }
    #[cfg(windows)] { use std::os::windows::fs::OpenOptionsExt; options.custom_flags(0x00200000); }
    options
}
fn append(data: &Path, event: Event) -> Option<()> {
    let path = directory(data)?.join("native-events.jsonl");
    if path.exists() {
        if !regular(&path) { return None; }
        if fs::metadata(&path).ok()?.len() >= MAX_BYTES {
            let previous = path.with_file_name("native-events.1.jsonl");
            if previous.exists() { if !regular(&previous) { return None; } fs::remove_file(&previous).ok()?; }
            fs::rename(&path, previous).ok()?;
        }
    }
    let mut file = if path.exists() { options().append(true).open(&path).ok()? }
        else { options().write(true).create_new(true).open(&path).ok()? };
    if !regular(&path) { return None; }
    let at_millis = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_millis().try_into().ok()?;
    let mut bytes = serde_json::to_vec(&Record { format: 1, at_millis, event }).ok()?; bytes.push(b'\n');
    file.write_all(&bytes).ok()?;
    Some(())
}
pub fn initialize(data: &Path) {
    let _ = DIRECTORY.set(data.to_path_buf());
    record(Event::NativeStart);
    // Preserve the normal hook, which produces the OS diagnostic. The journal
    // records only a fixed event, never the potentially sensitive panic text.
    static HOOK: OnceLock<()> = OnceLock::new();
    HOOK.get_or_init(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| { record(Event::NativePanic); previous(info); }));
    });
}
pub fn record(event: Event) {
    let Some(data) = DIRECTORY.get() else { return; };
    let Ok(_guard) = WRITE_LOCK.try_lock() else { return; };
    let _ = append(data, event);
}
pub fn export_text(data: &Path) -> String {
    let mut output = format!("LawAgent native launcher diagnostics\nApp version: {}\nPlatform: {}\nArchitecture: {}\nOnly fixed launcher events are included. No document text, identifiers, keys or raw errors are recorded.\n\n", env!("CARGO_PKG_VERSION"), std::env::consts::OS, std::env::consts::ARCH);
    let Some(path) = directory(data) else { output.push_str("Native journal unavailable.\n"); return output; };
    let mut count = 0;
    for name in ["native-events.1.jsonl", "native-events.jsonl"] {
        let file = path.join(name);
        if !regular(&file) || fs::metadata(&file).map_or(true, |meta| meta.len() > MAX_BYTES + 1024) { continue; }
        let Ok(opened) = options().read(true).open(file) else { continue; };
        let mut bytes = Vec::new();
        if opened.take(MAX_BYTES + 1025).read_to_end(&mut bytes).is_err() || bytes.len() as u64 > MAX_BYTES + 1024 { continue; }
        let Ok(contents) = std::str::from_utf8(&bytes) else { continue; };
        for line in contents.lines().filter(|line| line.len() <= 1024) {
            if let Ok(value) = serde_json::from_str::<Record>(line) {
                if value.format == 1 && value.at_millis > 0 && value.at_millis <= 253402300799999 {
                    if let Ok(clean) = serde_json::to_string(&value) { output.push_str(&clean); output.push('\n'); count += 1; }
                }
            }
        }
    }
    if count == 0 { output.push_str("No readable native events.\n"); }
    output
}
pub fn save_new(path: &Path, contents: &str) -> Result<(), String> {
    let mut file = options().write(true).create_new(true).open(path).map_err(|_| "无法保存日志，请选择一个尚不存在的新文件名。")?;
    file.write_all(contents.as_bytes()).and_then(|_| file.sync_all()).map_err(|_| "日志未能完整保存，请选择其他位置后重试。".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn data() -> tempfile::TempDir { tempfile::tempdir().unwrap() }
    #[test]
    fn native_events_are_small_and_survive_a_restart_read() {
        let data = data(); append(data.path(), Event::NativeStart).unwrap(); append(data.path(), Event::NativeBackendReady).unwrap();
        let text = export_text(data.path()); assert!(text.contains("native_start")); assert!(text.contains("native_backend_ready"));
        assert!(!text.contains(data.path().to_str().unwrap()));
    }
    #[test]
    fn malformed_or_extended_records_are_never_exported() {
        let data = data(); append(data.path(), Event::NativeStart).unwrap();
        let path = data.path().join("diagnostics/native-events.jsonl");
        let mut file = options().append(true).open(path).unwrap();
        for line in ["secret-contract-text", r#"{"format":1,"atMillis":1,"event":"native_start","token":"synthetic-secret"}"#, r#"{"format":1,"atMillis":1,"event":"synthetic-secret"}"#] { writeln!(file,"{line}").unwrap(); }
        let text = export_text(data.path()); assert!(!text.contains("secret-contract")); assert!(!text.contains("synthetic-secret")); assert!(text.contains("native_start"));
    }
    #[test]
    fn native_journal_rotation_is_bounded() {
        let data = data(); append(data.path(), Event::NativeStart).unwrap();
        let path = data.path().join("diagnostics/native-events.jsonl");
        options().append(true).open(&path).unwrap().write_all(&vec![b' '; MAX_BYTES as usize]).unwrap();
        append(data.path(), Event::NativeShutdownComplete).unwrap();
        assert!(fs::metadata(path).unwrap().len() < 1024);
        assert!(fs::metadata(data.path().join("diagnostics/native-events.1.jsonl")).unwrap().len() <= MAX_BYTES + 1024);
    }
    #[test]
    fn saving_a_report_cannot_overwrite_an_existing_file() {
        let data = data(); let file = data.path().join("report.log");
        save_new(&file,"safe-report").unwrap(); assert!(save_new(&file,"replacement").is_err()); assert_eq!(fs::read_to_string(file).unwrap(), "safe-report");
    }
    #[cfg(unix)]
    #[test]
    fn linked_journal_and_directory_are_refused() {
        use std::os::unix::fs::symlink;
        let data = data(); let outside = data.path().join("outside"); fs::write(&outside,"private-material").unwrap();
        let folder = data.path().join("diagnostics"); fs::create_dir(&folder).unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&folder,fs::Permissions::from_mode(0o700)).unwrap();
        symlink(&outside,folder.join("native-events.jsonl")).unwrap();
        assert!(append(data.path(),Event::NativeStart).is_none()); assert!(!export_text(data.path()).contains("private-material"));
        assert_eq!(fs::read_to_string(&outside).unwrap(),"private-material");
        fs::remove_file(folder.join("native-events.jsonl")).unwrap();fs::remove_dir(&folder).unwrap();symlink(data.path(),&folder).unwrap();
        assert!(append(data.path(),Event::NativeStart).is_none());
    }
}
