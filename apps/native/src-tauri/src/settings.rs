// SPDX-License-Identifier: AGPL-3.0-or-later

//! The rider's choice of BLE transport, kept in a file instead of WebView storage: WebView
//! storage is written asynchronously, so a crash right after a switch could lose the choice and
//! restart the app in the other transport.

use std::fs;
use std::io::Write;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

const FILE: &str = "ble-transport";
const VALUES: [&str; 2] = ["local", "bridge"];

fn path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(FILE))
}

/// `None` when nothing (or nothing valid) was saved yet.
#[tauri::command]
pub fn ble_transport_get(app: AppHandle) -> Result<Option<String>, String> {
    let value = fs::read_to_string(path(&app)?).unwrap_or_default();
    let value = value.trim();
    Ok(VALUES.contains(&value).then(|| value.to_string()))
}

/// Writes atomically and durably (temporary file, fsync, rename) before it returns.
#[tauri::command]
pub fn ble_transport_set(app: AppHandle, transport: String) -> Result<(), String> {
    if !VALUES.contains(&transport.as_str()) {
        return Err(format!("unknown BLE transport {transport:?}"));
    }
    let target = path(&app)?;
    let temporary = target.with_extension("tmp");
    let mut file = fs::File::create(&temporary).map_err(|e| e.to_string())?;
    file.write_all(transport.as_bytes()).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    fs::rename(&temporary, &target).map_err(|e| e.to_string())
}
