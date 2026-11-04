// SPDX-License-Identifier: AGPL-3.0-or-later

mod keep_awake;

use ridrs_ble::commands as ble;
use ridrs_bridge::client as bridge;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    ble::process_start();
    tauri::Builder::default()
        // Registers the platform backends (incl. the Android Kotlin module) and initializes the
        // shared BLE handler that `ble.rs` drives. blec's own JS commands are not used.
        .plugin(tauri_plugin_blec::init())
        // Scoped to $APPDATA/recordings/** by capabilities/default.json.
        .plugin(tauri_plugin_fs::init())
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
            bridge::bridge_browse,
            bridge::bridge_stop_browse,
            bridge::bridge_open,
            bridge::bridge_send_text,
            bridge::bridge_close,
            keep_awake::keep_awake,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
