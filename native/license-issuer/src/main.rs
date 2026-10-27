#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use law_license_issuer::{issuer::{Issuer, IssuerState}, permissions};
use serde::{Deserialize, Serialize};
use std::{fs, path::{Path, PathBuf}, sync::{Arc, Mutex}};
use tauri::{Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

const CONFIG_ERROR: &str = "签发器配置无法读取，请重新选择原有签发资料目录。";
const LOCK_ERROR: &str = "签发器正在处理其他请求，请稍后重试。";
#[derive(Default)]
struct Context { issuer: Option<Issuer>, directory: Option<PathBuf>, error: Option<String> }
struct DesktopState { inner: Mutex<Context>, config_directory: PathBuf }
#[derive(Serialize)]
struct Envelope {
    configured: bool,
    #[serde(skip_serializing_if = "Option::is_none")] directory: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] state: Option<IssuerState>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SavedDirectory { version: u8, directory: PathBuf }

impl DesktopState {
    fn new(config_directory: PathBuf) -> Self {
        let mut context = Context::default();
        let path = config_directory.join("issuer-location.json");
        if path.exists() {
            let loaded = (|| {
                #[cfg(unix)] permissions::check_directory(&config_directory)?;
                #[cfg(unix)] permissions::check_file(&path)?;
                let meta = fs::symlink_metadata(&path).map_err(|_| CONFIG_ERROR)?;
                if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 32_768 { return Err(CONFIG_ERROR.to_string()); }
                #[cfg(windows)] {
                    use std::os::windows::fs::MetadataExt;
                    if meta.file_attributes() & 0x400 != 0 { return Err(CONFIG_ERROR.to_string()); }
                }
                use std::io::Read;
                let mut bytes = Vec::new();
                fs::File::open(&path).map_err(|_| CONFIG_ERROR)?.take(32_769).read_to_end(&mut bytes).map_err(|_| CONFIG_ERROR)?;
                if bytes.len() > 32_768 { return Err(CONFIG_ERROR.to_string()); }
                let saved: SavedDirectory = serde_json::from_slice(&bytes).map_err(|_| CONFIG_ERROR)?;
                if saved.version != 1 || !saved.directory.is_absolute() { return Err(CONFIG_ERROR.to_string()); }
                context.directory = Some(saved.directory.clone());
                context.issuer = Some(Issuer::open(&saved.directory)?);
                Ok::<(), String>(())
            })();
            if let Err(error) = loaded { context.error = Some(error); }
        }
        Self { inner: Mutex::new(context), config_directory }
    }
    fn envelope(context: &mut Context) -> Envelope {
        let mut state = None;
        if let Some(issuer) = context.issuer.as_mut() {
            match issuer.state() {
                Ok(value) => { state = Some(value); context.error = None; }
                Err(error) => { context.error = Some(error); context.issuer = None; }
            }
        }
        Envelope { configured: state.is_some(), directory: context.directory.as_ref().map(|path| path.to_string_lossy().into_owned()), error: context.error.clone(), state }
    }
    fn state(&self) -> Result<Envelope, String> {
        let mut context = self.inner.lock().map_err(|_| LOCK_ERROR)?;
        Ok(Self::envelope(&mut context))
    }
    fn connect(&self, directory: PathBuf) -> Result<Envelope, String> {
        let mut context = self.inner.lock().map_err(|_| LOCK_ERROR)?;
        if context.issuer.is_some() && Self::envelope(&mut context).configured {
            return Err("签发资料已经连接。请继续使用原有记录。".into());
        }
        // Opening requires a complete existing ledger. Selecting an empty
        // directory cannot create a second allowance of one hundred seats.
        let issuer = Issuer::open(&directory)?;
        let canonical = fs::canonicalize(directory).map_err(|_| CONFIG_ERROR)?;
        save_directory(&self.config_directory, &canonical)?;
        context.directory = Some(canonical); context.issuer = Some(issuer); context.error = None;
        Ok(Self::envelope(&mut context))
    }
}

fn save_directory(config_directory: &Path, directory: &Path) -> Result<(), String> {
    if !config_directory.exists() {
        #[cfg(unix)] {
            use std::os::unix::fs::DirBuilderExt;
            fs::DirBuilder::new().recursive(true).mode(0o700).create(config_directory).map_err(|_| CONFIG_ERROR)?;
        }
        #[cfg(not(unix))] fs::create_dir_all(config_directory).map_err(|_| CONFIG_ERROR)?;
    }
    // This contains only a folder location. It never stores or copies a key.
    // On Windows the selected signing directory has its own strict ACL check;
    // a normal per-user settings folder is sufficient for this pointer.
    #[cfg(unix)] permissions::check_directory(config_directory)?;
    let bytes = serde_json::to_vec(&SavedDirectory { version: 1, directory: directory.to_path_buf() }).map_err(|_| CONFIG_ERROR)?;
    let mut temporary = tempfile::NamedTempFile::new_in(config_directory).map_err(|_| CONFIG_ERROR)?;
    use std::io::Write;
    temporary.write_all(&bytes).and_then(|_| temporary.as_file().sync_all()).map_err(|_| CONFIG_ERROR)?;
    temporary.persist(config_directory.join("issuer-location.json")).map_err(|_| CONFIG_ERROR)?;
    Ok(())
}
fn local(window: &WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|_| "无法验证本机窗口。")?;
    if !local_origin(window.label(), &url) {
        return Err("仅允许安装软件中的本机窗口使用签发功能。".into());
    }
    Ok(())
}
fn local_origin(label: &str, url: &tauri::Url) -> bool {
    label == "main" && url.port().is_none() && url.username().is_empty() && url.password().is_none()
        && (url.scheme() == "tauri" && url.host_str() == Some("localhost")
            || url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
}
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|_| "签发操作未能完成，请检查原有记录。".to_string())?
}
#[tauri::command]
async fn issuer_state(window: WebviewWindow, state: tauri::State<'_, Arc<DesktopState>>) -> Result<Envelope, String> {
    local(&window)?; let state = state.inner().clone(); blocking(move || state.state()).await
}
#[tauri::command]
async fn issuer_select_directory(window: WebviewWindow, app: tauri::AppHandle, state: tauri::State<'_, Arc<DesktopState>>) -> Result<Envelope, String> {
    local(&window)?; let state = state.inner().clone();
    blocking(move || {
        if state.state()?.configured { return state.state(); }
        let Some(selected) = app.dialog().file().set_title("选择原有签发资料目录（含私钥、记录和标识）").blocking_pick_folder() else { return state.state(); };
        let path = selected.into_path().map_err(|_| "请选择本机资料目录。")?;
        state.connect(path)
    }).await
}
#[tauri::command]
async fn issuer_issue(window: WebviewWindow, state: tauri::State<'_, Arc<DesktopState>>, device_code: String, starts_at: Option<String>) -> Result<serde_json::Value, String> {
    local(&window)?; let state = state.inner().clone();
    blocking(move || {
        let mut context = state.inner.lock().map_err(|_| LOCK_ERROR)?;
        let issuer = context.issuer.as_mut().ok_or("请先选择原有签发资料目录。")?;
        let result = issuer.issue(device_code, starts_at)?;
        serde_json::to_value(result).map_err(|_| "签发记录已写入，请从历史中取回原激活码。".to_string())
    }).await
}
#[tauri::command]
async fn issuer_token(window: WebviewWindow, state: tauri::State<'_, Arc<DesktopState>>, license_id: String) -> Result<String, String> {
    local(&window)?; let state = state.inner().clone();
    blocking(move || {
        let mut context = state.inner.lock().map_err(|_| LOCK_ERROR)?;
        context.issuer.as_mut().ok_or("请先连接签发资料。")?.get_token(license_id)
    }).await
}
#[tauri::command]
async fn issuer_export_token(window: WebviewWindow, app: tauri::AppHandle, state: tauri::State<'_, Arc<DesktopState>>, license_id: String) -> Result<bool, String> {
    local(&window)?; let state = state.inner().clone();
    blocking(move || {
        let token = {
            let mut context = state.inner.lock().map_err(|_| LOCK_ERROR)?;
            context.issuer.as_mut().ok_or("请先连接签发资料。")?.get_token(license_id.clone())?
        };
        let Some(selected) = app.dialog().file().set_title("保存激活码").set_file_name(format!("lawagent-{license_id}.lawlicense")).add_filter("LawAgent activation code", &["lawlicense"]).blocking_save_file() else { return Ok(false); };
        let path = selected.into_path().map_err(|_| "请选择本机文件位置。")?;
        // Create-new protects existing files (including all signing material)
        // even when a path is selected again in the system save dialog.
        permissions::create_private_file(&path, format!("{token}\n").as_bytes())
            .map_err(|_| "文件未保存，请选择一个尚不存在的新文件名。".to_string())?;
        Ok(true)
    }).await
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") { let _ = window.show(); let _ = window.set_focus(); }
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let config = app.path().app_config_dir()?;
            app.manage(Arc::new(DesktopState::new(config)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![issuer_state, issuer_select_directory, issuer_issue, issuer_token, issuer_export_token])
        .run(tauri::generate_context!())
        .expect("Could not start the local issuer window");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn empty_installation_does_not_create_signing_state() {
        let root = tempfile::tempdir().unwrap();
        let config = root.path().join("settings");
        let state = DesktopState::new(config.clone());
        assert!(!state.state().unwrap().configured);
        assert!(!config.exists());
        assert!(state.connect(root.path().join("empty")).is_err());
        assert!(!root.path().join("empty").exists());
    }
    #[test]
    fn invalid_settings_do_not_initialize_a_ledger() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("issuer-location.json"), b"invalid").unwrap();
        let state = DesktopState::new(root.path().into());
        let envelope = state.state().unwrap();
        assert!(!envelope.configured); assert!(envelope.error.is_some());
        assert!(!root.path().join("licenses.sqlite").exists());
    }
    #[test]
    fn saved_nonsecret_pointer_survives_restart_without_becoming_a_ledger() {
        let root = tempfile::tempdir().unwrap();
        let config = root.path().join("settings");
        let missing = root.path().join("retained-issuer");
        save_directory(&config, &missing).unwrap();
        let state = DesktopState::new(config.clone());
        let value = state.state().unwrap();
        assert_eq!(value.directory, Some(missing.to_string_lossy().into_owned()));
        assert!(!value.configured); assert!(value.error.is_some());
        assert!(!missing.exists()); assert!(!config.join("licenses.sqlite").exists());
        assert_eq!(fs::read_dir(config).unwrap().count(), 1);
    }
    #[test]
    fn oversized_settings_are_refused() {
        let root = tempfile::tempdir().unwrap();
        let config = root.path().join("settings");
        save_directory(&config, &root.path().join("issuer")).unwrap();
        fs::write(config.join("issuer-location.json"), vec![b' '; 32_769]).unwrap();
        let value = DesktopState::new(config).state().unwrap();
        assert!(!value.configured); assert!(value.error.is_some()); assert!(value.directory.is_none());
    }
    #[test]
    fn only_local_main_window_origins_are_admitted() {
        for value in ["tauri://localhost/index.html", "http://tauri.localhost/index.html"] {
            assert!(local_origin("main", &tauri::Url::parse(value).unwrap()));
            assert!(!local_origin("other", &tauri::Url::parse(value).unwrap()));
        }
        for value in ["https://tauri.localhost", "http://tauri.localhost:56882", "http://localhost", "tauri://evil", "tauri://user@localhost", "http://tauri.localhost.evil", "file:///tmp/index.html"] {
            assert!(!local_origin("main", &tauri::Url::parse(value).unwrap()), "{value}");
        }
    }
}
