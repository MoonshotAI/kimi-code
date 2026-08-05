//! Plugin store — CRUD operations for plugin records backed by SQLite.
//!
//! Mirrors `packages/agent-core/src/plugin/store.ts`.

use anyhow::{Context, Result};
use crate::persistence::store::SqliteStore;
use crate::plugin::types::*;

/// Plugin store — manages plugin records in SQLite.
pub struct PluginStore {
    store: SqliteStore,
}

impl PluginStore {
    /// Create a new plugin store backed by the given SQLite store.
    pub fn new(store: SqliteStore) -> Self {
        Self { store }
    }

    /// Initialize the plugin table.
    pub fn init(&self) -> Result<()> {
        self.store.with_conn(|c| {
            c.execute_batch(
                "CREATE TABLE IF NOT EXISTS plugins (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    version TEXT NOT NULL,
                    description TEXT NOT NULL,
                    source TEXT NOT NULL,
                    source_detail TEXT NOT NULL,
                    state TEXT NOT NULL DEFAULT 'enabled',
                    installed_at TEXT NOT NULL,
                    skills TEXT NOT NULL DEFAULT '[]',
                    mcp_servers TEXT NOT NULL DEFAULT '[]',
                    hooks TEXT NOT NULL DEFAULT '[]',
                    system_prompt TEXT DEFAULT NULL,
                    agents TEXT NOT NULL DEFAULT '[]',
                    commands TEXT NOT NULL DEFAULT '[]'
                )"
            ).context("create plugins table")?;
            // Migrate pre-existing tables that predate the system-prompt and
            // agents columns (upstream #2314 / #2365); the ALTER is a no-op
            // when the column already exists.
            let _ = c.execute_batch(
                "ALTER TABLE plugins ADD COLUMN system_prompt TEXT DEFAULT NULL;
                 ALTER TABLE plugins ADD COLUMN agents TEXT NOT NULL DEFAULT '[]';
                 ALTER TABLE plugins ADD COLUMN commands TEXT NOT NULL DEFAULT '[]';"
            );
            Ok(())
        })
    }

    /// List all plugins.
    pub fn list(&self) -> Result<Vec<PluginRecord>> {
        self.store.with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT id, name, version, description, source, source_detail, state, installed_at, skills, mcp_servers, hooks, system_prompt, agents, commands FROM plugins ORDER BY id"
            ).context("prepare list plugins")?;
            let rows = stmt.query_map([], |row| {
                let source_str: String = row.get(4)?;
                let source_detail: String = row.get(5)?;
                let source = parse_source(&source_str, &source_detail);
                let skills_str: String = row.get(8)?;
                let mcp_str: String = row.get(9)?;
                let hooks_str: String = row.get(10)?;
                let system_prompt: Option<String> = row.get(11)?;
                let agents_str: String = row.get(12)?;
                let commands_str: String = row.get(13)?;
                Ok(PluginRecord {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    version: row.get(2)?,
                    description: row.get(3)?,
                    source,
                    state: match row.get::<_, String>(6)?.as_str() {
                        "disabled" => PluginState::Disabled,
                        _ => PluginState::Enabled,
                    },
                    installed_at: row.get(7)?,
                    skills: serde_json::from_str(&skills_str).unwrap_or_default(),
                    mcp_servers: serde_json::from_str(&mcp_str).unwrap_or_default(),
                    hooks: serde_json::from_str(&hooks_str).unwrap_or_default(),
                    system_prompt,
                    agents: serde_json::from_str(&agents_str).unwrap_or_default(),
                    commands: serde_json::from_str(&commands_str).unwrap_or_default(),
                })
            }).context("query plugins")?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| anyhow::anyhow!("collect plugin rows: {e}"))
        })
    }

    /// Get a plugin by ID.
    pub fn get(&self, id: &str) -> Result<Option<PluginRecord>> {
        self.store.with_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT id, name, version, description, source, source_detail, state, installed_at, skills, mcp_servers, hooks, system_prompt, agents, commands FROM plugins WHERE id = ?1"
            ).context("prepare get plugin")?;
            let mut rows = stmt.query_map(rusqlite::params![id], |row| {
                let source_str: String = row.get(4)?;
                let source_detail: String = row.get(5)?;
                let source = parse_source(&source_str, &source_detail);
                let skills_str: String = row.get(8)?;
                let mcp_str: String = row.get(9)?;
                let hooks_str: String = row.get(10)?;
                let system_prompt: Option<String> = row.get(11)?;
                let agents_str: String = row.get(12)?;
                let commands_str: String = row.get(13)?;
                Ok(PluginRecord {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    version: row.get(2)?,
                    description: row.get(3)?,
                    source,
                    state: match row.get::<_, String>(6)?.as_str() {
                        "disabled" => PluginState::Disabled,
                        _ => PluginState::Enabled,
                    },
                    installed_at: row.get(7)?,
                    skills: serde_json::from_str(&skills_str).unwrap_or_default(),
                    mcp_servers: serde_json::from_str(&mcp_str).unwrap_or_default(),
                    hooks: serde_json::from_str(&hooks_str).unwrap_or_default(),
                    system_prompt,
                    agents: serde_json::from_str(&agents_str).unwrap_or_default(),
                    commands: serde_json::from_str(&commands_str).unwrap_or_default(),
                })
            }).context("query plugin by id")?;
            rows.next().transpose().map_err(|e| anyhow::anyhow!("get plugin row: {e}"))
        })
    }

    /// Insert or update a plugin record.
    pub fn upsert(&self, record: &PluginRecord) -> Result<()> {
        let source_str = match &record.source {
            PluginSource::Github { .. } => "github",
            PluginSource::Local { .. } => "local",
            PluginSource::Url { .. } => "url",
        };
        let source_detail = match &record.source {
            PluginSource::Github { repo, tag } =>
                format!("{}{}", repo, tag.as_ref().map(|t| format!("@{t}")).unwrap_or_default()),
            PluginSource::Local { path } => path.clone(),
            PluginSource::Url { url } => url.clone(),
        };
        let state_str = match record.state {
            PluginState::Enabled => "enabled",
            PluginState::Disabled => "disabled",
        };
        let skills_json = serde_json::to_string(&record.skills).context("serialize skills")?;
        let mcp_json = serde_json::to_string(&record.mcp_servers).context("serialize mcp_servers")?;
        let hooks_json = serde_json::to_string(&record.hooks).context("serialize hooks")?;
        let agents_json = serde_json::to_string(&record.agents).context("serialize agents")?;
        let commands_json = serde_json::to_string(&record.commands).context("serialize commands")?;

        let skills_json2 = skills_json.clone();
        let mcp_json2 = mcp_json.clone();
        let hooks_json2 = hooks_json.clone();
        let agents_json2 = agents_json.clone();
        let commands_json2 = commands_json.clone();

        self.store.with_conn(|c| {
            c.execute(
                "INSERT OR REPLACE INTO plugins (id, name, version, description, source, source_detail, state, installed_at, skills, mcp_servers, hooks, system_prompt, agents, commands)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                rusqlite::params![
                    record.id, record.name, record.version, record.description,
                    source_str, source_detail, state_str, record.installed_at,
                    skills_json2, mcp_json2, hooks_json2,
                    record.system_prompt, agents_json2, commands_json2
                ],
            ).context("upsert plugin")?;
            Ok(())
        })
    }

    /// Delete a plugin by ID.
    pub fn delete(&self, id: &str) -> Result<()> {
        self.store.with_conn(|c| {
            c.execute("DELETE FROM plugins WHERE id = ?1", rusqlite::params![id])
                .context("delete plugin")?;
            Ok(())
        })
    }

    /// Set the state of a plugin.
    pub fn set_state(&self, id: &str, state: PluginState) -> Result<()> {
        let state_str = match state {
            PluginState::Enabled => "enabled",
            PluginState::Disabled => "disabled",
        };
        self.store.with_conn(|c| {
            c.execute(
                "UPDATE plugins SET state = ?1 WHERE id = ?2",
                rusqlite::params![state_str, id],
            ).context("set plugin state")?;
            Ok(())
        })
    }

    /// List all enabled plugins.
    pub fn list_enabled(&self) -> Result<Vec<PluginRecord>> {
        self.list().map(|plugins| {
            plugins.into_iter().filter(|p| p.is_enabled()).collect()
        })
    }
}

fn parse_source(source: &str, detail: &str) -> PluginSource {
    match source {
        "github" => {
            if let Some(at) = detail.find('@') {
                PluginSource::Github {
                    repo: detail[..at].to_string(),
                    tag: Some(detail[at + 1..].to_string()),
                }
            } else {
                PluginSource::Github {
                    repo: detail.to_string(),
                    tag: None,
                }
            }
        }
        "local" => PluginSource::Local { path: detail.to_string() },
        "url" => PluginSource::Url { url: detail.to_string() },
        _ => PluginSource::Local { path: detail.to_string() },
    }
}