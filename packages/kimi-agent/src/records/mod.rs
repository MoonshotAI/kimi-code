/// AgentRecords — record log and replay system.
///
/// Corresponds to `packages/agent-core/src/agent/records/`.
///
/// Logs every state change as a JSON record and replays them on resume
/// to restore agent state. Supports file-system persistence and blob
/// storage for large binary data.

use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ── Types ─────────────────────────────────────────────────────────────────

/// A single record in the agent log.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentRecord {
    Metadata {
        version: u32,
    },
    GoalCreate {
        goal_id: String,
        objective: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        completion_criterion: Option<String>,
    },
    GoalUpdate {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turns_used: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tokens_used: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        wall_clock_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    GoalClear,
    UsageRecord {
        model: String,
        usage: crate::rpc::types::TokenUsage,
        #[serde(default)]
        usage_scope: String,
    },
    /// Terminal `turn.ended` record (upstream agent-core-v2 #2457): the turn's
    /// final stop reason and step count, written when the turn completes.
    TurnEnded {
        turn_id: String,
        stop_reason: String,
        steps: u32,
    },
    PlanModeEnter {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    PlanModeCancel {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    PlanModeExit {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    SwarmModeEnter {
        trigger: String,
    },
    SwarmModeExit,
    ToolsRegisterUserTool {
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
    },
    ToolsUnregisterUserTool {
        name: String,
    },
    ToolsSetActiveTools {
        names: Vec<String>,
    },
    FullCompactionBegin {
        source: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        instruction: Option<String>,
    },
    FullCompactionCancel,
    FullCompactionComplete,
    #[serde(untagged)]
    Other(Value),
}

// ── Persistence ───────────────────────────────────────────────────────────

/// Persistence backend for agent records.
pub trait AgentRecordPersistence: Send + Sync {
    /// Append a record to the log.
    fn append(&self, record: &AgentRecord) -> Result<(), String>;
    /// Read all records from the log.
    fn read_all(&self) -> Result<Vec<AgentRecord>, String>;
    /// Clear the log.
    fn clear(&self) -> Result<(), String>;
}

/// File-system backed persistence (JSON Lines format).
pub struct FileSystemAgentRecordPersistence {
    path: PathBuf,
}

impl FileSystemAgentRecordPersistence {
    /// Create a new file-system persistence at the given path.
    pub fn new(path: &str) -> Self {
        Self {
            path: PathBuf::from(path),
        }
    }

    /// Ensure the parent directory exists.
    fn ensure_dir(&self) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create directory: {e}"))?;
        }
        Ok(())
    }
}

impl AgentRecordPersistence for FileSystemAgentRecordPersistence {
    fn append(&self, record: &AgentRecord) -> Result<(), String> {
        self.ensure_dir()?;
        let json = serde_json::to_string(record).map_err(|e| format!("Serialize error: {e}"))?;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(|e| format!("Failed to open file: {e}"))?;
        writeln!(file, "{}", json).map_err(|e| format!("Write error: {e}"))?;
        Ok(())
    }

    fn read_all(&self) -> Result<Vec<AgentRecord>, String> {
        let file = match std::fs::File::open(&self.path) {
            Ok(f) => f,
            Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(format!("Failed to open file: {e}")),
        };
        let reader = std::io::BufReader::new(file);
        let mut records = Vec::new();
        for line in reader.lines() {
            let line = line.map_err(|e| format!("Read error: {e}"))?;
            if line.trim().is_empty() {
                continue;
            }
            let record: AgentRecord =
                serde_json::from_str(&line).map_err(|e| format!("Deserialize error: {e}"))?;
            records.push(record);
        }
        Ok(records)
    }

    fn clear(&self) -> Result<(), String> {
        // Truncate the file by opening it with write mode.
        let _ = std::fs::File::create(&self.path)
            .map_err(|e| format!("Failed to truncate file: {e}"))?;
        Ok(())
    }
}

/// In-memory persistence (for testing).
pub struct InMemoryAgentRecordPersistence {
    records: Mutex<Vec<AgentRecord>>,
}

impl InMemoryAgentRecordPersistence {
    pub fn new() -> Self {
        Self {
            records: Mutex::new(Vec::new()),
        }
    }
}

impl AgentRecordPersistence for InMemoryAgentRecordPersistence {
    fn append(&self, record: &AgentRecord) -> Result<(), String> {
        self.records.lock().unwrap().push(record.clone());
        Ok(())
    }

    fn read_all(&self) -> Result<Vec<AgentRecord>, String> {
        Ok(self.records.lock().unwrap().clone())
    }

    fn clear(&self) -> Result<(), String> {
        self.records.lock().unwrap().clear();
        Ok(())
    }
}

// ── BlobStore ─────────────────────────────────────────────────────────────

/// BlobStore — stores large binary data referenced by records.
pub struct BlobStore {
    blobs_dir: PathBuf,
}

impl BlobStore {
    /// Create a new BlobStore rooted at `blobs_dir`.
    pub fn new(blobs_dir: &str) -> Self {
        Self {
            blobs_dir: PathBuf::from(blobs_dir),
        }
    }

    /// Store a blob and return its reference key.
    pub fn store(&self, key: &str, data: &[u8]) -> Result<(), String> {
        std::fs::create_dir_all(&self.blobs_dir)
            .map_err(|e| format!("Failed to create blobs dir: {e}"))?;
        let path = self.blobs_dir.join(sanitize_blob_key(key));
        std::fs::write(&path, data).map_err(|e| format!("Failed to write blob: {e}"))?;
        Ok(())
    }

    /// Read a blob by key.
    pub fn read(&self, key: &str) -> Result<Vec<u8>, String> {
        let path = self.blobs_dir.join(sanitize_blob_key(key));
        std::fs::read(&path).map_err(|e| format!("Failed to read blob: {e}"))
    }

    /// Delete a blob by key.
    pub fn delete(&self, key: &str) -> Result<(), String> {
        let path = self.blobs_dir.join(sanitize_blob_key(key));
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| format!("Failed to delete blob: {e}"))?;
        }
        Ok(())
    }
}

fn sanitize_blob_key(key: &str) -> String {
    key.replace('/', "__").replace('\\', "_")
}

// ── AgentRecords ──────────────────────────────────────────────────────────

/// AgentRecords — manages the record log.
pub struct AgentRecords {
    persistence: Box<dyn AgentRecordPersistence>,
    restoring: bool,
}

impl AgentRecords {
    /// Create a new AgentRecords with the given persistence backend.
    pub fn new(persistence: Box<dyn AgentRecordPersistence>) -> Self {
        Self {
            persistence,
            restoring: false,
        }
    }

    /// Whether the agent is currently restoring state from records.
    pub fn is_restoring(&self) -> bool {
        self.restoring
    }

    /// Set the restoring flag.
    pub fn set_restoring(&mut self, restoring: bool) {
        self.restoring = restoring;
    }

    /// Log a record.
    pub fn log_record(&self, record: &AgentRecord) -> Result<(), String> {
        self.persistence.append(record)
    }

    /// Read all records.
    pub fn read_all(&self) -> Result<Vec<AgentRecord>, String> {
        self.persistence.read_all()
    }

    /// Clear all records.
    pub fn clear(&self) -> Result<(), String> {
        self.persistence.clear()
    }

    /// Replay all records for state restoration.
    /// Returns a callback-based approach: the caller provides a function
    /// that handles each record type during replay.
    pub fn replay<F>(&self, mut handler: F) -> Result<(), String>
    where
        F: FnMut(&AgentRecord) -> Result<(), String>,
    {
        let records = self.persistence.read_all()?;
        for record in &records {
            handler(record)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_in_memory_persistence() {
        let p = InMemoryAgentRecordPersistence::new();
        let records = AgentRecords::new(Box::new(p));

        records.log_record(&AgentRecord::Metadata { version: 1 }).unwrap();
        records.log_record(&AgentRecord::GoalClear).unwrap();

        let all = records.read_all().unwrap();
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn test_file_system_persistence() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("wire.jsonl");
        let p = FileSystemAgentRecordPersistence::new(path.to_str().unwrap());
        let records = AgentRecords::new(Box::new(p));

        records.log_record(&AgentRecord::Metadata { version: 1 }).unwrap();
        let all = records.read_all().unwrap();
        assert_eq!(all.len(), 1);
    }

    #[test]
    fn test_file_system_read_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nonexistent.jsonl");
        let p = FileSystemAgentRecordPersistence::new(path.to_str().unwrap());
        let records = AgentRecords::new(Box::new(p));

        let all = records.read_all().unwrap();
        assert!(all.is_empty());
    }

    #[test]
    fn test_clear() {
        let p = InMemoryAgentRecordPersistence::new();
        let records = AgentRecords::new(Box::new(p));

        records.log_record(&AgentRecord::Metadata { version: 1 }).unwrap();
        records.clear().unwrap();
        let all = records.read_all().unwrap();
        assert!(all.is_empty());
    }

    #[test]
    fn test_replay() {
        let p = InMemoryAgentRecordPersistence::new();
        p.append(&AgentRecord::Metadata { version: 1 }).unwrap();
        p.append(&AgentRecord::GoalClear).unwrap();

        let records = AgentRecords::new(Box::new(p));
        let mut count = 0;
        records.replay(|_record| {
            count += 1;
            Ok(())
        }).unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn test_restoring_flag() {
        let p = InMemoryAgentRecordPersistence::new();
        let mut records = AgentRecords::new(Box::new(p));

        assert!(!records.is_restoring());
        records.set_restoring(true);
        assert!(records.is_restoring());
        records.set_restoring(false);
        assert!(!records.is_restoring());
    }

    #[test]
    fn test_blob_store() {
        let dir = tempfile::tempdir().unwrap();
        let store = BlobStore::new(dir.path().to_str().unwrap());

        store.store("test-key", b"hello world").unwrap();
        let data = store.read("test-key").unwrap();
        assert_eq!(data, b"hello world");

        store.delete("test-key").unwrap();
        assert!(store.read("test-key").is_err());
    }

    #[test]
    fn test_blob_store_sanitizes_key() {
        let dir = tempfile::tempdir().unwrap();
        let store = BlobStore::new(dir.path().to_str().unwrap());

        store.store("path/to/blob", b"data").unwrap();
        let data = store.read("path/to/blob").unwrap();
        assert_eq!(data, b"data");
    }

    #[test]
    fn test_agent_record_serialization() {
        let record = AgentRecord::Metadata { version: 1 };
        let json = serde_json::to_value(&record).unwrap();
        assert_eq!(json["type"], "metadata");
        assert_eq!(json["version"], 1);
    }

    #[test]
    fn test_goal_create_record() {
        let record = AgentRecord::GoalCreate {
            goal_id: "g1".into(),
            objective: "test".into(),
            completion_criterion: None,
        };
        let json = serde_json::to_value(&record).unwrap();
        assert_eq!(json["type"], "goal_create");
        assert_eq!(json["goal_id"], "g1");
    }

    #[test]
    fn test_usage_record() {
        let record = AgentRecord::UsageRecord {
            model: "gpt-4".into(),
            usage: crate::rpc::types::TokenUsage {
                input_tokens: 10,
                output_tokens: 5,
                total_tokens: 15,
            },
            usage_scope: "session".into(),
        };
        let json = serde_json::to_value(&record).unwrap();
        assert_eq!(json["type"], "usage_record");
        assert_eq!(json["model"], "gpt-4");
    }

    #[test]
    fn test_replay_calls_handler_for_each_record() {
        let p = InMemoryAgentRecordPersistence::new();
        p.append(&AgentRecord::Metadata { version: 1 }).unwrap();
        p.append(&AgentRecord::PlanModeEnter { id: None }).unwrap();

        let records = AgentRecords::new(Box::new(p));
        let mut types = Vec::new();
        records.replay(|r| {
            match r {
                AgentRecord::Metadata { .. } => types.push("metadata"),
                AgentRecord::PlanModeEnter { .. } => types.push("plan_mode_enter"),
                _ => types.push("other"),
            }
            Ok(())
        }).unwrap();
        assert_eq!(types, vec!["metadata", "plan_mode_enter"]);
    }
}