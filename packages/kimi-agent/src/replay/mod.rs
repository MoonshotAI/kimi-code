/// ReplayBuilder — collects replay records during state restoration.
///
/// Corresponds to `packages/agent-core/src/agent/replay/index.ts`.
///
/// During resume, the replay builder collects structured records
/// (goal updates, plan updates, compaction events) that are sent
/// to the UI once restoration is complete, so the UI can rebuild
/// its state without processing every individual wire record.

use serde::{Deserialize, Serialize};

/// A single replay record.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ReplayRecord {
    GoalUpdated {
        snapshot: serde_json::Value,
        change: serde_json::Value,
    },
    PlanUpdated {
        enabled: bool,
    },
    Compaction {
        instruction: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result: Option<String>,
    },
}

/// ReplayBuilder — collects replay records.
pub struct ReplayBuilder {
    /// Whether we're in the post-restoration phase.
    pub post_restoring: bool,
    /// Whether to capture live records (outside of restoration).
    capture_live_records: bool,
    /// Collected replay records.
    records: Vec<ReplayRecord>,
    /// Whether the record buffer is frozen (should not accept new records).
    frozen: bool,
}

impl ReplayBuilder {
    /// Create a new ReplayBuilder.
    pub fn new() -> Self {
        Self {
            post_restoring: false,
            capture_live_records: false,
            records: Vec::new(),
            frozen: false,
        }
    }

    /// Push a replay record.
    pub fn push(&mut self, record: ReplayRecord) {
        if self.frozen {
            return;
        }
        if !self.capture_live_records && !self.post_restoring {
            return;
        }
        self.records.push(record);
    }

    /// Patch the last record of a given type by modifying it in place.
    pub fn patch_last(&mut self, record_type: &str, patch: serde_json::Value) {
        if self.frozen {
            return;
        }
        // Find the last record matching the type and merge the patch.
        let type_matches = match self.records.last() {
            Some(ReplayRecord::GoalUpdated { .. }) if record_type == "goal_updated" => true,
            Some(ReplayRecord::PlanUpdated { .. }) if record_type == "plan_updated" => true,
            Some(ReplayRecord::Compaction { .. }) if record_type == "compaction" => true,
            _ => false,
        };
        if type_matches {
            if let Some(record) = self.records.last_mut() {
                match record {
                    ReplayRecord::Compaction { result, .. } => {
                        if let Some(r) = patch.get("result").and_then(|v| v.as_str()) {
                            *result = Some(r.to_string());
                        }
                    }
                    ReplayRecord::GoalUpdated { snapshot, change } => {
                        if let Some(s) = patch.get("snapshot") {
                            *snapshot = s.clone();
                        }
                        if let Some(c) = patch.get("change") {
                            *change = c.clone();
                        }
                    }
                    ReplayRecord::PlanUpdated { enabled } => {
                        if let Some(e) = patch.get("enabled").and_then(|v| v.as_bool()) {
                            *enabled = e;
                        }
                    }
                }
            }
        }
    }

    /// Build the result — returns all collected records.
    pub fn build_result(&self) -> &[ReplayRecord] {
        &self.records
    }

    /// Clear all collected records.
    pub fn clear(&mut self) {
        self.records.clear();
    }

    /// Freeze the builder (no more records accepted).
    pub fn freeze(&mut self) {
        self.frozen = true;
    }

    /// Unfreeze the builder.
    pub fn unfreeze(&mut self) {
        self.frozen = false;
    }

    /// Set whether to capture live records.
    pub fn set_capture_live_records(&mut self, capture: bool) {
        self.capture_live_records = capture;
    }
}

impl Default for ReplayBuilder {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_builder_empty() {
        let rb = ReplayBuilder::new();
        assert!(rb.build_result().is_empty());
        assert!(!rb.post_restoring);
    }

    #[test]
    fn test_push_not_captured_by_default() {
        let mut rb = ReplayBuilder::new();
        rb.push(ReplayRecord::PlanUpdated { enabled: true });
        assert!(rb.build_result().is_empty());
    }

    #[test]
    fn test_push_captured_when_post_restoring() {
        let mut rb = ReplayBuilder::new();
        rb.post_restoring = true;
        rb.push(ReplayRecord::PlanUpdated { enabled: true });
        assert_eq!(rb.build_result().len(), 1);
    }

    #[test]
    fn test_push_captured_when_capture_live() {
        let mut rb = ReplayBuilder::new();
        rb.set_capture_live_records(true);
        rb.push(ReplayRecord::PlanUpdated { enabled: true });
        assert_eq!(rb.build_result().len(), 1);
    }

    #[test]
    fn test_frozen_prevents_push() {
        let mut rb = ReplayBuilder::new();
        rb.post_restoring = true;
        rb.freeze();
        rb.push(ReplayRecord::PlanUpdated { enabled: true });
        assert!(rb.build_result().is_empty());
    }

    #[test]
    fn test_unfreeze_allows_push() {
        let mut rb = ReplayBuilder::new();
        rb.post_restoring = true;
        rb.freeze();
        rb.unfreeze();
        rb.push(ReplayRecord::PlanUpdated { enabled: true });
        assert_eq!(rb.build_result().len(), 1);
    }

    #[test]
    fn test_clear() {
        let mut rb = ReplayBuilder::new();
        rb.post_restoring = true;
        rb.push(ReplayRecord::PlanUpdated { enabled: true });
        rb.clear();
        assert!(rb.build_result().is_empty());
    }

    #[test]
    fn test_patch_last_compaction() {
        let mut rb = ReplayBuilder::new();
        rb.post_restoring = true;
        rb.push(ReplayRecord::Compaction {
            instruction: Some("compact".into()),
            result: None,
        });
        rb.patch_last("compaction", serde_json::json!({"result": "completed"}));

        let records = rb.build_result();
        if let ReplayRecord::Compaction { result, .. } = &records[0] {
            assert_eq!(result.as_deref(), Some("completed"));
        } else {
            panic!("Expected Compaction record");
        }
    }

    #[test]
    fn test_patch_last_wrong_type_noop() {
        let mut rb = ReplayBuilder::new();
        rb.post_restoring = true;
        rb.push(ReplayRecord::PlanUpdated { enabled: true });
        rb.patch_last("compaction", serde_json::json!({"result": "completed"}));

        let records = rb.build_result();
        assert_eq!(records.len(), 1);
    }

    #[test]
    fn test_goal_updated_record() {
        let mut rb = ReplayBuilder::new();
        rb.post_restoring = true;
        rb.push(ReplayRecord::GoalUpdated {
            snapshot: serde_json::json!({"status": "active"}),
            change: serde_json::json!({"kind": "created"}),
        });

        let records = rb.build_result();
        assert_eq!(records.len(), 1);
        if let ReplayRecord::GoalUpdated { snapshot, change } = &records[0] {
            assert_eq!(snapshot["status"], "active");
            assert_eq!(change["kind"], "created");
        } else {
            panic!("Expected GoalUpdated record");
        }
    }

    #[test]
    fn test_build_result_returns_all() {
        let mut rb = ReplayBuilder::new();
        rb.post_restoring = true;
        rb.push(ReplayRecord::PlanUpdated { enabled: true });
        rb.push(ReplayRecord::PlanUpdated { enabled: false });
        assert_eq!(rb.build_result().len(), 2);
    }
}