//! Goal queue persistence (TS `goal-queue-store.ts` parity, simplified).
//!
//! The queue lives at `<kimi-code-home>/goal-queues/<session-id>.json`
//! (the engine owns the real session dir, which the TUI can't see, so the
//! queue is keyed by session id under the shared home). Writes are atomic
//! (temp file + rename) so a crash mid-write can't corrupt the queue.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

/// One queued goal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpcomingGoal {
    pub id: String,
    pub objective: String,
    pub created_at: String,
    pub updated_at: String,
}

const QUEUE_VERSION: u32 = 1;
const MAX_OBJECTIVE_LEN: usize = 4000;

/// Monotonic id suffix so two appends in the same millisecond differ.
static ID_COUNTER: AtomicU64 = AtomicU64::new(0);

fn now_iso() -> String {
    // Seconds since epoch; ISO-8601-ish. Good enough for ordering.
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{millis}")
}

fn new_id() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let seq = ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{millis:x}-{seq}")
}

/// `~/.kimi-code` (or `$KIMI_CODE_HOME`), like the TUI config path.
fn kimi_code_home() -> Option<PathBuf> {
    if let Ok(home) = std::env::var("KIMI_CODE_HOME") {
        if !home.trim().is_empty() {
            return Some(PathBuf::from(home));
        }
    }
    let base = if cfg!(windows) {
        std::env::var("USERPROFILE").ok()
    } else {
        std::env::var("HOME").ok()
    }?;
    Some(PathBuf::from(base).join(".kimi-code"))
}

/// The queue file path for a session, or `None` when home is unavailable.
pub fn queue_path(session_id: &str) -> Option<PathBuf> {
    kimi_code_home().map(|home| home.join("goal-queues").join(format!("{session_id}.json")))
}

/// Read the queue (missing file → empty queue).
pub fn read_queue(session_id: &str) -> anyhow::Result<Vec<UpcomingGoal>> {
    let Some(path) = queue_path(session_id) else {
        anyhow::bail!("cannot locate kimi-code home");
    };
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let value: serde_json::Value = serde_json::from_str(&text)?;
    if value.get("version").and_then(|v| v.as_u64()) != Some(QUEUE_VERSION as u64) {
        anyhow::bail!("unsupported goal queue version in {}", path.display());
    }
    let goals = value
        .get("goals")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    goals
        .iter()
        .map(|g| {
            Ok(UpcomingGoal {
                id: g["id"].as_str().unwrap_or("").to_string(),
                objective: g["objective"].as_str().unwrap_or("").to_string(),
                created_at: g["createdAt"].as_str().unwrap_or("").to_string(),
                updated_at: g["updatedAt"].as_str().unwrap_or("").to_string(),
            })
        })
        .collect()
}

/// Persist the queue (atomic: temp file + rename).
fn write_queue(session_id: &str, goals: &[UpcomingGoal]) -> anyhow::Result<()> {
    let Some(path) = queue_path(session_id) else {
        anyhow::bail!("cannot locate kimi-code home");
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let goals_json: Vec<serde_json::Value> = goals
        .iter()
        .map(|g| {
            serde_json::json!({
                "id": g.id,
                "objective": g.objective,
                "createdAt": g.created_at,
                "updatedAt": g.updated_at,
            })
        })
        .collect();
    let doc = serde_json::json!({ "version": QUEUE_VERSION, "goals": goals_json });
    let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
    std::fs::write(&tmp, serde_json::to_string_pretty(&doc)?)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

/// Normalise + validate an objective (TS `normalizeObjective` parity).
pub fn normalize_objective(objective: &str) -> anyhow::Result<String> {
    let objective = objective.trim().to_string();
    if objective.is_empty() {
        anyhow::bail!("goal objective cannot be empty");
    }
    if objective.chars().count() > MAX_OBJECTIVE_LEN {
        anyhow::bail!("goal objective too long (max {MAX_OBJECTIVE_LEN} chars)");
    }
    Ok(objective)
}

/// Append a goal to the queue; returns the queued goal.
pub fn append_goal(session_id: &str, objective: &str) -> anyhow::Result<UpcomingGoal> {
    let objective = normalize_objective(objective)?;
    let mut goals = read_queue(session_id)?;
    let now = now_iso();
    let goal = UpcomingGoal {
        id: new_id(),
        objective,
        created_at: now.clone(),
        updated_at: now,
    };
    goals.push(goal.clone());
    write_queue(session_id, &goals)?;
    Ok(goal)
}

/// Remove a goal by id; returns whether it was found.
pub fn remove_goal(session_id: &str, id: &str) -> anyhow::Result<bool> {
    let mut goals = read_queue(session_id)?;
    let before = goals.len();
    goals.retain(|g| g.id != id);
    if goals.len() == before {
        return Ok(false);
    }
    write_queue(session_id, &goals)?;
    Ok(true)
}

/// Move a goal up (`up = true`) or down in the queue; returns whether it
/// moved.
pub fn move_goal(session_id: &str, id: &str, up: bool) -> anyhow::Result<bool> {
    let mut goals = read_queue(session_id)?;
    let Some(index) = goals.iter().position(|g| g.id == id) else {
        return Ok(false);
    };
    let target = if up { index.wrapping_sub(1) } else { index + 1 };
    if target >= goals.len() || (up && index == 0) {
        return Ok(false);
    }
    goals.swap(index, target);
    write_queue(session_id, &goals)?;
    Ok(true)
}

/// Take the front goal off the queue (for `/goal next promote`).
pub fn promote_top(session_id: &str) -> anyhow::Result<Option<UpcomingGoal>> {
    let mut goals = read_queue(session_id)?;
    if goals.is_empty() {
        return Ok(None);
    }
    let goal = goals.remove(0);
    write_queue(session_id, &goals)?;
    Ok(Some(goal))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A unique session id per test so parallel tests don't collide.
    fn test_session() -> String {
        format!("test-{}", new_id())
    }

    fn cleanup(session_id: &str) {
        // Remove only this test's file — the directory is shared by
        // parallel tests, so a dir-level wipe would break them.
        if let Some(path) = queue_path(session_id) {
            let _ = std::fs::remove_file(&path);
            let _ =
                std::fs::remove_file(path.with_extension(format!("{}.tmp", std::process::id())));
        }
    }

    #[test]
    fn append_read_remove_roundtrip() {
        let session = test_session();
        let first = append_goal(&session, "task one").unwrap();
        let second = append_goal(&session, "task two").unwrap();
        let goals = read_queue(&session).unwrap();
        assert_eq!(goals.len(), 2);
        assert_eq!(goals[0].objective, "task one");
        assert_eq!(goals[1].objective, "task two");

        // Remove the second; the first survives.
        assert!(remove_goal(&session, &second.id).unwrap());
        let goals = read_queue(&session).unwrap();
        assert_eq!(goals.len(), 1);
        assert_eq!(goals[0].id, first.id);
        cleanup(&session);
    }

    #[test]
    fn objective_validation() {
        assert!(normalize_objective("  ").is_err(), "empty rejected");
        assert!(normalize_objective(&"x".repeat(4001)).is_err(), "too long");
        assert_eq!(normalize_objective("  hi  ").unwrap(), "hi");
    }

    #[test]
    fn move_and_promote() {
        let session = test_session();
        let a = append_goal(&session, "a").unwrap();
        let b = append_goal(&session, "b").unwrap();
        // Move b up → [b, a].
        assert!(move_goal(&session, &b.id, true).unwrap());
        let goals = read_queue(&session).unwrap();
        assert_eq!(goals[0].id, b.id);
        // Promote → b is returned and removed.
        let top = promote_top(&session).unwrap().unwrap();
        assert_eq!(top.id, b.id);
        let goals = read_queue(&session).unwrap();
        assert_eq!(goals.len(), 1);
        assert_eq!(goals[0].id, a.id);
        cleanup(&session);
    }

    #[test]
    fn missing_file_reads_empty() {
        let session = test_session();
        assert!(read_queue(&session).unwrap().is_empty());
        cleanup(&session);
    }
}
