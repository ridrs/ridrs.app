// SPDX-License-Identifier: AGPL-3.0-or-later

//! Non-BLE host services the spike UI needs: packet log in the app data directory and keep-awake.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, Manager, Runtime, State};

const LOG_FILE: &str = "packet-capture.log";

fn log_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(LOG_FILE))
}

#[tauri::command]
pub fn log_append<R: Runtime>(app: AppHandle<R>, text: String) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path(&app)?)
        .map_err(|e| e.to_string())?;
    file.write_all(text.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn log_location<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    Ok(log_path(&app)?.display().to_string())
}

#[tauri::command]
pub fn log_read<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    fs::read_to_string(log_path(&app)?).or_else(|_| Ok(String::new()))
}

/// Copies the log somewhere the user can reach it: Downloads on desktop, the app's Documents
/// folder on mobile (visible in the iOS Files app through `UIFileSharingEnabled`).
#[tauri::command]
pub fn log_export<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    let source = log_path(&app)?;
    let target_dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().document_dir())
        .map_err(|e| e.to_string())?;
    fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;
    let target = target_dir.join(format!(
        "ridrs-packet-capture-{}.log",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    ));
    fs::copy(&source, &target).map_err(|e| e.to_string())?;
    Ok(target.display().to_string())
}

const SELFTEST_FLAG_FILE: &str = "selftest.flag";

/// `RIDRS_SPIKE_SELFTEST=1`, or a `selftest.flag` file in the app data directory (for mobile, where
/// launch environments are awkward), makes the UI run an unattended probe into the packet log.
/// The flag file is consumed, so the next launch is a normal one.
#[tauri::command]
pub fn selftest_requested<R: Runtime>(app: AppHandle<R>) -> bool {
    if std::env::var("RIDRS_SPIKE_SELFTEST").is_ok_and(|v| v == "1") {
        return true;
    }
    app.path()
        .app_data_dir()
        .map(|dir| fs::remove_file(dir.join(SELFTEST_FLAG_FILE)).is_ok())
        .unwrap_or(false)
}

#[derive(Default)]
pub struct KeepAwakeState(
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    Mutex<Option<keepawake::KeepAwake>>,
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    Mutex<()>,
);

/// Returns `"native"` when the OS mechanism holds the display awake, `"unsupported"` on targets
/// without a native implementation here (mobile), where the UI falls back to the Screen Wake Lock API.
#[tauri::command]
pub fn keep_awake(enabled: bool, state: State<'_, KeepAwakeState>) -> Result<&'static str, String> {
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    {
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        *guard = if enabled {
            Some(
                keepawake::Builder::default()
                    .display(true)
                    .idle(true)
                    .reason("ridrs: BLE session active")
                    .app_name("ridrs spike")
                    .app_reverse_domain("org.ridrs.spike")
                    .create()
                    .map_err(|e| e.to_string())?,
            )
        } else {
            None
        };
        Ok("native")
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = (enabled, state);
        Ok("unsupported")
    }
}
