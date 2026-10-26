use std::{future::{poll_fn, Future}, task::Poll, path::Path, time::Duration, sync::{Mutex, atomic::{AtomicBool, Ordering}}};
use base64::{engine::general_purpose::STANDARD, Engine};
use tokio::sync::{watch, Notify};

const MAX_HTML_BYTES: usize = 10 * 1024 * 1024;
const MAX_PDF_BYTES: u64 = 40 * 1024 * 1024;
const PDF_TIMEOUT: Duration = Duration::from_secs(90);
static PDF_PERMIT: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
static PDF_LIFECYCLE: PdfLifecycle = PdfLifecycle::new();

struct PdfLifecycle {
    closing: AtomicBool,
    active: Mutex<Option<watch::Sender<bool>>>,
    idle: Notify,
}
impl PdfLifecycle {
    const fn new() -> Self { Self { closing: AtomicBool::new(false), active: Mutex::new(None), idle: Notify::const_new() } }
    fn is_closing(&self) -> bool { self.closing.load(Ordering::Acquire) }
    fn begin(&self) -> Result<(PdfRun<'_>, watch::Receiver<bool>), String> {
        let mut active = self.active.lock().unwrap_or_else(|error| error.into_inner());
        if self.is_closing() { return Err("Native PDF renderer is shutting down".into()); }
        if active.is_some() { return Err("Native PDF renderer is busy".into()); }
        let (sender, receiver) = watch::channel(false);
        *active = Some(sender);
        Ok((PdfRun(self), receiver))
    }
    fn close(&self) {
        self.closing.store(true, Ordering::Release);
        if let Some(sender) = self.active.lock().unwrap_or_else(|error| error.into_inner()).as_ref() {
            let _ = sender.send(true);
        }
    }
    async fn wait_idle(&self, limit: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + limit;
        loop {
            let idle = self.idle.notified();
            tokio::pin!(idle);
            // Register before observing the state so a completion between the
            // check and await cannot lose the shutdown notification.
            idle.as_mut().enable();
            if self.active.lock().unwrap_or_else(|error| error.into_inner()).is_none() { return true; }
            if tokio::time::timeout_at(deadline, idle).await.is_err() { return false; }
        }
    }
}
struct PdfRun<'a>(&'a PdfLifecycle);
impl Drop for PdfRun<'_> {
    fn drop(&mut self) {
        self.0.active.lock().unwrap_or_else(|error| error.into_inner()).take();
        self.0.idle.notify_waiters();
    }
}

async fn cancelled(receiver: &mut watch::Receiver<bool>) {
    if *receiver.borrow() { return; }
    // A dropped sender also means the owning export is gone. Native cleanup
    // guards release its window/token when the render future is dropped.
    let _ = receiver.changed().await;
}

async fn until_cancelled<F: Future>(future: F, receiver: &mut watch::Receiver<bool>) -> Option<F::Output> {
    let mut cancellation = std::pin::pin!(cancelled(receiver));
    let mut future = std::pin::pin!(future);
    poll_fn(|context| {
        // Give app shutdown priority if completion and cancellation race.
        if cancellation.as_mut().poll(context).is_ready() { return Poll::Ready(None); }
        future.as_mut().poll(context).map(Some)
    }).await
}

/// Stop admission and release owned PDF WebViews while the Tauri main loop is
/// still alive. Shutdown never waits on a report's ordinary 90-second deadline.
pub async fn cancel_pdf_exports(app: tauri::AppHandle) {
    PDF_LIFECYCLE.close();
    PDF_PERMIT.close();
    let _ = tokio::time::timeout(Duration::from_secs(2), async {
        platform::cancel_all(app).await;
        let _ = PDF_LIFECYCLE.wait_idle(Duration::from_secs(2)).await;
    }).await;
}

/// Apply the same offline rendering boundary on both system WebViews. Scripts
/// are disabled independently in their native settings; CSP also rejects all
/// remote CSS, images, fonts, frames, form submissions and refresh resources.
fn offline_html(html: String) -> Result<String, String> {
    if html.len() > MAX_HTML_BYTES || html.contains('\0') {
        return Err("Report exceeds the native PDF input limit".into());
    }
    let policy = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-src 'none'\"><style>@page { size: A4; } html { -webkit-print-color-adjust: exact; print-color-adjust: exact; } body { font-family: Arial, 'Noto Sans Thai', 'Leelawadee UI', 'PingFang SC', 'Microsoft YaHei', sans-serif; }</style>";
    // A small OFL Thai font avoids platform-dependent complex-script glyph
    // mappings in Quartz PDF output. Both faces are generated only on export;
    // no font installation, network request, or resident font engine is needed.
    let regular = STANDARD.encode(include_bytes!("../../platform/fonts/NotoSansThai-Regular.ttf"));
    let bold = STANDARD.encode(include_bytes!("../../platform/fonts/NotoSansThai-Bold.ttf"));
    let fonts = format!("<style>@font-face{{font-family:'Noto Sans Thai';font-weight:400;src:url(data:font/ttf;base64,{regular})}}@font-face{{font-family:'Noto Sans Thai';font-weight:700;src:url(data:font/ttf;base64,{bold})}}</style>");
    // The security policy precedes every caller-controlled node, including an
    // existing <head>. A later CSP declaration can only tighten this policy.
    Ok(format!("<!doctype html><meta charset=\"utf-8\">{policy}{fonts}{html}"))
}

fn read_pdf(path: &Path) -> Result<Vec<u8>, String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| "Native PDF output is missing")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || !(64..=MAX_PDF_BYTES).contains(&metadata.len()) {
        return Err("Native PDF output is invalid or exceeds the export limit".into());
    }
    let bytes = std::fs::read(path).map_err(|_| "Native PDF output could not be read")?;
    if !bytes.starts_with(b"%PDF-") || !bytes.windows(5).any(|window| window == b"%%EOF") {
        return Err("Native PDF output is incomplete".into());
    }
    Ok(bytes)
}

pub async fn render_pdf(app: tauri::AppHandle, html: String) -> Result<Vec<u8>, String> {
    if PDF_LIFECYCLE.is_closing() { return Err("Native PDF renderer is shutting down".into()); }
    let _permit = PDF_PERMIT.acquire().await.map_err(|_| "Native PDF renderer is shutting down")?;
    let (_run, cancellation) = PDF_LIFECYCLE.begin()?;
    let html = offline_html(html)?;
    let directory = tempfile::Builder::new().prefix("law-agent-pdf-").tempdir()
        .map_err(|_| "Unable to create a private PDF export directory")?;
    let path = directory.path().join("report.pdf");
    platform::render(app, html, path.clone(), cancellation).await?;
    read_pdf(&path)
    // TempDir removes the intermediate PDF after the bytes have been copied.
}

#[cfg(target_os = "macos")]
mod platform {
    use std::{ffi::{c_char, c_void, CStr, CString}, path::PathBuf, sync::atomic::{AtomicU64, Ordering}};
    use tokio::sync::oneshot;
    unsafe extern "C" {
        fn law_pdf_start(html: *const c_char, path: *const c_char,
            callback: extern "C" fn(*mut c_void, *const c_char), context: *mut c_void, token: u64);
        fn law_pdf_cancel(token: u64);
        fn law_pdf_cancel_all(callback: extern "C" fn(*mut c_void), context: *mut c_void);
    }
    static NEXT_TOKEN: AtomicU64 = AtomicU64::new(1);
    type Completion = oneshot::Sender<Result<(), String>>;
    struct NativeRender {
        app: tauri::AppHandle,
        token: u64,
        armed: bool,
    }
    impl Drop for NativeRender {
        fn drop(&mut self) {
            if !self.armed { return; }
            let token = self.token;
            let _ = self.app.run_on_main_thread(move || unsafe { law_pdf_cancel(token); });
        }
    }
    extern "C" fn completed(context: *mut c_void, error: *const c_char) {
        let sender: Box<Completion> = unsafe { Box::from_raw(context.cast()) };
        let result = if error.is_null() { Ok(()) } else {
            Err(unsafe { CStr::from_ptr(error) }.to_string_lossy().into_owned())
        };
        let _ = sender.send(result);
    }
    extern "C" fn all_stopped(context: *mut c_void) {
        let sender: Box<oneshot::Sender<()>> = unsafe { Box::from_raw(context.cast()) };
        let _ = sender.send(());
    }
    pub async fn cancel_all(app: tauri::AppHandle) {
        let (sender, receiver) = oneshot::channel::<()>();
        let context = Box::into_raw(Box::new(sender)) as usize;
        if app.run_on_main_thread(move || unsafe { law_pdf_cancel_all(all_stopped, context as *mut c_void); }).is_err() {
            unsafe { drop(Box::from_raw(context as *mut oneshot::Sender<()>)); }
            return;
        }
        // The outer shutdown deadline is two seconds. Dropping this receiver
        // never frees the C-owned sender; its eventual callback owns that box.
        let _ = receiver.await;
    }
    async fn cancel_native(app: &tauri::AppHandle, token: u64) {
        let (cleaned, cleanup) = oneshot::channel();
        if app.run_on_main_thread(move || unsafe { law_pdf_cancel(token); let _ = cleaned.send(()); }).is_ok() {
            let _ = tokio::time::timeout(std::time::Duration::from_secs(1), cleanup).await;
        }
    }
    pub async fn render(app: tauri::AppHandle, html: String, path: PathBuf, mut cancellation: tokio::sync::watch::Receiver<bool>) -> Result<(), String> {
        let html = CString::new(html).map_err(|_| "Invalid PDF HTML")?;
        let path = CString::new(path.to_string_lossy().as_bytes()).map_err(|_| "Invalid PDF output path")?;
        let (sender, receiver) = oneshot::channel::<Result<(), String>>();
        let token = NEXT_TOKEN.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| value.checked_add(1))
            .map_err(|_| "Native PDF token limit reached")?;
        let context = Box::into_raw(Box::new(sender)) as usize;
        let mut native = NativeRender { app: app.clone(), token, armed: true };
        #[cfg(feature = "desktop-smoke")]
        let smoke_app = app.clone();
        if app.run_on_main_thread(move || unsafe {
            if super::PDF_LIFECYCLE.is_closing() {
                completed(context as *mut c_void, b"Native PDF renderer is shutting down\0".as_ptr().cast());
            } else {
                law_pdf_start(html.as_ptr(), path.as_ptr(), completed, context as *mut c_void, token);
                #[cfg(feature = "desktop-smoke")]
                {
                    use tauri::Emitter;
                    let _ = smoke_app.emit_to("main", "desktop-smoke-pdf-started", ());
                }
            }
        }).is_err() {
            unsafe { drop(Box::from_raw(context as *mut Completion)); }
            return Err("Native PDF renderer could not be started".into());
        }
        let result = match super::until_cancelled(tokio::time::timeout(super::PDF_TIMEOUT, receiver), &mut cancellation).await {
            None => {
                cancel_native(&app, token).await;
                Err("Native PDF export cancelled because the application is closing".into())
            }
            Some(Ok(result)) => result.unwrap_or_else(|_| Err("Native PDF renderer disconnected".into())),
            Some(Err(_)) => {
                cancel_native(&app, token).await;
                Err("Native PDF rendering timed out".into())
            }
        };
        native.armed = false;
        result
    }
}

#[cfg(windows)]
mod platform {
    use std::{io::Write, path::PathBuf, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}};
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    use tokio::sync::oneshot;
    use webview2_com::{Microsoft::Web::WebView2::Win32::{ICoreWebView2_7, ICoreWebView2Environment6}, PrintToPdfCompletedHandler};
    use windows::core::{Interface, HSTRING};
    pub async fn cancel_all(app: tauri::AppHandle) {
        use tauri::Manager;
        let (stopped, receiver) = oneshot::channel();
        let main_app = app.clone();
        if app.run_on_main_thread(move || {
            for (label, window) in main_app.webview_windows() {
                // This prefix is generated only by this module; UUID labels
                // exclude user paths and the application's main WebView.
                if label.strip_prefix("pdf-").and_then(|id| uuid::Uuid::parse_str(id).ok()).is_some() {
                    let _ = window.destroy();
                }
            }
            let _ = stopped.send(());
        }).is_ok() { let _ = receiver.await; }
    }
    struct NativeRender(tauri::WebviewWindow);
    impl Drop for NativeRender {
        fn drop(&mut self) { let _ = self.0.destroy(); }
    }

    pub async fn render(app: tauri::AppHandle, html: String, path: PathBuf, mut cancellation: tokio::sync::watch::Receiver<bool>) -> Result<(), String> {
        let label = format!("pdf-{}", uuid::Uuid::new_v4());
        let (sender, receiver) = oneshot::channel();
        let completion = Arc::new(Mutex::new(Some(sender)));
        let completion_loaded = completion.clone();
        let print_started = AtomicBool::new(false);
        // A private local document avoids WebView2 NavigateToString's 2 MiB
        // HTML limit. No capabilities target this unprivileged export window.
        let html_path = path.with_extension("html");
        let mut input = std::fs::OpenOptions::new().write(true).create_new(true).open(&html_path)
            .map_err(|_| "Private PDF input could not be created")?;
        input.write_all(html.as_bytes()).map_err(|_| "Private PDF input could not be written")?;
        drop(input);
        let url = tauri::Url::from_file_path(&html_path).map_err(|_| "Invalid private PDF input path")?;
        let allowed_url = url.clone();
        let document_url = url.clone();
        let export = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(url))
            .visible(false).inner_size(794.0, 1123.0).incognito(true).disable_javascript()
            .on_navigation(move |url| url == &allowed_url || url.as_str() == "about:blank")
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
            .on_page_load(move |window, payload| {
                if payload.event() != tauri::webview::PageLoadEvent::Finished || payload.url() != &document_url
                    || print_started.swap(true, Ordering::AcqRel) { return; }
                let completion = completion_loaded.clone();
                let path = path.clone();
                let started = window.with_webview(move |view| {
                    let result = (|| -> Result<(), String> { unsafe {
                        let core = view.controller().CoreWebView2().map_err(|_| "PDF WebView2 is unavailable")?;
                        let settings = core.Settings().map_err(|_| "PDF WebView2 settings unavailable")?;
                        settings.SetIsScriptEnabled(false).map_err(|_| "PDF script isolation failed")?;
                        let printer: ICoreWebView2_7 = core.cast().map_err(|_| "WebView2 PDF export requires a newer Microsoft Edge WebView2 runtime")?;
                        let environment: ICoreWebView2Environment6 = view.environment().cast().map_err(|_| "WebView2 PDF settings unavailable")?;
                        let print_settings = environment.CreatePrintSettings().map_err(|_| "WebView2 PDF settings unavailable")?;
                        print_settings.SetPageWidth(210.0 / 25.4).map_err(|_| "PDF A4 settings failed")?;
                        print_settings.SetPageHeight(297.0 / 25.4).map_err(|_| "PDF A4 settings failed")?;
                        print_settings.SetShouldPrintBackgrounds(true).map_err(|_| "PDF background settings failed")?;
                        print_settings.SetShouldPrintHeaderAndFooter(false).map_err(|_| "PDF header settings failed")?;
                        let callback_completion = completion.clone();
                        let handler = PrintToPdfCompletedHandler::create(Box::new(move |status, success| {
                            if let Some(sender) = callback_completion.lock().unwrap().take() {
                                let result = if status.is_ok() && success { Ok(()) } else { Err("Native PDF export failed".into()) };
                                let _ = sender.send(result);
                            }
                            Ok(())
                        }));
                        printer.PrintToPdf(&HSTRING::from(path.to_string_lossy().as_ref()), &print_settings, &handler)
                            .map_err(|_| "Native PDF export could not be started")?;
                        Ok(())
                    }})();
                    if let Err(error) = result { if let Some(sender) = completion.lock().unwrap().take() { let _ = sender.send(Err(error)); } }
                });
                if started.is_err() { if let Some(sender) = completion_loaded.lock().unwrap().take() { let _ = sender.send(Err("Native PDF renderer is unavailable".into())); } }
            }).build().map_err(|_| "Native PDF window could not be created")?;
        let export = NativeRender(export);
        #[cfg(feature = "desktop-smoke")]
        {
            use tauri::Emitter;
            let _ = app.emit_to("main", "desktop-smoke-pdf-started", ());
        }
        let result = match super::until_cancelled(tokio::time::timeout(super::PDF_TIMEOUT, receiver), &mut cancellation).await {
            None => Err("Native PDF export cancelled because the application is closing".into()),
            Some(Ok(result)) => result.unwrap_or_else(|_| Err("Native PDF renderer disconnected".into())),
            Some(Err(_)) => Err("Native PDF rendering timed out".into()),
        };
        // Destroy rather than hide so WebView2 and its unprivileged document
        // stop occupying memory on both errors and success.
        drop(export);
        result
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    pub async fn cancel_all(_: tauri::AppHandle) {}
    pub async fn render(_: tauri::AppHandle, _: String, _: std::path::PathBuf, _: tokio::sync::watch::Receiver<bool>) -> Result<(), String> {
        Err("Native PDF export is supported on Windows and macOS".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn offline_policy_precedes_untrusted_html() {
        let html = offline_html("<html><head><style>@import url(https://example.com/x)</style></head><body>合同 ข้อตกลง</body></html>".into()).unwrap();
        assert!(html.find("Content-Security-Policy").unwrap() < html.find("@import").unwrap());
        assert!(html.contains("default-src 'none'"));
        assert!(html.contains("合同 ข้อตกลง"));
        assert!(offline_html("\0".into()).is_err());
        assert!(offline_html("x".repeat(MAX_HTML_BYTES + 1)).is_err());
    }
    #[test]
    fn incomplete_pdf_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("bad.pdf");
        std::fs::write(&file, format!("%PDF-1.7\n{}", "x".repeat(100))).unwrap();
        assert!(read_pdf(&file).is_err());
    }
    #[test]
    fn shutdown_cancels_admitted_export_and_refuses_new_work() {
        tauri::async_runtime::block_on(async {
            let lifecycle = PdfLifecycle::new();
            let (run, mut cancellation) = lifecycle.begin().unwrap();
            lifecycle.close();
            assert!(lifecycle.begin().is_err());
            tokio::time::timeout(Duration::from_millis(100), cancelled(&mut cancellation)).await.unwrap();
            assert!(!lifecycle.wait_idle(Duration::from_millis(5)).await);
            drop(run);
            assert!(lifecycle.wait_idle(Duration::from_millis(100)).await);
            lifecycle.close(); // Repeated shutdown is harmless.
        });
    }
    #[test]
    fn aborted_export_future_releases_its_lifecycle_registration() {
        tauri::async_runtime::block_on(async {
            let lifecycle = std::sync::Arc::new(PdfLifecycle::new());
            let worker_lifecycle = lifecycle.clone();
            let (started, admitted) = tokio::sync::oneshot::channel();
            let worker = tokio::spawn(async move {
                let (run, _cancellation) = worker_lifecycle.begin().unwrap();
                let _ = started.send(());
                std::future::pending::<()>().await;
                drop(run);
            });
            admitted.await.unwrap();
            worker.abort();
            assert!(worker.await.unwrap_err().is_cancelled());
            assert!(lifecycle.wait_idle(Duration::from_millis(100)).await);
            // Native token/window Drop guards are separate from this Rust
            // registration and remain responsible for their exact OS object.
            assert!(lifecycle.begin().is_ok());
        });
    }
}
