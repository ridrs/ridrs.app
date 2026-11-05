// SPDX-License-Identifier: AGPL-3.0-or-later

//! The `secret_*` commands behind `storage.secrets`; keys are checked on the JS side, values are
//! UTF-8 text.

use tauri::AppHandle;

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
mod store {
    use std::sync::Mutex;

    use tauri::{AppHandle, Manager};

    use crate::file_store::FileStore;

    /// One read-modify-write of the file at a time.
    static FILE: Mutex<()> = Mutex::new(());

    pub fn with<T>(
        app: &AppHandle,
        work: impl FnOnce(&FileStore) -> Result<T, String>,
    ) -> Result<T, String> {
        let directory = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let _guard = FILE.lock().map_err(|e| e.to_string())?;
        work(&FileStore::for_this_machine(&directory)?)
    }

    pub fn get(app: &AppHandle, key: &str) -> Result<Option<String>, String> {
        with(app, |store| store.get(key))
    }

    pub fn set(app: &AppHandle, key: &str, value: &str) -> Result<(), String> {
        with(app, |store| store.set(key, value))
    }

    pub fn remove(app: &AppHandle, key: &str) -> Result<(), String> {
        with(app, |store| store.remove(key))
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
mod store {
    use tauri::AppHandle;

    use crate::keyring_store;

    pub fn get(_app: &AppHandle, key: &str) -> Result<Option<String>, String> {
        keyring_store::get(key)
    }

    pub fn set(_app: &AppHandle, key: &str, value: &str) -> Result<(), String> {
        keyring_store::set(key, value)
    }

    pub fn remove(_app: &AppHandle, key: &str) -> Result<(), String> {
        keyring_store::remove(key)
    }
}

#[cfg(not(any(
    target_os = "windows",
    target_os = "macos",
    target_os = "linux",
    target_os = "android",
    target_os = "ios"
)))]
mod store {
    use tauri::AppHandle;

    const NONE: &str = "no secret store on this platform";

    pub fn get(_app: &AppHandle, _key: &str) -> Result<Option<String>, String> {
        Err(NONE.into())
    }

    pub fn set(_app: &AppHandle, _key: &str, _value: &str) -> Result<(), String> {
        Err(NONE.into())
    }

    pub fn remove(_app: &AppHandle, _key: &str) -> Result<(), String> {
        Err(NONE.into())
    }
}

fn checked(key: &str) -> Result<&str, String> {
    if key.is_empty() {
        return Err("empty secret key".into());
    }
    Ok(key)
}

/// The secret under `key`, or `None` when there is none.
#[tauri::command(async)]
pub fn secret_get(app: AppHandle, key: String) -> Result<Option<String>, String> {
    store::get(&app, checked(&key)?)
}

#[tauri::command(async)]
pub fn secret_set(app: AppHandle, key: String, value: String) -> Result<(), String> {
    store::set(&app, checked(&key)?, &value)
}

/// Removing a missing secret is not an error.
#[tauri::command(async)]
pub fn secret_remove(app: AppHandle, key: String) -> Result<(), String> {
    store::remove(&app, checked(&key)?)
}
