// SPDX-License-Identifier: AGPL-3.0-or-later

//! The companion app's native shell: Bluetooth (`ridrs-ble`) and the bridge server
//! (`ridrs-bridge`). Pairing and GATT forwarding run in the WebView (`packages/ble-bridge`).

use ridrs_ble::commands as ble;
use ridrs_bridge::server as bridge;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    ridrs_ble::process_start();
    let builder = tauri::Builder::default().plugin(tauri_plugin_blec::init());
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());
    builder
        // The arrow keys work from the start (AGENTS.md rule 12): without keyboard focus in the
        // webview, macOS sends no key but Tab to the page until the rider clicks into it.
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let webview: &tauri::Webview<_> = window.as_ref();
                webview.set_focus()?;
            }
            Ok(())
        })
        .manage(bridge::ServerState::default())
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
            bridge::bridge_serve,
            bridge::bridge_unserve,
            bridge::bridge_server_send_text,
            bridge::bridge_server_send_binary,
            bridge::bridge_server_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
