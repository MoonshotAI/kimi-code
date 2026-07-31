/// PlanMode — plan mode state machine.
///
/// Corresponds to `packages/agent-core/src/agent/plan/index.ts` (this file)
/// plus the v2 additions: the wire ops in [`ops`] and the reminder-injection
/// provider in [`injection`].
///
/// Manages plan mode state (active/inactive, plan ID, file path). File
/// system operations (read/write plan files) are delegated through the
/// `Kaos` trait, which maps to the JS host on the napi/stdio path.

pub mod injection;
pub mod ops;

use serde::{Deserialize, Serialize};

/// Plan data returned by `data()`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanData {
    pub id: String,
    pub content: String,
    pub path: String,
}

/// A plan file path, or null when no plan is active.
pub type PlanFilePath = Option<String>;

/// Configuration for PlanMode.
#[derive(Debug, Clone)]
pub struct PlanConfig {
    /// Directory where plan files are stored. Default: "plan".
    pub plan_dir: String,
}

impl Default for PlanConfig {
    fn default() -> Self {
        Self {
            plan_dir: "plan".to_string(),
        }
    }
}

/// Abstract filesystem operations needed by PlanMode.
///
/// This maps to the `kaos` filesystem API in TS.
pub trait Kaos: Send + Sync {
    /// Read the text content of a file. Returns Ok("") on not-found.
    fn read_text(&self, path: &str) -> Result<String, String>;
    /// Write text content to a file.
    fn write_text(&self, path: &str, content: &str) -> Result<(), String>;
    /// Ensure a directory exists (parents, exist_ok).
    fn mkdir(&self, path: &str) -> Result<(), String>;
}

/// PlanMode state machine.
pub struct PlanMode {
    is_active: bool,
    plan_id: Option<String>,
    plan_file_path: PlanFilePath,
    kaos: Box<dyn Kaos>,
    delegate: Option<Box<dyn PlanDelegate + Send + Sync>>,
    config: PlanConfig,
}

/// Delegate trait for plan side effects (record logging, events, replay).
pub trait PlanDelegate: Send + Sync {
    /// Called when plan mode is entered.
    fn on_plan_entered(&self, plan_id: &str, plan_file_path: &str);
    /// Called when plan mode is cancelled or exited.
    fn on_plan_cancelled(&self, plan_id: Option<&str>);
    /// Called when plan content is updated (cleared or externally modified).
    fn on_plan_updated(&self, plan_id: &str, content: &str);
}

impl PlanMode {
    /// Create a new PlanMode with the given filesystem backend.
    pub fn new(kaos: Box<dyn Kaos>) -> Self {
        Self {
            is_active: false,
            plan_id: None,
            plan_file_path: None,
            kaos,
            delegate: None,
            config: PlanConfig::default(),
        }
    }

    /// Set the configuration (e.g. plan directory).
    pub fn set_config(&mut self, config: PlanConfig) {
        self.config = config;
    }

    /// Attach a delegate for record logging and event emission side effects.
    pub fn set_delegate(&mut self, delegate: Box<dyn PlanDelegate + Send + Sync>) {
        self.delegate = Some(delegate);
    }

    /// Generate a plan ID.
    /// Simple implementation using a monotonic counter + hex.
    pub fn create_plan_id(&self) -> String {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        format!("plan-{:016x}", nanos)
    }

    /// Enter plan mode.
    pub fn enter(&mut self, id: Option<&str>, create_file: bool) -> Result<(), String> {
        if self.is_active {
            return Err("Already in plan mode".to_string());
        }

        let plan_id = id.map(|s| s.to_string()).unwrap_or_else(|| self.create_plan_id());
        let plan_file_path = self.plan_file_path_for(&plan_id);

        self.is_active = true;
        self.plan_id = Some(plan_id);
        self.plan_file_path = Some(plan_file_path.clone());

        // Ensure the plan directory exists.
        if let Some(parent) = std::path::Path::new(&plan_file_path).parent() {
            self.kaos.mkdir(parent.to_str().unwrap_or("."))?;
        }

        if create_file {
            self.kaos.write_text(&plan_file_path, "")?;
        }

        if let Some(ref delegate) = self.delegate {
            delegate.on_plan_entered(self.plan_id.as_deref().unwrap_or(""), &plan_file_path);
        }

        Ok(())
    }

    /// Restore plan mode from a persisted state (replay).
    pub fn restore_enter(&mut self, id: &str) {
        let plan_file_path = self.plan_file_path_for(id);
        self.is_active = true;
        self.plan_id = Some(id.to_string());
        self.plan_file_path = Some(plan_file_path);
    }

    /// Cancel the current plan.
    pub fn cancel(&mut self) {
        let plan_id = self.plan_id.clone();
        self.is_active = false;
        self.plan_id = None;
        self.plan_file_path = None;
        if let Some(ref delegate) = self.delegate {
            delegate.on_plan_cancelled(plan_id.as_deref());
        }
    }

    /// Clear the plan file content (write empty).
    pub fn clear(&mut self) -> Result<(), String> {
        if let Some(ref path) = self.plan_file_path {
            self.kaos.write_text(path, "")?;
        }
        if let Some(ref delegate) = self.delegate {
            if let Some(ref id) = self.plan_id {
                delegate.on_plan_updated(id, "");
            }
        }
        Ok(())
    }

    /// Exit plan mode (same as cancel).
    pub fn exit(&mut self) {
        self.cancel();
    }

    /// Whether plan mode is currently active.
    pub fn is_active(&self) -> bool {
        self.is_active
    }

    /// The current plan file path, if any.
    pub fn plan_file_path(&self) -> PlanFilePath {
        self.plan_file_path.clone()
    }

    /// The current plan ID, if any.
    pub fn plan_id(&self) -> Option<&str> {
        self.plan_id.as_deref()
    }

    /// Return the plan data (id, content, path) or None if no active plan.
    pub fn data(&self) -> Result<Option<PlanData>, String> {
        let plan_id = match &self.plan_id {
            Some(id) => id.clone(),
            None => return Ok(None),
        };
        let plan_path = match &self.plan_file_path {
            Some(p) => p.clone(),
            None => return Ok(None),
        };

        let content = match self.kaos.read_text(&plan_path) {
            Ok(c) => c,
            Err(_) => String::new(), // ENOENT → empty
        };

        Ok(Some(PlanData {
            id: plan_id,
            content,
            path: plan_path,
        }))
    }

    /// Compute the plan file path for a given plan ID.
    fn plan_file_path_for(&self, id: &str) -> String {
        format!("{}/{}.md", self.config.plan_dir, id)
    }
}

// ── Default Kaos implementation (no-op / in-memory) ────────────────────────

/// An in-memory Kaos implementation for testing.
pub struct InMemoryKaos {
    files: std::sync::Mutex<std::collections::HashMap<String, String>>,
}

impl InMemoryKaos {
    pub fn new() -> Self {
        Self {
            files: std::sync::Mutex::new(std::collections::HashMap::new()),
        }
    }
}

impl Kaos for InMemoryKaos {
    fn read_text(&self, path: &str) -> Result<String, String> {
        let files = self.files.lock().unwrap();
        Ok(files.get(path).cloned().unwrap_or_default())
    }

    fn write_text(&self, path: &str, content: &str) -> Result<(), String> {
        let mut files = self.files.lock().unwrap();
        files.insert(path.to_string(), content.to_string());
        Ok(())
    }

    fn mkdir(&self, _path: &str) -> Result<(), String> {
        Ok(())
    }
}

/// A `std::fs`-backed [`Kaos`] for real sessions. Reads of a missing file
/// return an empty string (matching the trait contract), writes create parent
/// directories on demand.
pub struct FsKaos;

impl Kaos for FsKaos {
    fn read_text(&self, path: &str) -> Result<String, String> {
        match std::fs::read_to_string(path) {
            Ok(content) => Ok(content),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            Err(e) => Err(format!("read {path}: {e}")),
        }
    }

    fn write_text(&self, path: &str, content: &str) -> Result<(), String> {
        if let Some(parent) = std::path::Path::new(path).parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
        }
        std::fs::write(path, content).map_err(|e| format!("write {path}: {e}"))
    }

    fn mkdir(&self, path: &str) -> Result<(), String> {
        std::fs::create_dir_all(path).map_err(|e| format!("mkdir {path}: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_plan_mode() -> PlanMode {
        PlanMode::new(Box::new(InMemoryKaos::new()))
    }

    #[test]
    fn test_new_plan_mode_not_active() {
        let pm = make_plan_mode();
        assert!(!pm.is_active());
        assert!(pm.plan_id().is_none());
        assert!(pm.plan_file_path().is_none());
    }

    #[test]
    fn test_enter_activates_plan() {
        let mut pm = make_plan_mode();
        pm.enter(None, false).unwrap();
        assert!(pm.is_active());
        assert!(pm.plan_id().is_some());
        assert!(pm.plan_file_path().is_some());
    }

    #[test]
    fn test_enter_twice_fails() {
        let mut pm = make_plan_mode();
        pm.enter(None, false).unwrap();
        let result = pm.enter(None, false);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "Already in plan mode");
    }

    #[test]
    fn test_cancel_deactivates() {
        let mut pm = make_plan_mode();
        pm.enter(None, false).unwrap();
        pm.cancel();
        assert!(!pm.is_active());
        assert!(pm.plan_id().is_none());
        assert!(pm.plan_file_path().is_none());
    }

    #[test]
    fn test_exit_same_as_cancel() {
        let mut pm = make_plan_mode();
        pm.enter(None, false).unwrap();
        pm.exit();
        assert!(!pm.is_active());
    }

    #[test]
    fn test_clear_writes_empty() {
        let mut pm = make_plan_mode();
        pm.enter(Some("test-plan"), true).unwrap();
        pm.clear().unwrap();
        // Check that the plan file was written empty via the kaos
        let data = pm.data().unwrap().unwrap();
        assert_eq!(data.content, "");
    }

    #[test]
    fn test_data_returns_none_when_inactive() {
        let pm = make_plan_mode();
        assert!(pm.data().unwrap().is_none());
    }

    #[test]
    fn test_data_returns_plan_info_when_active() {
        let mut pm = make_plan_mode();
        pm.enter(Some("my-plan"), true).unwrap();
        let data = pm.data().unwrap().unwrap();
        assert_eq!(data.id, "my-plan");
        assert!(data.path.contains("my-plan.md"));
    }

    #[test]
    fn test_restore_enter() {
        let mut pm = make_plan_mode();
        pm.restore_enter("restored-plan");
        assert!(pm.is_active());
        assert_eq!(pm.plan_id(), Some("restored-plan"));
    }

    #[test]
    fn test_create_plan_id_is_unique() {
        let pm = make_plan_mode();
        let id1 = pm.create_plan_id();
        let id2 = pm.create_plan_id();
        assert_ne!(id1, id2);
    }

    #[test]
    fn test_cancel_from_inactive_is_noop() {
        let mut pm = make_plan_mode();
        pm.cancel(); // Should not panic
        assert!(!pm.is_active());
    }

    #[test]
    fn test_in_memory_kaos() {
        let kaos = InMemoryKaos::new();
        kaos.write_text("/tmp/plan.md", "content").unwrap();
        assert_eq!(kaos.read_text("/tmp/plan.md").unwrap(), "content");
        assert_eq!(kaos.read_text("/nonexistent.md").unwrap(), "");
    }

    #[test]
    fn test_set_config_changes_plan_dir() {
        let mut pm = make_plan_mode();
        pm.set_config(PlanConfig {
            plan_dir: "my-plans".to_string(),
        });
        pm.enter(Some("test"), false).unwrap();
        let data = pm.data().unwrap().unwrap();
        assert!(data.path.starts_with("my-plans/"), "path: {}", data.path);
    }

    #[test]
    fn test_clear_triggers_delegate() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        let called = Arc::new(AtomicBool::new(false));
        let called_clone = called.clone();

        struct TrackingDelegate(Arc<AtomicBool>);
        impl PlanDelegate for TrackingDelegate {
            fn on_plan_entered(&self, _plan_id: &str, _plan_file_path: &str) {}
            fn on_plan_cancelled(&self, _plan_id: Option<&str>) {}
            fn on_plan_updated(&self, _plan_id: &str, _content: &str) {
                self.0.store(true, Ordering::SeqCst);
            }
        }

        let mut pm = make_plan_mode();
        pm.set_delegate(Box::new(TrackingDelegate(called_clone)));
        pm.enter(Some("test-plan"), true).unwrap();
        pm.clear().unwrap();
        assert!(called.load(Ordering::SeqCst));
    }
}