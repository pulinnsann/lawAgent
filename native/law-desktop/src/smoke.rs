//! Compiled only with `desktop-smoke`; production builds expose no diagnostics command.
use std::{env, fs, path::PathBuf};
use tauri::Manager;

#[tauri::command]
pub fn desktop_smoke_report(app: tauri::AppHandle, mut report: serde_json::Value) -> Result<(), String> {
    if let Some(object) = report.as_object_mut() {
        object.insert("nativePid".into(), serde_json::Value::from(std::process::id()));
    }
    let destination = env::var_os("LAW_AGENT_SMOKE_OUTPUT")
        .map(PathBuf::from)
        .ok_or("Smoke output was not configured at startup.")?;
    if !destination.is_absolute() {
        return Err("Smoke output must be an absolute trusted startup path.".into());
    }
    let bytes = serde_json::to_vec_pretty(&report).map_err(|error| error.to_string())?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err("Smoke report exceeds 4 MiB.".into());
    }
    #[cfg(target_os = "macos")]
    if report.get("cleanupCredential").and_then(|value| value.as_bool()) == Some(true) {
        crate::platform::credentials::cleanup_test_key()?;
    }
    let temporary = destination.with_extension("json.pending");
    fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    // On Windows rename does not replace an existing destination.
    if cfg!(windows) && destination.exists() {
        fs::remove_file(&destination).map_err(|error| error.to_string())?;
    }
    fs::rename(&temporary, &destination).map_err(|error| error.to_string())?;
    if report.get("final").and_then(|value| value.as_bool()) == Some(true) {
        if report.get("closeWindow").and_then(|value| value.as_bool()) == Some(true) {
            app.get_webview_window("main").ok_or("Main test window is unavailable.")?.close().map_err(|error| error.to_string())?;
        } else {
            app.exit(if report.get("passed").and_then(|value| value.as_bool()) == Some(true) { 0 } else { 1 });
        }
    }
    Ok(())
}
