// SPDX-License-Identifier: AGPL-3.0-or-later

mod ble;
mod host;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    ble::process_start();
    tauri::Builder::default()
        // Registers the platform backends (incl. the Android Kotlin module) and initializes the
        // shared BLE handler that `ble.rs` drives. blec's own JS commands are not used.
        .plugin(tauri_plugin_blec::init())
        .manage(host::KeepAwakeState::default())
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
            ble::ble_clock,
            ble::spike_synthetic_notifications,
            host::log_append,
            host::log_location,
            host::log_read,
            host::log_export,
            host::keep_awake,
            host::selftest_requested,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
