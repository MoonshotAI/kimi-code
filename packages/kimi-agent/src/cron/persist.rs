/// Cron task persistence interface.
///
/// This module provides a trait for persisting cron tasks. The actual
/// file I/O is delegated to the JS host via callbacks, since the Rust
/// side should not duplicate file path resolution, workspace policy,
/// and other logic already implemented in the JS layer.

use crate::cron::types::CronTask;
use std::sync::Arc;

/// Trait for persisting cron tasks.
///
/// The JS host implements this trait and registers it with the CronManager.
pub trait CronPersistStore: Send + Sync {
    /// Write a task to persistent storage.
    fn write(&self, task: &CronTask) -> Result<(), String>;

    /// Remove a task from persistent storage by id.
    fn remove(&self, id: &str) -> Result<(), String>;

    /// List all tasks from persistent storage.
    fn list(&self) -> Result<Vec<CronTask>, String>;
}

/// A no-op persist store that discards all writes.
/// Used for ephemeral sessions (subagents, tests).
pub struct NullCronPersistStore;

impl CronPersistStore for NullCronPersistStore {
    fn write(&self, _task: &CronTask) -> Result<(), String> {
        Ok(())
    }

    fn remove(&self, _id: &str) -> Result<(), String> {
        Ok(())
    }

    fn list(&self) -> Result<Vec<CronTask>, String> {
        Ok(vec![])
    }
}

/// A persist store backed by a closure-based callback.
/// The JS host provides the closure.
pub struct CallbackCronPersistStore {
    write_fn: Arc<dyn Fn(&CronTask) -> Result<(), String> + Send + Sync>,
    remove_fn: Arc<dyn Fn(&str) -> Result<(), String> + Send + Sync>,
    list_fn: Arc<dyn Fn() -> Result<Vec<CronTask>, String> + Send + Sync>,
}

impl CallbackCronPersistStore {
    pub fn new(
        write_fn: Arc<dyn Fn(&CronTask) -> Result<(), String> + Send + Sync>,
        remove_fn: Arc<dyn Fn(&str) -> Result<(), String> + Send + Sync>,
        list_fn: Arc<dyn Fn() -> Result<Vec<CronTask>, String> + Send + Sync>,
    ) -> Self {
        Self { write_fn, remove_fn, list_fn }
    }
}

impl CronPersistStore for CallbackCronPersistStore {
    fn write(&self, task: &CronTask) -> Result<(), String> {
        (self.write_fn)(task)
    }

    fn remove(&self, id: &str) -> Result<(), String> {
        (self.remove_fn)(id)
    }

    fn list(&self) -> Result<Vec<CronTask>, String> {
        (self.list_fn)()
    }
}

/// Validates an on-disk cron task record.
/// Returns true if the value is a valid CronTask.
pub fn is_valid_cron_task(obj: &serde_json::Value) -> bool {
    match obj {
        serde_json::Value::Object(map) => {
            // Check required fields
            match map.get("id") {
                Some(serde_json::Value::String(s)) => {
                    if s.len() != 8 || !s.chars().all(|c| c.is_ascii_hexdigit()) {
                        return false;
                    }
                }
                _ => return false,
            }
            match map.get("cron") {
                Some(serde_json::Value::String(s)) if !s.is_empty() => {}
                _ => return false,
            }
            match map.get("prompt") {
                Some(serde_json::Value::String(s)) if !s.is_empty() => {}
                _ => return false,
            }
            match map.get("created_at") {
                Some(serde_json::Value::Number(n)) => {
                    if !n.is_f64() {
                        return false;
                    }
                }
                _ => return false,
            }
            // Optional fields
            if let Some(recurring) = map.get("recurring") {
                if !recurring.is_boolean() {
                    return false;
                }
            }
            if let Some(lfa) = map.get("last_fired_at") {
                match lfa {
                    serde_json::Value::Number(n) => {
                        if !n.is_f64() {
                            return false;
                        }
                    }
                    _ => return false,
                }
            }
            true
        }
        _ => false,
    }
}