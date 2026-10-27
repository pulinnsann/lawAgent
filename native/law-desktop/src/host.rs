use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{collections::HashMap, path::{Path, PathBuf}, sync::{Arc, atomic::{AtomicBool, Ordering}}};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tokio::{io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader}, process::{Child, ChildStdin, Command}, sync::{oneshot, Mutex, Notify}};

const MAX_FRAME: usize = 64 * 1024 * 1024;
// A timed-out JS vault request cannot cancel an in-progress system call. Keep
// the permit inside that blocking job until the OS actually returns, so a locked
// keychain cannot accumulate unbounded jobs or occupy the async IPC executor.
static CREDENTIAL_JOBS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
async fn credential_job<F>(operation: F) -> Result<Value, String>
where F: FnOnce() -> Result<Value, String> + Send + 'static {
    let permit = CREDENTIAL_JOBS.try_acquire().map_err(|_| "System credential service is busy. Retry after the current operation finishes.".to_owned())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        operation()
    }).await.map_err(|_| "System credential operation could not finish.".to_owned())?
}
type Reply = oneshot::Sender<Result<Value, String>>;

async fn register_reply(pending: &Mutex<HashMap<String, Reply>>, failed: &AtomicBool, stopping: &AtomicBool, id: String) -> Result<oneshot::Receiver<Result<Value, String>>, String> {
    let mut pending = pending.lock().await;
    // Readiness can become stale while this caller waits for the map. Failure
    // sets its flag before draining under this same lock, so a reply is either
    // included in that drain or refused here; none can be inserted afterward.
    if failed.load(Ordering::Acquire) { return Err("Local service stopped. Restart the application; saved contracts are retained.".into()); }
    if stopping.load(Ordering::Acquire) { return Err("The application is closing. Please wait for file operations to finish.".into()); }
    if pending.len() >= 32 { return Err("Too many desktop requests are running.".into()); }
    let (send, receive) = oneshot::channel();
    pending.insert(id, send);
    Ok(receive)
}

struct Backend {
    input: Mutex<ChildStdin>,
    child: Mutex<Child>,
    pending: Mutex<HashMap<String, Reply>>,
    ready: AtomicBool,
    failed: AtomicBool,
    stopping: AtomicBool,
    stopped: AtomicBool,
    draining: AtomicBool,
    changed: Notify,
}
impl Backend {
    async fn write(&self, frame: Value) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(&frame).map_err(|_| "Invalid desktop request.")?;
        if bytes.len() > MAX_FRAME { return Err("Desktop request exceeds its byte limit.".into()); }
        bytes.push(b'\n');
        let mut input = self.input.lock().await;
        input.write_all(&bytes).await.map_err(|_| "Desktop backend connection closed.".to_owned())
    }
    async fn fail(&self) {
        if !self.failed.swap(true, Ordering::AcqRel) { crate::diagnostics::record(crate::diagnostics::Event::NativeBackendStopped); }
        for (_, reply) in self.pending.lock().await.drain() { let _ = reply.send(Err("Local service stopped. Restart the application; saved contracts are retained.".into())); }
        self.changed.notify_waiters();
    }
    async fn wait_ready(&self) -> Result<(), String> {
        loop {
            let notified = self.changed.notified();
            if self.failed.load(Ordering::Acquire) { return Err("Local service could not start. Check the workspace permissions and restart.".into()); }
            if self.ready.load(Ordering::Acquire) { return Ok(()); }
            notified.await;
        }
    }
    async fn invoke(&self, name: String, payload: Value) -> Result<Value, String> {
        if self.stopping.load(Ordering::Acquire) { return Err("The application is closing. Please wait for file operations to finish.".into()); }
        tokio::time::timeout(std::time::Duration::from_secs(60), self.wait_ready()).await.map_err(|_| "Local service startup timed out.")??;
        let id = uuid::Uuid::new_v4().to_string();
        let receive = register_reply(&self.pending, &self.failed, &self.stopping, id.clone()).await?;
        if let Err(error) = self.write(json!({"type":"invoke","id":id,"name":name,"payload":payload})).await { self.pending.lock().await.remove(&id); return Err(error); }
        // Commands retain their existing backend timeouts; long maintenance copies
        // must finish publication/rollback instead of being killed on a timer.
        receive.await.map_err(|_| "Local service connection closed.".to_owned())?
    }
    async fn shutdown(&self) {
        if self.stopping.swap(true, Ordering::AcqRel) { return; }
        crate::diagnostics::record(crate::diagnostics::Event::NativeShutdownStart);
        if self.failed.load(Ordering::Acquire) { let _ = self.child.lock().await.kill().await; self.stopped.store(true, Ordering::Release); return; }
        let sent = self.write(json!({"type":"shutdown","id":"shutdown"})).await.is_ok();
        if sent {
            let mut deadline = None;
            loop {
                let notified = self.changed.notified();
                if self.stopped.load(Ordering::Acquire) || self.failed.load(Ordering::Acquire) { break; }
                if self.draining.load(Ordering::Acquire) {
                    let end = *deadline.get_or_insert_with(|| tokio::time::Instant::now() + std::time::Duration::from_secs(35));
                    if tokio::time::timeout_at(end, notified).await.is_err() {
                        self.fail().await;
                        break;
                    }
                } else {
                    deadline = None;
                    notified.await;
                }
            }
        }
        if !sent || (self.failed.load(Ordering::Acquire) && !self.stopped.load(Ordering::Acquire)) { let _ = self.child.lock().await.kill().await; }
        let _ = self.child.lock().await.wait().await;
        self.stopped.store(true, Ordering::Release);
        crate::diagnostics::record(crate::diagnostics::Event::NativeShutdownComplete);
    }
}

#[tauri::command]
async fn desktop_invoke(window: tauri::WebviewWindow, backend: tauri::State<'_, Arc<Backend>>, name: String, payload: Option<Value>) -> Result<Value, String> {
    if window.label() != "main" || !allowed_url(&window.url().map_err(|_| "Invalid window origin.")?, development_url(window.app_handle()).as_ref()) { return Err("Unrecognized application request.".into()); }
    if name.len() > 100 || serde_json::to_vec(&payload).map_err(|_| "Invalid request.")?.len() > 8 * 1024 * 1024 { return Err("Desktop request exceeds its input limit.".into()); }
    if let Some(action) = diagnostic_action(&name, payload.as_ref()) {
        if backend.failed.load(Ordering::Acquire) || !backend.ready.load(Ordering::Acquire) {
            let app = window.app_handle().clone();
            if action == "maintenance.diagnosticsStatus" { return Ok(json!({"ok":true,"data":{"available":true,"retentionFiles":2,"maxFileBytes":crate::diagnostics::MAX_BYTES,"nativeOnly":true}})); }
            return match export_native_diagnostics(app).await { Ok(data) => Ok(json!({"ok":true,"data":data})), Err(error) => Ok(json!({"ok":false,"error":error})) };
        }
    }
    backend.invoke(name, payload.unwrap_or(Value::Null)).await
}
fn diagnostic_action<'a>(name: &str, payload: Option<&'a Value>) -> Option<&'a str> {
    if name != "runWorkspaceCommand" { return None; }
    let object = payload?.as_object()?;
    if object.keys().any(|key| !matches!(key.as_str(), "action" | "payload" | "requestId")) { return None; }
    if let Some(request) = object.get("requestId") { if uuid::Uuid::parse_str(request.as_str()?).is_err() { return None; } }
    if let Some(input) = object.get("payload") { if !input.as_object()?.is_empty() { return None; } }
    let action = object.get("action")?.as_str()?;
    ["maintenance.diagnosticsStatus", "maintenance.exportDiagnostics"].contains(&action).then_some(action)
}
async fn export_native_diagnostics(app: tauri::AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let check_open = || -> Result<(), String> {
            if app.try_state::<Arc<Backend>>().is_some_and(|state| state.stopping.load(Ordering::Acquire)) {
                return Err("应用正在关闭，未保存新的问题日志。".into());
            }
            Ok(())
        };
        check_open()?;
        let data = workspace_path(app.path().config_dir().map_err(|_| "无法定位问题日志。")?)?;
        let text = crate::diagnostics::export_text(&data);
        let epoch = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |time| time.as_secs());
        let selected = app.dialog().file().set_title("保存启动问题日志 / Save startup log").set_file_name(format!("LawAgent-startup-{epoch}.log")).add_filter("Problem log", &["log"]).blocking_save_file();
        let Some(selected) = selected else { return Ok(Value::Null); };
        check_open()?;
        let path = selected.into_path().map_err(|_| "请选择本机保存位置。")?;
        crate::diagnostics::save_new(&path, &text)?;
        Ok(json!({"path":path,"fileName":path.file_name().map(|name|name.to_string_lossy()),"bytes":text.len()}))
    }).await.map_err(|_| "启动日志未能保存，请重新打开软件后重试。".to_string())?
}
fn local_url(url: &tauri::Url) -> bool {
    (url.scheme() == "tauri" && url.host_str() == Some("localhost")) || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"))
}
fn development_url(app: &tauri::AppHandle) -> Option<tauri::Url> {
    if cfg!(debug_assertions) { app.config().build.dev_url.clone() } else { None }
}
fn allowed_url(url: &tauri::Url, development: Option<&tauri::Url>) -> bool {
    local_url(url) || development.is_some_and(|expected| {
        matches!(expected.scheme(), "http" | "https")
            && matches!(expected.host_str(), Some("localhost" | "127.0.0.1" | "[::1]" | "::1"))
            && expected.origin() == url.origin()
    })
}
fn workspace_path(config: PathBuf) -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("LAW_AGENT_DATA_DIR").filter(|path| !path.is_empty()) {
        let path = PathBuf::from(path);
        return Ok(if path.is_absolute() { path } else { std::env::current_dir().map_err(|_| "Invalid workspace path.")?.join(path) });
    }
    if cfg!(debug_assertions) { return Ok(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.local/data")); }
    // Electron computed getPath('userData') before setName('合同工作台').
    // The packaged name was law-agent-desktop; preserve that exact root.
    Ok(config.join("law-agent-desktop"))
}
fn runtime_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(resources) = app.path().resource_dir() {
        let bundled = resources.join("runtime");
        if bundled.join("backend/backend.js").is_file() { return Ok(bundled); }
    }
    if cfg!(debug_assertions) || cfg!(feature = "desktop-smoke") {
        let development = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.local/tauri-runtime");
        if development.join("backend/backend.js").is_file() { return Ok(development); }
    }
    Err("The bundled review engine is missing. Reinstall the application.".into())
}
fn start_backend(app: tauri::AppHandle, runtime: PathBuf, data: PathBuf) -> Result<Arc<Backend>, String> {
    let node = runtime.join("bin").join(if cfg!(windows) { "node.exe" } else { "node" });
    if !node.is_file() { return Err("The bundled Node review runtime is missing.".into()); }
    let mut command = Command::new(node);
    command.arg(runtime.join("backend/backend.js")).current_dir(&runtime)
        .env("LAW_AGENT_DATA_DIR", &data).env("LAW_AGENT_RESOURCES_DIR", &runtime)
        .env_remove("NODE_OPTIONS").env_remove("NODE_PATH").env_remove("ELECTRON_RUN_AS_NODE")
        .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).kill_on_drop(true);
    #[cfg(windows)] command.creation_flags(0x08000000);
    let mut child = command.spawn().map_err(|_| "Could not start the bundled review engine.".to_owned())?;
    let input = child.stdin.take().ok_or("Missing review engine input.")?;
    let output = child.stdout.take().ok_or("Missing review engine output.")?;
    let backend = Arc::new(Backend { input: Mutex::new(input), child: Mutex::new(child), pending: Mutex::new(HashMap::new()), ready: AtomicBool::new(false), failed: AtomicBool::new(false), stopping: AtomicBool::new(false), stopped: AtomicBool::new(false), draining: AtomicBool::new(false), changed: Notify::new() });
    let session = backend.clone();
    tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(output);
        loop {
            let mut bytes = Vec::new();
            let result = (&mut reader).take((MAX_FRAME + 2) as u64).read_until(b'\n', &mut bytes).await;
            if !matches!(result, Ok(n) if n > 0) || bytes.len() > MAX_FRAME + 1 || bytes.last() != Some(&b'\n') { break; }
            let frame: Value = match serde_json::from_slice(&bytes) { Ok(frame) => frame, Err(_) => break };
            match frame["type"].as_str() {
                Some("ready") if frame["protocol"] == 1 => { session.ready.store(true, Ordering::Release); crate::diagnostics::record(crate::diagnostics::Event::NativeBackendReady); session.changed.notify_waiters(); }
                Some("response") => { if let Some(id) = frame["id"].as_str() { if let Some(reply) = session.pending.lock().await.remove(id) { let _ = reply.send(if let Some(error) = frame["error"].as_str() { Err(error.to_owned()) } else { Ok(frame["data"].clone()) }); } } }
                Some("task") => { let _ = app.emit_to("main", "desktop-task", &frame["task"]); }
                Some("host") => {
                    let session = session.clone(); let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let result = host_operation(app, frame["operation"].as_str().unwrap_or_default(), frame["payload"].clone()).await;
                        let answer = match result { Ok(data) => json!({"type":"hostResponse","id":frame["id"],"data":data}), Err(error) => json!({"type":"hostResponse","id":frame["id"],"error":error}) };
                        if session.write(answer).await.is_err() { session.fail().await; }
                    });
                }
                Some("shutdownComplete") => { session.stopped.store(true, Ordering::Release); session.changed.notify_waiters(); }
                Some("shutdownDeferred") => { session.draining.store(false, Ordering::Release); session.changed.notify_waiters(); }
                Some("shutdownProgress") if frame["phase"] == "draining" => { session.draining.store(true, Ordering::Release); session.changed.notify_waiters(); }
                _ => break,
            }
        }
        session.fail().await;
    });
    Ok(backend)
}

fn text<'a>(payload: &'a Value, name: &str) -> Result<&'a str, String> { payload[name].as_str().ok_or_else(|| "Invalid native desktop request.".into()) }
fn license_build_mode() -> &'static str {
    if cfg!(feature = "desktop-smoke") { "development" } else { "required" }
}
async fn host_operation(app: tauri::AppHandle, operation: &str, payload: Value) -> Result<Value, String> {
    match operation {
        "readNativeDiagnostics" => {
            let data = workspace_path(app.path().config_dir().map_err(|_| "Diagnostics unavailable.")?)?;
            Ok(json!({"text":crate::diagnostics::export_text(&data)}))
        }
        "resourcePressure" => Ok(json!(crate::platform::resource_pressure::sample())),
        "deviceIdentity" => Ok(json!(crate::platform::device_identity::sample())),
        "licenseBuildMode" => Ok(json!(license_build_mode())),
        "showOpenDialog" | "showSaveDialog" => native_dialog(app, operation, payload).await,
        "setTitle" => { if let Some(window) = app.get_webview_window("main") { window.set_title(text(&payload, "title")?).map_err(|_| "Could not update the window title.")?; } Ok(Value::Null) }
        "showItemInFolder" => { app.opener().reveal_item_in_dir(text(&payload, "path")?).map_err(|_| "Could not reveal the source document.")?; Ok(Value::Null) }
        "openExternal" => { let url = tauri::Url::parse(text(&payload, "url")?).map_err(|_| "Invalid source URL.")?; if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() { return Err("Unsafe source URL.".into()); } app.opener().open_url(url.as_str(), None::<&str>).map_err(|_| "Could not open the source website.")?; Ok(Value::Null) }
        "renderPdf" => { let bytes = crate::platform::render_pdf(app, text(&payload, "html")?.to_owned()).await?; Ok(json!({"base64":STANDARD.encode(bytes)})) }
        "credentialAvailable" => Ok(json!(crate::platform::credentials::available())),
        "credentialEncrypt" => {
            let value = text(&payload, "value")?.to_owned();
            credential_job(move || Ok(json!({"base64":crate::platform::credentials::encrypt(value)?}))).await
        }
        "credentialDecrypt" => {
            let value = text(&payload, "base64")?.to_owned();
            credential_job(move || Ok(json!({"result":crate::platform::credentials::decrypt(value)?}))).await
        }
        _ => Err("Unsupported native desktop operation.".into()),
    }
}
async fn native_dialog(app: tauri::AppHandle, operation: &str, payload: Value) -> Result<Value, String> {
    #[cfg(feature = "desktop-smoke")]
    if let Some(answer) = smoke_dialog(operation, &payload)? { return Ok(answer); }
    let mut picker = app.dialog().file().set_title(payload["title"].as_str().unwrap_or("合同工作台"));
    if let Some(window) = app.get_webview_window("main") { picker = picker.set_parent(&window); }
    if let Some(filters) = payload["filters"].as_array() { for filter in filters { let extensions: Vec<&str> = filter["extensions"].as_array().map(|items| items.iter().filter_map(Value::as_str).collect()).unwrap_or_default(); picker = picker.add_filter(filter["name"].as_str().unwrap_or("Files"), &extensions); } }
    let (send, receive) = oneshot::channel();
    if operation == "showSaveDialog" {
        if let Some(path) = payload["defaultPath"].as_str() { picker = picker.set_file_name(path); }
        picker.save_file(move |selected| { let result = selected.and_then(|path| path.into_path().ok()).map(|path| json!({"canceled":false,"filePath":path})).unwrap_or(json!({"canceled":true})); let _ = send.send(result); });
    } else {
        let folder = payload["properties"].as_array().is_some_and(|items| items.iter().any(|item| item == "openDirectory"));
        let callback = move |selected: Option<tauri_plugin_dialog::FilePath>| { let result = selected.and_then(|path| path.into_path().ok()).map(|path| json!({"canceled":false,"filePaths":[path]})).unwrap_or(json!({"canceled":true,"filePaths":[]})); let _ = send.send(result); };
        if folder { picker.pick_folder(callback); } else { picker.pick_file(callback); }
    }
    receive.await.map_err(|_| "Native file dialog closed unexpectedly.".into())
}
#[cfg(feature = "desktop-smoke")]
fn smoke_dialog(operation: &str, payload: &Value) -> Result<Option<Value>, String> {
    use std::sync::{OnceLock, Mutex as StdMutex};
    static QUEUES: OnceLock<StdMutex<Value>> = OnceLock::new();
    let Some(path) = std::env::var_os("LAW_AGENT_SMOKE_DIALOGS") else { return Ok(None); };
    let queues = QUEUES.get_or_init(|| StdMutex::new(std::fs::read(path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or(Value::Null)));
    let mut queues = queues.lock().map_err(|_| "Test dialog queue is unavailable.")?;
    let key = if operation == "showSaveDialog" { "saveFiles" } else if payload["properties"].as_array().is_some_and(|items| items.iter().any(|item| item == "openDirectory")) { "folders" } else { "openFiles" };
    let values = queues[key].as_array_mut().ok_or("Test dialog queue is missing.")?;
    if values.is_empty() { return Err(format!("Test dialog queue exhausted: {key}")); }
    let value = values.remove(0);
    if value.is_null() { return Ok(Some(json!({"canceled":true,"filePaths":[]}))); }
    Ok(Some(if key == "saveFiles" { json!({"canceled":false,"filePath":value}) } else { json!({"canceled":false,"filePaths":[value]}) }))
}

#[derive(Default)]
struct Lifecycle {
    closing: AtomicBool,
    finished: AtomicBool,
    exiting: AtomicBool,
    reopen: AtomicBool,
    replacement_started: AtomicBool,
}
fn spawn_replacement(lifecycle: &Lifecycle) {
    if lifecycle.replacement_started.swap(true, Ordering::AcqRel) { return; }
    let Ok(executable) = std::env::current_exe() else { return; };
    let mut command = std::process::Command::new(executable);
    command.args(std::env::args_os().skip(1)).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(feature = "desktop-smoke")]
    {
        for (source, destination) in [("LAW_AGENT_SMOKE_REOPEN_SCRIPT", "LAW_AGENT_SMOKE_SCRIPT"), ("LAW_AGENT_SMOKE_REOPEN_OUTPUT", "LAW_AGENT_SMOKE_OUTPUT")] {
            if let Some(value) = std::env::var_os(source) { command.env(destination, value); }
        }
    }
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    if command.spawn().is_err() { eprintln!("The application could not reopen. Please start it again."); }
}
fn initialize(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(feature = "desktop-smoke")]
    if std::env::var_os("LAW_AGENT_SMOKE_FORCE_STARTUP_FAILURE").is_some() { return Err("Synthetic unavailable runtime".into()); }
    let data = workspace_path(app.path().config_dir()?)?;
    std::fs::create_dir_all(&data)?;
    crate::diagnostics::initialize(&data);
    let runtime = runtime_path(app.handle())?;
    let backend = tauri::async_runtime::block_on(async { start_backend(app.handle().clone(), runtime, data.clone()) })?;
    app.manage(backend);
    let development = development_url(app.handle());
    let window = tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
        .title("合同工作台").inner_size(1480.0, 980.0).min_inner_size(760.0, 560.0)
        .data_directory(data.join("webview-tauri"))
        .on_navigation(move |url| allowed_url(url, development.as_ref()))
        .initialization_script("document.addEventListener('contextmenu',event=>event.preventDefault());");
    #[cfg(feature = "desktop-smoke")]
    let window = if let Some(path) = std::env::var_os("LAW_AGENT_SMOKE_SCRIPT") { window.initialization_script(std::fs::read_to_string(path)?) } else { window };
    window.build()?;
    crate::diagnostics::record(crate::diagnostics::Event::NativeReady);
    Ok(())
}
fn startup_failure(app: &tauri::AppHandle) {
    crate::diagnostics::record(crate::diagnostics::Event::NativeStartupFailed);
    // Returning Err from Tauri's setup callback panics inside its event loop.
    // Report an ordinary launch failure instead of raising a macOS crash dialog.
    eprintln!("Desktop startup failed. Check the installed resources and workspace permissions.");
    #[cfg(feature = "desktop-smoke")]
    if std::env::var_os("LAW_AGENT_SMOKE_OUTPUT").is_some() {
        let _ = crate::smoke::desktop_smoke_report(app.clone(), json!({"final":true,"passed":false,"startupFailure":true,"error":"Desktop startup failed."}));
        return;
    }
    let handle = app.clone();
    app.dialog().message("软件暂时未能启动，已保存的合同不会因此删除。可以保存启动日志，交给支持人员排查。\nThe application could not start. Saved contracts are retained. You can save a startup log for support.")
        .title("合同工作台 / LawAgent").kind(tauri_plugin_dialog::MessageDialogKind::Error)
        .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom("保存问题日志 / Save log".into(), "关闭 / Close".into()))
        .show(move |save| { if save { tauri::async_runtime::spawn(async move {
            if export_native_diagnostics(handle.clone()).await.is_err() {
                let exit = handle.clone();
                handle.dialog().message("日志未能保存，请换一个保存位置后重新打开软件再试。\nThe log could not be saved. Choose a different location after reopening the app.").title("合同工作台 / LawAgent").show(move |_| exit.exit(1));
            } else { handle.exit(1); }
        }); } else { handle.exit(1); } });
}
pub fn run() {
    let lifecycle = Arc::new(Lifecycle::default());
    let instance_lifecycle = lifecycle.clone();
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(move |app, _args, _cwd| {
            if instance_lifecycle.closing.load(Ordering::Acquire) {
                instance_lifecycle.reopen.store(true, Ordering::Release);
                if instance_lifecycle.exiting.load(Ordering::Acquire) { spawn_replacement(&instance_lifecycle); }
            } else if let Some(window) = app.get_webview_window("main") { let _ = window.unminimize(); let _ = window.set_focus(); }
        }))
        .plugin(tauri_plugin_dialog::init()).plugin(tauri_plugin_opener::init());
    #[cfg(not(feature = "desktop-smoke"))]
    let builder = builder.invoke_handler(tauri::generate_handler![desktop_invoke]);
    #[cfg(feature = "desktop-smoke")]
    let builder = builder.invoke_handler(tauri::generate_handler![desktop_invoke, crate::smoke::desktop_smoke_report]);
    let context = tauri::generate_context!();
    #[cfg(feature = "desktop-smoke")]
    let context = {
        let mut context = context;
        context.config_mut().identifier.push_str(".diagnostics");
        context
    };
    let application = match builder.setup(|app| {
        if initialize(app).is_err() { startup_failure(app.handle()); }
        Ok(())
    }).build(context) {
        Ok(application) => application,
        Err(_) => { eprintln!("Could not initialize the desktop workbench."); std::process::exit(1); }
    };
    application.run(move |app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            // Tauri dispatches plugin Exit handlers first, so the singleton socket
            // or Windows mutex has been released exactly once before reopening.
            lifecycle.exiting.store(true, Ordering::Release);
            if lifecycle.reopen.load(Ordering::Acquire) { spawn_replacement(&lifecycle); }
        }
        #[cfg(target_os = "macos")]
        if matches!(event, tauri::RunEvent::Reopen { .. }) {
            if lifecycle.closing.load(Ordering::Acquire) { lifecycle.reopen.store(true, Ordering::Release); }
            else if let Some(window) = app.get_webview_window("main") { let _ = window.unminimize(); let _ = window.set_focus(); }
        }
        if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
            if lifecycle.finished.load(Ordering::Acquire) { return; }
            let Some(state) = app.try_state::<Arc<Backend>>() else { return; };
            api.prevent_exit();
            if lifecycle.closing.swap(true, Ordering::AcqRel) { return; }
            let app = app.clone(); let lifecycle = lifecycle.clone(); let backend = state.inner().clone();
            tauri::async_runtime::spawn(async move {
                #[cfg(feature = "desktop-smoke")]
                if let Ok(delay) = std::env::var("LAW_AGENT_SMOKE_SHUTDOWN_DELAY_MS") {
                    if let Ok(milliseconds) = delay.parse::<u64>() { tokio::time::sleep(std::time::Duration::from_millis(milliseconds.min(1000))).await; }
                }
                let pdf_cleanup = tauri::async_runtime::spawn(crate::platform::cancel_pdf_exports(app.clone()));
                backend.shutdown().await;
                let _ = pdf_cleanup.await;
                // The plugin releases singleton ownership on Exit. Spawning
                // earlier would let the old Exit handler delete the new socket.
                lifecycle.finished.store(true, Ordering::Release);
                app.exit(code.unwrap_or(0));
            });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn native_diagnostics_fallback_accepts_only_empty_export_commands() {
        for action in ["maintenance.exportDiagnostics", "maintenance.diagnosticsStatus"] {
            let input = json!({"action":action,"payload":{}});
            assert_eq!(diagnostic_action("runWorkspaceCommand",Some(&input)),Some(action));
            assert!(diagnostic_action("other",Some(&input)).is_none());
            assert!(diagnostic_action("runWorkspaceCommand",Some(&json!({"action":action,"payload":{"path":"untrusted"}}))).is_none());
            assert!(diagnostic_action("runWorkspaceCommand",Some(&json!({"action":action,"privateKey":"untrusted"}))).is_none());
        }
        assert!(diagnostic_action("runWorkspaceCommand",Some(&json!({"action":"maintenance.restore","payload":{}}))).is_none());
        assert!(diagnostic_action("runWorkspaceCommand",None).is_none());
    }
    #[test] fn official_builds_require_licensing_and_only_smoke_builds_are_development() {
        #[cfg(not(feature = "desktop-smoke"))]
        assert_eq!(license_build_mode(), "required");
        #[cfg(feature = "desktop-smoke")]
        assert_eq!(license_build_mode(), "development");
    }
    #[test] fn stale_ready_registration_cannot_survive_a_failure_drain() {
        tauri::async_runtime::block_on(async {
            use std::{future::{poll_fn, Future}, task::Poll};
            let pending = Mutex::new(HashMap::new());
            let failed = AtomicBool::new(false);
            let stopping = AtomicBool::new(false);
            let mut locked = pending.lock().await;
            let mut registration = Box::pin(register_reply(&pending, &failed, &stopping, "stale-ready".into()));
            // Deterministically park the caller after its readiness check, at
            // the same mutex that fail() uses. No scheduling sleeps are needed.
            poll_fn(|cx| {
                assert!(registration.as_mut().poll(cx).is_pending());
                Poll::Ready(())
            }).await;
            failed.store(true, Ordering::Release);
            for (_, reply) in locked.drain() { let _ = reply.send(Err("Local service stopped.".into())); }
            drop(locked);
            let result = tokio::time::timeout(std::time::Duration::from_secs(1), registration).await.expect("Registration must settle after the failure drain");
            assert!(result.unwrap_err().contains("Local service stopped"));
            assert!(pending.lock().await.is_empty(), "A failed backend must not retain an orphan reply");
        });
    }
    #[test] fn admitted_replies_remain_owned_until_failure_drains_them() {
        tauri::async_runtime::block_on(async {
            let pending = Mutex::new(HashMap::new());
            let failed = AtomicBool::new(false);
            let stopping = AtomicBool::new(false);
            let mut receive = register_reply(&pending, &failed, &stopping, "admitted".into()).await.unwrap();
            assert!(matches!(receive.try_recv(), Err(oneshot::error::TryRecvError::Empty)));
            failed.store(true, Ordering::Release);
            for (_, reply) in pending.lock().await.drain() { let _ = reply.send(Err("Local service stopped.".into())); }
            assert!(receive.await.unwrap().unwrap_err().contains("Local service stopped"));
            assert!(pending.lock().await.is_empty());
            assert!(register_reply(&pending, &failed, &stopping, "late".into()).await.unwrap_err().contains("Local service stopped"));
        });
    }
    #[test] fn reply_capacity_and_closing_refuse_new_requests_without_releasing_admitted_work() {
        tauri::async_runtime::block_on(async {
            let pending = Mutex::new(HashMap::new());
            let failed = AtomicBool::new(false);
            let stopping = AtomicBool::new(false);
            let mut receivers = Vec::new();
            for index in 0..32 { receivers.push(register_reply(&pending, &failed, &stopping, index.to_string()).await.unwrap()); }
            assert!(register_reply(&pending, &failed, &stopping, "overflow".into()).await.unwrap_err().contains("Too many"));
            assert_eq!(pending.lock().await.len(), 32);
            stopping.store(true, Ordering::Release);
            assert!(register_reply(&pending, &failed, &stopping, "closing".into()).await.unwrap_err().contains("closing"));
            for receive in &mut receivers { assert!(matches!(receive.try_recv(), Err(oneshot::error::TryRecvError::Empty))); }
            for (id, reply) in pending.lock().await.drain() { reply.send(Ok(json!(id))).unwrap(); }
            for (index, receive) in receivers.into_iter().enumerate() { assert_eq!(receive.await.unwrap().unwrap(), json!(index.to_string())); }
        });
    }
    #[test] fn credential_jobs_are_bounded_and_run_outside_the_ipc_thread() {
        let first = CREDENTIAL_JOBS.try_acquire().unwrap();
        let second = CREDENTIAL_JOBS.try_acquire().unwrap();
        let rejected = tauri::async_runtime::block_on(credential_job(|| panic!("Busy credential operation must not execute.")));
        assert!(rejected.unwrap_err().contains("busy"));
        drop(first); drop(second);
        let caller = format!("{:?}", std::thread::current().id());
        let worker = tauri::async_runtime::block_on(credential_job(|| Ok(json!(format!("{:?}", std::thread::current().id()))))).unwrap();
        assert_ne!(worker.as_str(), Some(caller.as_str()));
        assert_eq!(CREDENTIAL_JOBS.available_permits(), 2);
    }
    #[test] fn development_origin_is_exact_and_loopback_only() {
        let expected = tauri::Url::parse("http://127.0.0.1:1430").unwrap();
        assert!(allowed_url(&tauri::Url::parse("http://127.0.0.1:1430/index.html").unwrap(), Some(&expected)));
        assert!(!allowed_url(&tauri::Url::parse("http://127.0.0.1:1431/").unwrap(), Some(&expected)));
        assert!(!allowed_url(&tauri::Url::parse("http://127.0.0.1:1430/").unwrap(), None));
        let remote = tauri::Url::parse("https://example.com").unwrap();
        assert!(!allowed_url(&remote, Some(&remote)));
    }
    #[test] fn remote_navigation_is_denied() {
        for url in ["https://example.com", "https://tauri.localhost.evil/index.html", "file:///tmp/report.html", "data:text/html,test"] { assert!(!local_url(&tauri::Url::parse(url).unwrap())); }
        for url in ["tauri://localhost/index.html", "http://tauri.localhost/index.html"] { assert!(local_url(&tauri::Url::parse(url).unwrap())); }
    }
}
