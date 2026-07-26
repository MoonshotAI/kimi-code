/// In-memory cron task store for a single CLI session.
///
/// The store is purely in-memory; cross-restart persistence is layered
/// on top by the CronManager. Insertion order is preserved by relying
/// on `Vec` iteration order.

use crate::cron::types::{CronTask, CronTaskInit};
use std::collections::HashMap;

/// Upper bound on id-collision retries.
const MAX_ID_ATTEMPTS: u8 = 8;

/// Input to `SessionCronStore::add`: everything the caller supplies,
/// minus `id` and `created_at` which the store generates.
pub type SessionCronTaskInit = CronTaskInit;

/// In-memory cron task store.
#[derive(Debug, Default)]
pub struct SessionCronStore {
    /// Backing map. Insertion order is tracked separately.
    tasks: HashMap<String, CronTask>,
    /// Insertion order tracking.
    order: Vec<String>,
}

impl SessionCronStore {
    /// Create a new empty store.
    pub fn new() -> Self {
        Self {
            tasks: HashMap::new(),
            order: Vec::new(),
        }
    }

    /// Generate a fresh 8-hex id and add the task.
    /// `created_at` is set to the supplied `now_ms`.
    pub fn add(&mut self, init: SessionCronTaskInit, now_ms: u64) -> CronTask {
        let id = self.generate_unique_id();
        let task = CronTask {
            id: id.clone(),
            cron: init.cron,
            prompt: init.prompt,
            created_at: now_ms,
            recurring: init.recurring,
            last_fired_at: None,
        };
        self.tasks.insert(id.clone(), task.clone());
        self.order.push(id);
        task
    }

    /// Insert a previously-persisted task verbatim — id and created_at
    /// stay as they are on disk.
    pub fn adopt(&mut self, task: CronTask) {
        let id = task.id.clone();
        if !self.tasks.contains_key(&id) {
            self.order.push(id.clone());
        }
        self.tasks.insert(id, task);
    }

    /// Stamp `last_fired_at` on the in-memory task.
    /// Returns the updated record, or `None` when no task with that id is present.
    pub fn mark_fired(&mut self, id: &str, last_fired_at: u64) -> Option<CronTask> {
        let existing = self.tasks.get(id)?;
        let mut updated = existing.clone();
        updated.last_fired_at = Some(last_fired_at);
        self.tasks.insert(id.to_string(), updated.clone());
        Some(updated)
    }

    /// Returns the task or `None`.
    pub fn get(&self, id: &str) -> Option<&CronTask> {
        self.tasks.get(id)
    }

    /// Snapshot in insertion order.
    pub fn list(&self) -> Vec<CronTask> {
        self.order
            .iter()
            .filter_map(|id| self.tasks.get(id).cloned())
            .collect()
    }

    /// Remove the given ids. Returns the subset that were actually present.
    pub fn remove(&mut self, ids: &[&str]) -> Vec<String> {
        let mut removed = Vec::new();
        for id in ids {
            if self.tasks.remove(*id).is_some() {
                removed.push(id.to_string());
                self.order.retain(|o| o != id);
            }
        }
        removed
    }

    /// Empty the store.
    pub fn clear(&mut self) {
        self.tasks.clear();
        self.order.clear();
    }

    /// Number of tasks in the store.
    pub fn len(&self) -> usize {
        self.tasks.len()
    }

    /// Returns true if the store is empty.
    pub fn is_empty(&self) -> bool {
        self.tasks.is_empty()
    }

    fn generate_unique_id(&self) -> String {
        for _ in 0..MAX_ID_ATTEMPTS {
            let id: String = (0..8)
                .map(|_| {
                    let v = fastrand::u8(0..16);
                    std::char::from_digit(v as u32, 16).unwrap()
                })
                .collect();
            if !self.tasks.contains_key(&id) {
                return id;
            }
        }
        panic!(
            "SessionCronStore: failed to generate a unique 8-hex id after {} attempts",
            MAX_ID_ATTEMPTS
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_add_and_list() {
        let mut store = SessionCronStore::new();
        let init = CronTaskInit {
            cron: "0 9 * * *".into(),
            prompt: "morning reminder".into(),
            recurring: None,
        };
        let task = store.add(init, 1000);
        assert_eq!(task.id.len(), 8);
        assert_eq!(task.created_at, 1000);
        assert_eq!(store.len(), 1);

        let list = store.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, task.id);
    }

    #[test]
    fn test_remove() {
        let mut store = SessionCronStore::new();
        let task = store.add(
            CronTaskInit {
                cron: "*/5 * * * *".into(),
                prompt: "test".into(),
                recurring: None,
            },
            1000,
        );
        assert_eq!(store.len(), 1);

        let removed = store.remove(&[&task.id]);
        assert_eq!(removed.len(), 1);
        assert_eq!(store.len(), 0);
    }

    #[test]
    fn test_remove_nonexistent() {
        let mut store = SessionCronStore::new();
        let removed = store.remove(&["deadbeef"]);
        assert!(removed.is_empty());
    }

    #[test]
    fn test_mark_fired() {
        let mut store = SessionCronStore::new();
        let task = store.add(
            CronTaskInit {
                cron: "0 9 * * *".into(),
                prompt: "test".into(),
                recurring: None,
            },
            1000,
        );
        let updated = store.mark_fired(&task.id, 2000);
        assert!(updated.is_some());
        assert_eq!(updated.unwrap().last_fired_at, Some(2000));

        // Original should also be updated
        let fetched = store.get(&task.id);
        assert_eq!(fetched.unwrap().last_fired_at, Some(2000));
    }

    #[test]
    fn test_adopt() {
        let mut store = SessionCronStore::new();
        let task = CronTask {
            id: "deadbeef".into(),
            cron: "0 9 * * *".into(),
            prompt: "adopted".into(),
            created_at: 500,
            recurring: None,
            last_fired_at: None,
        };
        store.adopt(task);
        assert_eq!(store.len(), 1);
        assert_eq!(store.get("deadbeef").unwrap().cron, "0 9 * * *");
    }

    #[test]
    fn test_clear() {
        let mut store = SessionCronStore::new();
        store.add(
            CronTaskInit {
                cron: "* * * * *".into(),
                prompt: "t1".into(),
                recurring: None,
            },
            1000,
        );
        store.add(
            CronTaskInit {
                cron: "*/5 * * * *".into(),
                prompt: "t2".into(),
                recurring: None,
            },
            1000,
        );
        assert_eq!(store.len(), 2);
        store.clear();
        assert!(store.is_empty());
    }

    #[test]
    fn test_adoption_order_preserved() {
        let mut store = SessionCronStore::new();
        let t1 = store.add(
            CronTaskInit {
                cron: "* * * * *".into(),
                prompt: "first".into(),
                recurring: None,
            },
            1000,
        );
        let t2 = store.add(
            CronTaskInit {
                cron: "*/5 * * * *".into(),
                prompt: "second".into(),
                recurring: None,
            },
            1000,
        );

        let list = store.list();
        assert_eq!(list[0].id, t1.id);
        assert_eq!(list[1].id, t2.id);
    }
}