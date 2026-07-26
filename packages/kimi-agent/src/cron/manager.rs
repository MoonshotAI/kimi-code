/// CronManager — Agent-facing facade for the cron scheduler.
///
/// This layer sits between the raw `CronScheduler` and the agent runtime.
/// Its job:
///
/// - Own the `SessionCronStore` for this session
/// - Hand `store.list()` to the scheduler as the source callback
/// - Gate fires on idleness rather than maintaining a duplicate flag
/// - Translate a fired `CronTask` into an event sent to the JS host
/// - Mirror mutations to persistent storage
/// - Handle 7-day stale detection and auto-expire

use std::sync::{Arc, Mutex};

use crate::cron::clock::ClockSources;
use crate::cron::persist::CronPersistStore;
use crate::cron::scheduler::{CronScheduler, CronSchedulerOptions};
use crate::cron::store::{SessionCronStore, SessionCronTaskInit};
use crate::cron::types::{CronFireEvent, CronTask, JitterConfig};

const STALE_THRESHOLD_MS: u64 = 7 * 24 * 60 * 60 * 1000;

/// Snapshot of a scheduled cron task for external monitoring.
#[derive(Debug, Clone)]
pub struct CronTaskSnapshot {
    pub id: String,
    pub cron: String,
    pub recurring: bool,
    pub created_at: u64,
    pub last_fired_at: Option<u64>,
    pub next_fire_at: Option<u64>,
}

/// Callback for emitting cron fire events to the JS host.
pub type FireEventCallback = Arc<dyn Fn(&CronFireEvent) + Send + Sync>;

/// The CronManager.
pub struct CronManager {
    /// In-memory task store (shared via Arc<Mutex> for scheduler access).
    store: Arc<Mutex<SessionCronStore>>,
    /// Clock source.
    clocks: ClockSources,
    /// The underlying scheduler.
    scheduler: Option<CronScheduler>,
    /// Persistence store (optional).
    persist_store: Option<Box<dyn CronPersistStore>>,
    /// Callback to emit fire events to JS host.
    fire_event_callback: Option<FireEventCallback>,
    /// Callback for telemetry (optional).
    telemetry_callback: Option<Arc<dyn Fn(&str, &serde_json::Value) + Send + Sync>>,
    /// Whether the manager has been started.
    started: bool,
    /// Jitter config.
    jitter_config: JitterConfig,
}

impl CronManager {
    /// Create a new CronManager.
    pub fn new(clocks: Option<ClockSources>) -> Self {
        Self {
            store: Arc::new(Mutex::new(SessionCronStore::new())),
            clocks: clocks.unwrap_or_default(),
            scheduler: None,
            persist_store: None,
            fire_event_callback: None,
            telemetry_callback: None,
            started: false,
            jitter_config: JitterConfig::default(),
        }
    }

    /// Set the fire event callback (called when a cron job fires).
    pub fn set_fire_event_callback(&mut self, cb: FireEventCallback) {
        self.fire_event_callback = Some(cb);
    }

    /// Set the persist store.
    pub fn set_persist_store(&mut self, store: Box<dyn CronPersistStore>) {
        self.persist_store = Some(store);
    }

    /// Set the telemetry callback.
    pub fn set_telemetry_callback(
        &mut self,
        cb: Arc<dyn Fn(&str, &serde_json::Value) + Send + Sync>,
    ) {
        self.telemetry_callback = Some(cb);
    }

    /// Set jitter config.
    pub fn set_jitter_config(&mut self, config: JitterConfig) {
        self.jitter_config = config;
    }

    /// Initialize and start the scheduler.
    pub fn start(&mut self) {
        if self.started {
            return;
        }

        let store = self.store.clone();
        let clocks = self.clocks.clone();
        let jitter_config = self.jitter_config;
        let fire_cb = self.fire_event_callback.clone();

        // Source callback: snapshot the store on each tick
        let source_tasks = Box::new(move || {
            store.lock().unwrap_or_else(|e| e.into_inner()).list()
        });

        // Fire callback wrapper
        let fire_cb_wrapper = fire_cb.clone();
        let on_fire = Box::new(move |task: &CronTask, coalesced_count: u32| {
            if let Some(ref cb) = fire_cb_wrapper {
                let stale = is_stale(task.created_at, (ClockSources::system().wall_now)());
                let event = CronFireEvent {
                    kind: "cron.fired".into(),
                    job_id: task.id.clone(),
                    cron: task.cron.clone(),
                    recurring: task.is_recurring(),
                    coalesced_count,
                    stale,
                    prompt: task.prompt.clone(),
                };
                cb(&event);
            }
        });

        // Idle check — always true for now; JS host will gate via the callback
        let is_idle = Box::new(|| true);

        // Build the scheduler
        let scheduler = CronScheduler::new(CronSchedulerOptions {
            clocks,
            source: source_tasks,
            on_fire,
            is_idle,
            is_killed: None,
            remove_one_shot: None,
            on_advance_cursor: None,
            poll_interval_ms: None,
            jitter_config: Some(jitter_config),
        });

        self.scheduler = Some(scheduler);
        self.started = true;
    }

    /// Add a fresh task to the store and optionally persist it.
    pub fn add_task(&mut self, init: SessionCronTaskInit) -> CronTask {
        let now = (self.clocks.wall_now)();
        let task = {
            let mut store = self.store.lock().unwrap_or_else(|e| e.into_inner());
            store.add(init, now)
        };

        // Mirror to persistence
        if let Some(ref persist) = self.persist_store {
            if let Err(e) = persist.write(&task) {
                eprintln!("[cron] persist write failed for task {}: {}", task.id, e);
            }
        }

        // Telemetry
        if let Some(ref cb) = self.telemetry_callback {
            let props = serde_json::json!({
                "recurring": task.is_recurring(),
            });
            cb("cron_scheduled", &props);
        }

        task
    }

    /// Remove a batch of tasks. Returns the ids that were actually removed.
    pub fn remove_tasks(&mut self, ids: &[&str]) -> Vec<String> {
        let removed = {
            let mut store = self.store.lock().unwrap_or_else(|e| e.into_inner());
            store.remove(ids)
        };

        for id in &removed {
            if let Some(ref persist) = self.persist_store {
                if let Err(e) = persist.remove(id) {
                    eprintln!("[cron] persist remove failed for task {}: {}", id, e);
                }
            }

            // Telemetry
            if let Some(ref cb) = self.telemetry_callback {
                let props = serde_json::json!({
                    "task_id": id,
                });
                cb("cron_deleted", &props);
            }
        }

        removed
    }

    /// Rehydrate the store from persistence.
    pub fn load_from_disk(&mut self) -> Result<(), String> {
        if let Some(ref persist) = self.persist_store {
            let tasks = persist.list()?;
            let mut store = self.store.lock().unwrap_or_else(|e| e.into_inner());
            store.clear();
            for task in tasks {
                store.adopt(task);
            }
        }
        Ok(())
    }

    /// Re-schedule a task (update its cron expression).
    pub fn reschedule(&mut self, task: CronTask) {
        let mut store = self.store.lock().unwrap_or_else(|e| e.into_inner());
        store.adopt(task);
    }

    /// Drive one scheduler tick.
    pub fn tick(&mut self) {
        if let Some(ref mut scheduler) = self.scheduler {
            scheduler.tick();
        }
    }

    /// Get next fire time across all tasks (earliest).
    pub fn get_next_fire_time(&mut self) -> Option<u64> {
        self.scheduler.as_mut().and_then(|s| s.get_next_fire_time())
    }

    /// Get next fire time for a specific task.
    pub fn get_next_fire_for_task(&mut self, task_id: &str) -> Option<u64> {
        self.scheduler
            .as_mut()
            .and_then(|s| s.get_next_fire_for_task(task_id))
    }

    /// List all tasks with their next fire times.
    pub fn list_task_snapshots(&mut self) -> Vec<CronTaskSnapshot> {
        let tasks = {
            let store = self.store.lock().unwrap_or_else(|e| e.into_inner());
            store.list()
        };
        tasks
            .into_iter()
            .map(|t| {
                let next = self.get_next_fire_for_task(&t.id);
                CronTaskSnapshot {
                    id: t.id.clone(),
                    cron: t.cron.clone(),
                    recurring: t.is_recurring(),
                    created_at: t.created_at,
                    last_fired_at: t.last_fired_at,
                    next_fire_at: next,
                }
            })
            .collect()
    }

    /// Returns the number of tasks in the store.
    pub fn task_count(&self) -> usize {
        self.store.lock().unwrap_or_else(|e| e.into_inner()).len()
    }
}

/// Check if a task is stale (older than 7 days).
fn is_stale(created_at: u64, now: u64) -> bool {
    if std::env::var("KIMI_CRON_NO_STALE") == Ok("1".into()) {
        return false;
    }
    let age = now.saturating_sub(created_at);
    age >= STALE_THRESHOLD_MS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_add_and_list() {
        let mut manager = CronManager::new(None);
        let task = manager.add_task(crate::cron::types::CronTaskInit {
            cron: "0 9 * * *".into(),
            prompt: "morning".into(),
            recurring: None,
        });
        assert_eq!(task.id.len(), 8);
        assert!(manager.task_count() == 1);
    }

    #[test]
    fn test_remove() {
        let mut manager = CronManager::new(None);
        let task = manager.add_task(crate::cron::types::CronTaskInit {
            cron: "*/5 * * * *".into(),
            prompt: "every5".into(),
            recurring: None,
        });
        let removed = manager.remove_tasks(&[&task.id]);
        assert_eq!(removed.len(), 1);
        assert!(manager.task_count() == 0);
    }

    #[test]
    fn test_is_stale_new() {
        let now = 1000000u64;
        let created = now - 1000; // 1 second ago
        assert!(!is_stale(created, now));
    }

    #[test]
    fn test_is_stale_old() {
        let now = 700000000u64;
        let created = now - STALE_THRESHOLD_MS - 1; // just past 7 days
        assert!(is_stale(created, now));
    }

    #[test]
    fn test_remove_nonexistent() {
        let mut manager = CronManager::new(None);
        let removed = manager.remove_tasks(&["deadbeef"]);
        assert!(removed.is_empty());
    }

    // ── Direct-call RPC integration tests ─────────────────────────────────────

    #[test]
    fn test_cron_create_via_rpc() {
        let server = std::sync::Arc::new(crate::rpc::server::RpcServer::new());
        let mgr = std::sync::Arc::new(std::sync::Mutex::new(CronManager::new(None)));

        // Register handler
        let cm = mgr.clone();
        crate::rpc::server::RpcServer::register_arc(
            &server,
            crate::rpc::types::methods::CRON_CREATE,
            move |params| {
                let cm = cm.clone();
                Box::pin(async move {
                    let input: crate::rpc::types::CronCreateParams =
                        serde_json::from_value(params)
                            .map_err(|e| crate::rpc::types::JsonRpcError::internal_error(e.to_string()))?;
                    let mut mgr = cm.lock().unwrap_or_else(|e| e.into_inner());
                    let task = mgr.add_task(crate::cron::types::CronTaskInit {
                        cron: input.cron,
                        prompt: input.prompt,
                        recurring: input.recurring,
                    });
                    let recurring = task.is_recurring();
                    serde_json::to_value(&crate::rpc::types::CronCreateResult {
                        id: task.id,
                        cron: task.cron,
                        prompt: task.prompt,
                        created_at: task.created_at,
                        recurring,
                    })
                    .map_err(|e| crate::rpc::types::JsonRpcError::internal_error(e.to_string()))
                })
            },
        );

        // Call via RPC
        let params = serde_json::json!({
            "cron": "0 9 * * *",
            "prompt": "daily reminder",
            "recurring": true
        });
        let result = futures::executor::block_on(
            server.direct_call(crate::rpc::types::methods::CRON_CREATE, params)
        );
        assert!(result.is_ok());
        let val = result.unwrap();
        assert_eq!(val["cron"], "0 9 * * *");
        assert!(val["id"].as_str().unwrap().len() == 8);
    }
}