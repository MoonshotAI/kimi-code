//! Knowledge Base — SQLite + FTS5 local coding standards database.
//!
//! Provides napi-exported functions for the TS layer to call directly
//! (no subprocess spawn needed). The database uses WAL mode and FTS5
//! for full-text search across entries.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

static DB: once_cell::sync::Lazy<Mutex<Option<Connection>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(None));

// ─── Schema ─────────────────────────────────────────────────────────────────

const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS entries (
    id          TEXT PRIMARY KEY,
    category    TEXT NOT NULL CHECK(category IN ('coding-style','pitfall','architecture','workflow')),
    title       TEXT NOT NULL,
    content     TEXT NOT NULL,
    tags        TEXT NOT NULL DEFAULT '',
    scope       TEXT DEFAULT NULL,
    confidence  REAL NOT NULL DEFAULT 1.0,
    source      TEXT NOT NULL CHECK(source IN ('human','ai-learned','ai-confirmed')),
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
    title, content, tags, content='entries', content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
    INSERT INTO entries_fts(rowid, title, content, tags) VALUES (new.rowid, new.title, new.content, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, title, content, tags) VALUES('delete', old.rowid, old.title, old.content, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, title, content, tags) VALUES('delete', old.rowid, old.title, old.content, old.tags);
    INSERT INTO entries_fts(rowid, title, content, tags) VALUES (new.rowid, new.title, new.content, new.tags);
END;
CREATE INDEX IF NOT EXISTS idx_entries_category ON entries(category);
CREATE INDEX IF NOT EXISTS idx_entries_scope ON entries(scope);
CREATE INDEX IF NOT EXISTS idx_entries_confidence ON entries(confidence);
"#;

// ─── Models ─────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
struct KnowledgeEntry {
    id: String,
    category: String,
    title: String,
    content: String,
    tags: Vec<String>,
    scope: Option<String>,
    confidence: f64,
    source: String,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize)]
struct SearchResult {
    entry: KnowledgeEntry,
    relevance: f64,
    match_source: Vec<String>,
}

#[derive(Debug, Serialize)]
struct Stats {
    total: usize,
    by_category: HashMap<String, usize>,
    by_source: HashMap<String, usize>,
    avg_confidence: f64,
}

// ─── Helpers ────────────────────────────────────────────────────────────────

fn with_db<F, R>(f: F) -> Result<R>
where
    F: FnOnce(&Connection) -> std::result::Result<R, String>,
{
    let guard = DB.lock().map_err(|e| Error::from_reason(format!("DB lock: {e}")))?;
    let conn = guard.as_ref().ok_or_else(|| Error::from_reason("Knowledge DB not opened. Call knowledge_open first."))?;
    f(conn).map_err(|e| Error::from_reason(e))
}

fn generate_id() -> String {
    ulid::Ulid::new().to_string()
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn row_to_entry(row: &rusqlite::Row) -> rusqlite::Result<KnowledgeEntry> {
    let tags_str: String = row.get(4)?;
    Ok(KnowledgeEntry {
        id: row.get(0)?,
        category: row.get(1)?,
        title: row.get(2)?,
        content: row.get(3)?,
        tags: if tags_str.is_empty() { vec![] } else { tags_str.split(',').map(|s| s.trim().to_string()).collect() },
        scope: row.get(5)?,
        confidence: row.get(6)?,
        source: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

// ─── NAPI Exports ───────────────────────────────────────────────────────────

#[napi]
pub fn knowledge_open(db_path: String) -> Result<()> {
    let mut guard = DB.lock().map_err(|e| Error::from_reason(format!("DB lock: {e}")))?;
    if guard.is_some() {
        // Already open — reopen at new path
    }
    std::fs::create_dir_all(std::path::Path::new(&db_path).parent().unwrap_or(std::path::Path::new("."))).ok();
    let conn = Connection::open(&db_path).map_err(|e| Error::from_reason(format!("Open DB: {e}")))?;
    conn.execute_batch("PRAGMA journal_mode = WAL;").map_err(|e| Error::from_reason(format!("{e}")))?;
    // Check if schema exists
    let has_table: bool = conn
        .prepare("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='entries'")
        .and_then(|mut s| s.query_row([], |r| r.get::<_, i64>(0)))
        .map(|c| c > 0)
        .unwrap_or(false);
    if !has_table {
        conn.execute_batch(SCHEMA_SQL).map_err(|e| Error::from_reason(format!("Schema: {e}")))?;
    }
    *guard = Some(conn);
    Ok(())
}

#[napi]
pub fn knowledge_add(
    title: String,
    category: String,
    content: String,
    tags: String,
    scope: Option<String>,
    source: String,
    confidence: f64,
) -> Result<String> {
    with_db(|conn| {
        let id = generate_id();
        let now = now_iso();
        let scope = scope.filter(|s| !s.is_empty());
        conn.execute(
            "INSERT INTO entries (id, category, title, content, tags, scope, confidence, source, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![id, category, title, content, tags, scope, confidence, source, now, now],
        ).map_err(|e| format!("Insert: {e}"))?;

        let entry = KnowledgeEntry { id: id.clone(), category, title, content, tags: tags.split(',').filter(|s| !s.is_empty()).map(|s| s.trim().to_string()).collect(), scope, confidence, source, created_at: now.clone(), updated_at: now };
        serde_json::to_string(&entry).map_err(|e| format!("JSON: {e}"))
    })
}

#[napi]
pub fn knowledge_search(
    query: String,
    scope_path: Option<String>,
    tags: Option<String>,
    limit: u32,
    min_confidence: f64,
) -> Result<String> {
    with_db(|conn| {
        let mut results_map: HashMap<String, (KnowledgeEntry, f64, Vec<String>)> = HashMap::new();

        // 1. Scope match
        if let Some(ref path) = scope_path {
            let mut stmt = conn.prepare(
                "SELECT id,category,title,content,tags,scope,confidence,source,created_at,updated_at FROM entries WHERE confidence >= ?1 AND (scope IS NULL OR substr(?2, 1, length(scope)) = scope) ORDER BY confidence DESC LIMIT 20"
            ).map_err(|e| format!("{e}"))?;
            let rows = stmt.query_map(params![min_confidence, path], |r| row_to_entry(r)).map_err(|e| format!("{e}"))?;
            for row in rows.flatten() {
                let score = if row.scope.is_some() { 3.0 } else { 1.0 };
                let id = row.id.clone();
                let e = results_map.entry(id).or_insert_with(|| (row, 0.0, vec![]));
                e.1 += score;
                e.2.push("scope".to_string());
            }
        }

        // 2. FTS5
        if !query.is_empty() && query != "*" {
            let fts_query = if query.contains('"') {
                query.clone()
            } else {
                query.split_whitespace().map(|w| format!("\"{}\"", w.replace('"', "\"\""))).collect::<Vec<_>>().join(" OR ")
            };
            let sql = "SELECT e.id,e.category,e.title,e.content,e.tags,e.scope,e.confidence,e.source,e.created_at,e.updated_at,rank FROM entries_fts f JOIN entries e ON e.rowid=f.rowid WHERE entries_fts MATCH ?1 AND e.confidence >= ?2 ORDER BY rank LIMIT 20";
            if let Ok(mut stmt) = conn.prepare(sql) {
                if let Ok(rows) = stmt.query_map(params![fts_query, min_confidence], |r| {
                    let entry = row_to_entry(r)?;
                    let rank: f64 = r.get(10)?;
                    Ok((entry, rank))
                }) {
                    for row in rows.flatten() {
                        let (entry, rank) = row;
                        let score = 2.0 * (1.0 / (1.0 + rank.abs()));
                        let id = entry.id.clone();
                        let e = results_map.entry(id).or_insert_with(|| (entry, 0.0, vec![]));
                        e.1 += score;
                        e.2.push("fts".to_string());
                    }
                }
            }
        }

        // 3. Tag overlap
        if let Some(ref tag_str) = tags {
            let query_tags: HashSet<&str> = tag_str.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
            if !query_tags.is_empty() {
                let mut stmt = conn.prepare("SELECT id,category,title,content,tags,scope,confidence,source,created_at,updated_at FROM entries WHERE confidence >= ?1 AND tags != ''").map_err(|e| format!("{e}"))?;
                let rows = stmt.query_map(params![min_confidence], |r| row_to_entry(r)).map_err(|e| format!("{e}"))?;
                for row in rows.flatten() {
                    let entry_tags: HashSet<&str> = row.tags.iter().map(|s| s.as_str()).collect();
                    let overlap = query_tags.intersection(&entry_tags).count();
                    if overlap > 0 {
                        let id = row.id.clone();
                        let e = results_map.entry(id).or_insert_with(|| (row, 0.0, vec![]));
                        e.1 += overlap as f64;
                        e.2.push("tag".to_string());
                    }
                }
            }
        }

        // Sort and truncate
        let mut results: Vec<SearchResult> = results_map.into_values().map(|(entry, score, sources)| {
            let relevance = score * entry.confidence;
            let unique: Vec<String> = sources.into_iter().collect::<HashSet<_>>().into_iter().collect();
            SearchResult { entry, relevance, match_source: unique }
        }).collect();
        results.sort_by(|a, b| b.relevance.partial_cmp(&a.relevance).unwrap_or(std::cmp::Ordering::Equal));
        results.truncate(limit as usize);

        serde_json::to_string(&results).map_err(|e| format!("JSON: {e}"))
    })
}

#[napi]
pub fn knowledge_remove(id: String) -> Result<bool> {
    with_db(|conn| {
        let affected = conn.execute("DELETE FROM entries WHERE id = ?1", params![id]).map_err(|e| format!("{e}"))?;
        Ok(affected > 0)
    })
}

#[napi]
pub fn knowledge_confirm(id: String) -> Result<bool> {
    with_db(|conn| {
        let now = now_iso();
        let affected = conn.execute(
            "UPDATE entries SET confidence = 1.0, source = 'ai-confirmed', updated_at = ?1 WHERE id = ?2",
            params![now, id],
        ).map_err(|e| format!("{e}"))?;
        Ok(affected > 0)
    })
}

#[napi]
pub fn knowledge_stats() -> Result<String> {
    with_db(|conn| {
        let total: usize = conn.query_row("SELECT count(*) FROM entries", [], |r| r.get(0)).map_err(|e| format!("{e}"))?;
        let mut by_category = HashMap::new();
        let mut stmt = conn.prepare("SELECT category, count(*) FROM entries GROUP BY category").map_err(|e| format!("{e}"))?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_,String>(0)?, r.get::<_,usize>(1)?))).map_err(|e| format!("{e}"))?;
        for row in rows.flatten() { by_category.insert(row.0, row.1); }

        let mut by_source = HashMap::new();
        let mut stmt = conn.prepare("SELECT source, count(*) FROM entries GROUP BY source").map_err(|e| format!("{e}"))?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_,String>(0)?, r.get::<_,usize>(1)?))).map_err(|e| format!("{e}"))?;
        for row in rows.flatten() { by_source.insert(row.0, row.1); }

        let avg_confidence: f64 = conn.query_row("SELECT COALESCE(avg(confidence),0) FROM entries", [], |r| r.get(0)).map_err(|e| format!("{e}"))?;

        let stats = Stats { total, by_category, by_source, avg_confidence };
        serde_json::to_string(&stats).map_err(|e| format!("JSON: {e}"))
    })
}

#[napi]
pub fn knowledge_import(markdown: String) -> Result<String> {
    with_db(|conn| {
        let content = markdown.replace("\r\n", "\n");
        let blocks: Vec<&str> = content.split("\n---\n").collect();
        let mut entries = Vec::new();

        for block in blocks {
            let block = block.trim();
            if block.is_empty() { continue; }
            let lines: Vec<&str> = block.lines().collect();
            if lines.is_empty() { continue; }

            let header = lines[0].trim_start_matches('#').trim();
            let (cat_str, title) = match header.split_once(':') {
                Some((c, t)) => (c.trim(), t.trim()),
                None => continue,
            };

            let mut tags = String::new();
            let mut scope: Option<String> = None;
            let mut content_start = 1;

            for (i, line) in lines.iter().enumerate().skip(1) {
                if let Some(t) = line.strip_prefix("tags:") {
                    tags = t.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(",");
                    content_start = i + 1;
                } else if let Some(s) = line.strip_prefix("scope:") {
                    let s = s.trim();
                    if !s.is_empty() { scope = Some(s.to_string()); }
                    content_start = i + 1;
                } else if line.is_empty() {
                    content_start = i + 1;
                    break;
                } else {
                    break;
                }
            }

            let entry_content = lines[content_start..].join("\n").trim().replace("\n\\---\n", "\n---\n");
            if entry_content.is_empty() { continue; }

            let id = generate_id();
            let now = now_iso();
            if conn.execute(
                "INSERT INTO entries (id,category,title,content,tags,scope,confidence,source,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,1.0,'human',?7,?8)",
                params![id, cat_str, title, entry_content, tags, scope, now, now],
            ).is_ok() {
                entries.push(KnowledgeEntry { id, category: cat_str.to_string(), title: title.to_string(), content: entry_content, tags: if tags.is_empty() { vec![] } else { tags.split(',').map(|s| s.to_string()).collect() }, scope, confidence: 1.0, source: "human".to_string(), created_at: now.clone(), updated_at: now });
            }
        }

        serde_json::to_string(&entries).map_err(|e| format!("JSON: {e}"))
    })
}
