//! Shared context: data directory, event emitter, running-process state. Everything below is independent of Tauri
//! (the emitter is a closure), so the same functions run under the app and under the integration test harness.
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Instant;

pub type Emit = Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>;

#[derive(Default)]
pub struct Running {
    /// process group id of the running pipeline (leader pid), with the project id
    pub pipeline: Mutex<Option<(i32, String)>>,
    pub import: Mutex<Option<(i32, String)>>,
    /// last progress of the running import (`ImportProgress`), for a web view that was reloaded
    pub import_progress: Mutex<Option<serde_json::Value>>,
    /// a run that waits for the end of the import (`follow_import`); it starts with the imported file
    pub queued_run: Mutex<Option<crate::pipeline::RunParams>>,
    pub pipeline_cancelled: AtomicBool,
    pub import_cancelled: AtomicBool,
    pub download_cancel: AtomicBool,
    pub download_active: AtomicBool,
    pub nominatim_last: Mutex<Option<Instant>>,
    /// Incyclist export: process group of the running child (pipeline export or ffmpeg), the job's flags
    pub export_child: Mutex<Option<i32>>,
    pub export_active: AtomicBool,
    pub export_cancel: AtomicBool,
    pub dem_active: AtomicBool,
    pub dem_cancel: AtomicBool,
}

#[derive(Clone)]
pub struct Ctx {
    pub data_dir: PathBuf,
    pub emit: Emit,
    pub running: Arc<Running>,
}

impl Ctx {
    pub fn new(data_dir: PathBuf, emit: Emit) -> Self {
        let c = Ctx { data_dir, emit, running: Arc::new(Running::default()) };
        for d in [c.projects_dir(), c.osm_dir(), c.cache_dir()] {
            let _ = std::fs::create_dir_all(d);
        }
        c
    }
    pub fn projects_dir(&self) -> PathBuf {
        self.data_dir.join("projects")
    }
    pub fn osm_dir(&self) -> PathBuf {
        self.data_dir.join("osm")
    }
    pub fn cache_dir(&self) -> PathBuf {
        self.data_dir.join("cache")
    }
    /// Copernicus DEM tiles (shared by all projects)
    pub fn dem_dir(&self) -> PathBuf {
        self.data_dir.join("dem")
    }
    pub fn project_dir(&self, id: &str) -> Result<PathBuf, String> {
        if id.is_empty() || id.contains('/') || id.contains("..") || id.contains('\\') {
            return Err("Ungültige Projekt-ID".into());
        }
        Ok(self.projects_dir().join(id))
    }
    pub fn emit(&self, name: &str, payload: serde_json::Value) {
        (self.emit)(name, payload)
    }
}
