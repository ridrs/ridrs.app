// SPDX-License-Identifier: AGPL-3.0-or-later

//! The mobile stores (ADR 0050, kept by ADR 0053): one credential per key through keyring-core;
//! Android's `SharedPreferences` encrypted with a key in the Android Keystore, iOS's protected
//! data store. Neither asks the rider for anything.

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
            #[cfg(target_os = "ios")]
            let store = apple_native_keyring_store::protected::Store::new();
            #[cfg(target_os = "android")]
            let store = android_native_keyring_store::Store::new();
            store
                .map(|store| keyring_core::set_default_store(store))
                .map_err(|e| e.to_string())
        })
        .clone()
}

fn entry(key: &str) -> Result<Entry, String> {
    ensure_store()?;
    Entry::new(SERVICE, key).map_err(|e| e.to_string())
}

pub fn get(key: &str) -> Result<Option<String>, String> {
    match entry(key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn set(key: &str, value: &str) -> Result<(), String> {
    entry(key)?.set_password(value).map_err(|e| e.to_string())
}

pub fn remove(key: &str) -> Result<(), String> {
    match entry(key)?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
