// SPDX-License-Identifier: AGPL-3.0-or-later

mod clock;
mod companion;
mod host;

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SpikeConfig {
    /// `SPIKE_ROLE` (desktop): "companion", "host" or "both"; empty = choose in the UI.
    role: String,
    platform: &'static str,
}

#[tauri::command]
fn spike_config() -> SpikeConfig {
    SpikeConfig {
        role: std::env::var("SPIKE_ROLE").unwrap_or_default(),
        platform: std::env::consts::OS,
    }
}

/// The report line goes to stdout so a desktop run can be read without the UI.
#[tauri::command]
fn spike_report(line: String) {
    println!("SPIKE {line}");
}

/// Companion wall clock and monotonic time, for the host's offset estimate.
#[tauri::command]
fn spike_clock() -> (f64, u64) {
    (clock::wall_clock_millis(), clock::monotonic_micros())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    clock::process_start();
    tauri::Builder::default()
        .manage(companion::CompanionState::default())
        .manage(host::HostState::default())
        .invoke_handler(tauri::generate_handler![
            spike_config,
            spike_report,
            spike_clock,
            companion::companion_start,
            companion::companion_stop,
            host::host_browse,
            host::host_stop_browse,
            host::host_rust_connect,
            host::host_rust_send,
            host::host_rust_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
