// SPDX-License-Identifier: AGPL-3.0-or-later

//! One file of secrets (ADR 0053): `RIDRSEC1 | salt (16) | nonce (12) | AES-256-GCM(JSON)`, the
//! magic and salt as associated data. The key is HKDF-SHA256 over the machine id and the salt:
//! nothing secret lies next to the file, and a copy is useless on another machine.

use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use aes_gcm::aead::rand_core::RngCore;
use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use hkdf::Hkdf;
use sha2::Sha256;

/// The file's name in the app data directory, outside every fs-plugin scope.
pub const FILE_NAME: &str = "secrets.bin";

const MAGIC: &[u8; 8] = b"RIDRSEC1";
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const HEADER_LEN: usize = MAGIC.len() + SALT_LEN;
const INFO: &[u8] = b"org.ridrs.app/storage.secrets/v1";

type Secrets = BTreeMap<String, String>;

/// Why the file could not be read.
#[derive(Debug)]
enum LoadError {
    /// Another machine's file, a changed machine id, or damage: it never decrypts again.
    Unreadable,
    Io(io::Error),
}

impl LoadError {
    fn message(&self) -> String {
        match self {
            LoadError::Unreadable => "secrets unreadable".into(),
            LoadError::Io(e) => format!("secrets file: {e}"),
        }
    }
}

pub struct FileStore {
    path: PathBuf,
    machine_id: Vec<u8>,
}

impl FileStore {
    /// The store in `directory`, keyed to this machine.
    pub fn for_this_machine(directory: &Path) -> Result<Self, String> {
        let machine_id = machine_uid::get().map_err(|e| format!("no machine id: {e}"))?;
        Ok(Self::new(directory.join(FILE_NAME), machine_id.into_bytes()))
    }

    pub fn new(path: PathBuf, machine_id: Vec<u8>) -> Self {
        Self { path, machine_id }
    }

    /// The secret under `key`, or `None` when there is none.
    pub fn get(&self, key: &str) -> Result<Option<String>, String> {
        match self.load() {
            Ok((_, secrets)) => Ok(secrets.get(key).cloned()),
            Err(e) => Err(e.message()),
        }
    }

    /// An unreadable file is replaced: what it held cannot be read anyway.
    pub fn set(&self, key: &str, value: &str) -> Result<(), String> {
        let (salt, mut secrets) = match self.load() {
            Ok(loaded) => loaded,
            Err(LoadError::Unreadable) => (None, Secrets::new()),
            Err(e) => return Err(e.message()),
        };
        secrets.insert(key.to_owned(), value.to_owned());
        self.save(salt.unwrap_or_else(new_salt), &secrets)
    }

    /// Removing a missing secret, or one of an unreadable file, is not an error.
    pub fn remove(&self, key: &str) -> Result<(), String> {
        let (salt, mut secrets) = match self.load() {
            Ok(loaded) => loaded,
            Err(LoadError::Unreadable) => return Ok(()),
            Err(e) => return Err(e.message()),
        };
        if secrets.remove(key).is_none() {
            return Ok(());
        }
        self.save(salt.unwrap_or_else(new_salt), &secrets)
    }

    fn key(&self, salt: &[u8]) -> Key<Aes256Gcm> {
        let mut okm = [0u8; 32];
        Hkdf::<Sha256>::new(Some(salt), &self.machine_id)
            .expand(INFO, &mut okm)
            .expect("32 bytes is a valid HKDF-SHA256 length");
        okm.into()
    }

    /// The salt (none without a file) and the secrets.
    fn load(&self) -> Result<(Option<[u8; SALT_LEN]>, Secrets), LoadError> {
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok((None, Secrets::new())),
            Err(e) => return Err(LoadError::Io(e)),
        };
        if bytes.len() < HEADER_LEN + NONCE_LEN || &bytes[..MAGIC.len()] != MAGIC {
            return Err(LoadError::Unreadable);
        }
        let mut salt = [0u8; SALT_LEN];
        salt.copy_from_slice(&bytes[MAGIC.len()..HEADER_LEN]);
        let nonce = Nonce::from_slice(&bytes[HEADER_LEN..HEADER_LEN + NONCE_LEN]);
        let plain = Aes256Gcm::new(&self.key(&salt))
            .decrypt(
                nonce,
                Payload {
                    msg: &bytes[HEADER_LEN + NONCE_LEN..],
                    aad: &bytes[..HEADER_LEN],
                },
            )
            .map_err(|_| LoadError::Unreadable)?;
        let secrets = serde_json::from_slice(&plain).map_err(|_| LoadError::Unreadable)?;
        Ok((Some(salt), secrets))
    }

    fn save(&self, salt: [u8; SALT_LEN], secrets: &Secrets) -> Result<(), String> {
        let plain = serde_json::to_vec(secrets).map_err(|e| e.to_string())?;
        let mut header = Vec::with_capacity(HEADER_LEN);
        header.extend_from_slice(MAGIC);
        header.extend_from_slice(&salt);
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let sealed = Aes256Gcm::new(&self.key(&salt))
            .encrypt(
                &nonce,
                Payload {
                    msg: &plain,
                    aad: &header,
                },
            )
            .map_err(|_| "secrets could not be encrypted".to_string())?;
        let mut bytes = header;
        bytes.extend_from_slice(&nonce);
        bytes.extend_from_slice(&sealed);
        write_privately(&self.path, &bytes).map_err(|e| format!("secrets file: {e}"))
    }
}

fn new_salt() -> [u8; SALT_LEN] {
    let mut salt = [0u8; SALT_LEN];
    OsRng.fill_bytes(&mut salt);
    salt
}

/// Owner-only, flushed and renamed over the old file: the file is the old one or the new one.
fn write_privately(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let directory = path.parent().unwrap_or(Path::new("."));
    fs::create_dir_all(directory)?;
    let temporary = path.with_extension("bin.tmp");
    {
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600))?;
        }
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    fs::rename(&temporary, path)?;
    #[cfg(unix)]
    fs::File::open(directory)?.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn directory(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ridrs-secrets-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn store(dir: &Path, machine: &str) -> FileStore {
        FileStore::new(dir.join(FILE_NAME), machine.as_bytes().to_vec())
    }

    #[test]
    fn keeps_secrets_across_stores() {
        let dir = directory("keeps");
        store(&dir, "mac-1").set("intervals-icu.token", "t0k3n").unwrap();
        store(&dir, "mac-1").set("bridge.pairing", "{}").unwrap();
        let again = store(&dir, "mac-1");
        assert_eq!(again.get("intervals-icu.token").unwrap().as_deref(), Some("t0k3n"));
        assert_eq!(again.get("bridge.pairing").unwrap().as_deref(), Some("{}"));
        assert_eq!(again.get("missing").unwrap(), None);
        again.remove("intervals-icu.token").unwrap();
        again.remove("intervals-icu.token").unwrap();
        assert_eq!(again.get("intervals-icu.token").unwrap(), None);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_file_holds_no_plain_text_and_is_owner_only() {
        let dir = directory("plain");
        store(&dir, "mac-1").set("intervals-icu.token", "t0k3n-in-plain").unwrap();
        let bytes = fs::read(dir.join(FILE_NAME)).unwrap();
        assert!(!bytes.windows(5).any(|w| w == b"t0k3n"));
        assert!(!bytes.windows(9).any(|w| w == b"intervals"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(dir.join(FILE_NAME)).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn another_machine_cannot_read_it_and_replaces_it_on_write() {
        let dir = directory("machine");
        store(&dir, "mac-1").set("intervals-icu.token", "t0k3n").unwrap();
        let other = store(&dir, "mac-2");
        assert_eq!(other.get("intervals-icu.token").unwrap_err(), "secrets unreadable");
        other.remove("intervals-icu.token").unwrap();
        other.set("bridge.pairing", "{}").unwrap();
        assert_eq!(other.get("bridge.pairing").unwrap().as_deref(), Some("{}"));
        assert_eq!(other.get("intervals-icu.token").unwrap(), None);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_damaged_file_is_unreadable() {
        let dir = directory("damaged");
        store(&dir, "mac-1").set("k.a", "v").unwrap();
        let path = dir.join(FILE_NAME);
        let mut bytes = fs::read(&path).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0x01;
        fs::write(&path, bytes).unwrap();
        assert_eq!(store(&dir, "mac-1").get("k.a").unwrap_err(), "secrets unreadable");
        fs::remove_dir_all(dir).unwrap();
    }
}
