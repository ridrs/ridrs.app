// SPDX-License-Identifier: AGPL-3.0-or-later

//! Keeps the display on while a ride runs (nobody touches the screen while pedalling).

use std::sync::Mutex;

use tauri::State;

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
                    .reason("ridrs: ride running")
                    .app_name("ridrs")
                    .app_reverse_domain("org.ridrs.app")
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
