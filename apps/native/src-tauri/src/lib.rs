// SPDX-License-Identifier: AGPL-3.0-or-later

mod keep_awake;

use ridrs_ble::commands as ble;
use ridrs_bridge::client as bridge;
use ridrs_secrets::commands as secrets;

#[cfg(desktop)]
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    ble::process_start();
    let builder = tauri::Builder::default();
    // Restores the main window's size and position from the last run; saves them on exit.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());
    builder
        // Registers the platform backends (incl. the Android Kotlin module) and initializes the
        // shared BLE handler that `ble.rs` drives. blec's own JS commands are not used.
        .plugin(tauri_plugin_blec::init())
        // Scoped to $APPDATA/recordings/** by capabilities/default.json.
        .plugin(tauri_plugin_fs::init())
        // intervals.icu (ADR 0049): HTTP from Rust, scoped to its API by capabilities/default.json;
        // the system browser for the sign-in, and the one-shot loopback server for its redirect.
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_oauth::init())
        // The arrow keys work from the start (AGENTS.md rule 12): without keyboard focus in the
        // webview, macOS sends no key but Tab to the page until the rider clicks into it.
        // Desktop only: mobile webviews have the focus and no `set_focus`.
        .setup(|_app| {
            #[cfg(desktop)]
            if let Some(window) = _app.get_webview_window("main") {
                let webview: &tauri::Webview<_> = window.as_ref();
                webview.set_focus()?;
            }
            Ok(())
        })
        .manage(keep_awake::KeepAwakeState::default())
        .manage(bridge::ClientState::default())
        .invoke_handler(tauri::generate_handler![
            ble::ble_check_permissions,
            ble::ble_adapter_state,
            ble::ble_scan,
            ble::ble_stop_scan,
            ble::ble_connect,
            ble::ble_disconnect,
            ble::ble_subscribe,
            ble::ble_unsubscribe,
            ble::ble_write,
            ble::ble_read,
            bridge::bridge_browse,
            bridge::bridge_stop_browse,
            bridge::bridge_open,
            bridge::bridge_send_text,
            bridge::bridge_close,
            keep_awake::keep_awake,
            secrets::secret_get,
            secrets::secret_set,
            secrets::secret_remove,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
