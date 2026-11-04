// SPDX-License-Identifier: AGPL-3.0-or-later

//! `storage.secrets` (ADR 0050): one credential per key in the OS store through keyring-core;
//! the macOS legacy Keychain, the iOS protected data store, the Android Keystore-backed store.
//! Thin glue: the JS side (`plugins/storage-secrets-tauri`) checks the keys.

use std::sync::OnceLock;

use keyring_core::{Entry, Error};

/// The credentials' service name: the app's identifier.
const SERVICE: &str = "org.ridrs.app";

/// Sets the default store once, on first use: on Android the store needs the app context,
/// which Tauri's mobile runtime has set up by the time a command runs.
fn ensure_store() -> Result<(), String> {
    static STORE: OnceLock<Result<(), String>> = OnceLock::new();
    STORE
        .get_or_init(|| {
            #[cfg(target_os = "macos")]
            let store = apple_native_keyring_store::keychain::Store::new();
            #[cfg(target_os = "ios")]
            let store = apple_native_keyring_store::protected::Store::new();
            #[cfg(target_os = "android")]
            let store = android_native_keyring_store::Store::new();
            #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "android")))]
            let store: keyring_core::Result<std::sync::Arc<keyring_core::CredentialStore>> =
                Err(Error::NotSupportedByStore(
                    "no credential store on this platform".into(),
                ));
            store
                .map(|store| keyring_core::set_default_store(store))
                .map_err(|e| e.to_string())
        })
        .clone()
}

fn entry(key: &str) -> Result<Entry, String> {
    ensure_store()?;
    if key.is_empty() {
        return Err("empty secret key".into());
    }
    Entry::new(SERVICE, key).map_err(|e| e.to_string())
}

/// The secret under `key`, or `None` when there is none.
#[tauri::command(async)]
pub fn secret_get(key: String) -> Result<Option<String>, String> {
    match entry(&key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command(async)]
pub fn secret_set(key: String, value: String) -> Result<(), String> {
    entry(&key)?.set_password(&value).map_err(|e| e.to_string())
}

/// Removing a missing secret is not an error.
#[tauri::command(async)]
pub fn secret_remove(key: String) -> Result<(), String> {
    match entry(&key)?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
