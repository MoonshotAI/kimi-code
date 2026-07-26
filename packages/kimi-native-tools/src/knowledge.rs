//! Knowledge Base — SQLite + FTS5 local coding standards database.
//!
//! Provides napi-exported functions for the TS layer to call directly
//! (no subprocess spawn needed). The database uses WAL mode and FTS5
//! for full-text search across entries.
//!
//! Each entry has a `status` field:
//!   - 'pending'   : AI-learned, not yet confirmed (excluded from search)
//!   - 'confirmed' : Human-added or AI-confirmed (included in search)
//!   - 'rejected'  : Soft-deleted / rejected AI-learned (excluded from search)

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

// DB connections keyed by db_path, so multiple projects can coexist.
static DB: once_cell::sync::Lazy<Mutex<HashMap<String, Connection>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(HashMap::new()));

// Track the most-recently-opened DB path so that functions without an
// explicit path argument can resolve to the "active" connection.
static ACTIVE_PATH: once_cell::sync::Lazy<Mutex<Option<String>>> =
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
    status      TEXT NOT NULL DEFAULT 'confirmed' CHECK(status IN ('pending','confirmed','rejected')),
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
CREATE INDEX IF NOT EXISTS idx_entries_status ON entries(status);
CREATE INDEX IF NOT EXISTS idx_entries_source ON entries(source);
-- M7: index on tags to speed up tag-overlap search (LIKE prefix matches can use this)
CREATE INDEX IF NOT EXISTS idx_entries_tags ON entries(tags);
"#;

// Migration: add `status` column if missing (for databases created before this field).
const MIGRATION_ADD_STATUS: &str = r#"
ALTER TABLE entries ADD COLUMN status TEXT NOT NULL DEFAULT 'confirmed' CHECK(status IN ('pending','confirmed','rejected'));
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
    status: String,
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
    by_status: HashMap<String, usize>,
    avg_confidence: f64,
}

// ─── Helpers ────────────────────────────────────────────────────────────────

fn with_db<F, R>(f: F) -> Result<R>
where
    F: FnOnce(&Connection) -> std::result::Result<R, String>,
{
    let guard = DB.lock().map_err(|e| Error::from_reason(format!("DB lock: {e}")))?;
    let path = ACTIVE_PATH.lock().map_err(|e| Error::from_reason(format!("ActivePath lock: {e}")))?;
    let path = path.as_ref().ok_or_else(|| Error::from_reason("Knowledge DB not opened. Call knowledge_open first."))?;
    let conn = guard.get(path).ok_or_else(|| Error::from_reason("Knowledge DB connection not found. Call knowledge_open first."))?;
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
    // status column may not exist in older DBs; fall back to 'confirmed'.
    let status: String = row.get(10).unwrap_or_else(|_| "confirmed".to_string());
    Ok(KnowledgeEntry {
        id: row.get(0)?,
        category: row.get(1)?,
        title: row.get(2)?,
        content: row.get(3)?,
        tags: if tags_str.is_empty() { vec![] } else { tags_str.split(',').map(|s| s.trim().to_string()).collect() },
        scope: row.get(5)?,
        confidence: row.get(6)?,
        source: row.get(7)?,
        status,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

/// Sanitize a single word for safe use as an FTS5 phrase term.
/// Strips all FTS5-special characters and wraps in double quotes with
/// internal quotes doubled.
fn sanitize_fts_term(word: &str) -> String {
    let cleaned: String = word.chars()
        .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    if cleaned.is_empty() {
        String::new()
    } else {
        format!("\"{}\"", cleaned.replace('"', "\"\""))
    }
}

/// Build a safe FTS5 OR-query from a free-text string.
fn build_fts_query(query: &str) -> String {
    // If the caller pre-quoted the entire query, sanitize each token anyway.
    let terms: Vec<String> = query
        .split_whitespace()
        .map(sanitize_fts_term)
        .filter(|s| !s.is_empty())
        .collect();
    terms.join(" OR ")
}

/// Validate confidence is within [0.0, 1.0].
fn validate_confidence(c: f64) -> Result<()> {
    if !(0.0..=1.0).contains(&c) {
        return Err(Error::from_reason(format!("confidence must be in [0.0, 1.0], got {c}")));
    }
    Ok(())
}

/// Validate that a string field is not empty and not too long.
fn validate_field(name: &str, value: &str, max_len: usize) -> Result<()> {
    if value.is_empty() {
        return Err(Error::from_reason(format!("{name} must not be empty")));
    }
    if value.len() > max_len {
        return Err(Error::from_reason(format!("{name} exceeds max length {max_len}")));
    }
    Ok(())
}

/// Check for duplicate entries (same category + same first 30 chars of title + same source).
/// Returns true if a duplicate exists.
/// Note: title prefix is sliced by Unicode chars (not bytes) to avoid panicking
/// on multi-byte characters (e.g. CJK titles). SQL `substr(title, 1, 30)`
/// also counts by characters, keeping both sides consistent.
fn is_duplicate(conn: &Connection, category: &str, title: &str, source: &str) -> bool {
    let prefix: String = title.chars().take(30).collect();
    conn.query_row(
        "SELECT count(*) FROM entries WHERE category = ?1 AND substr(title, 1, 30) = ?2 AND source = ?3",
        params![category, prefix, source],
        |r| r.get::<_, i64>(0),
    ).unwrap_or(0) > 0
}

/// Check for duplicate entries across ALL sources (used by import to avoid
/// creating duplicates of AI-learned entries). Same category + same first
/// 30 chars of title, regardless of source.
fn is_duplicate_any_source(conn: &Connection, category: &str, title: &str) -> bool {
    let prefix: String = title.chars().take(30).collect();
    conn.query_row(
        "SELECT count(*) FROM entries WHERE category = ?1 AND substr(title, 1, 30) = ?2",
        params![category, prefix],
        |r| r.get::<_, i64>(0),
    ).unwrap_or(0) > 0
}

// ─── NAPI Exports ───────────────────────────────────────────────────────────

#[napi]
pub fn knowledge_open(db_path: String) -> Result<()> {
    // C2: Reject path traversal — db_path must not contain '..'
    let path = std::path::Path::new(&db_path);
    if path.components().any(|c| c.as_os_str() == "..") {
        return Err(Error::from_reason("db_path must not contain '..' (path traversal rejected)"));
    }

    let mut guard = DB.lock().map_err(|e| Error::from_reason(format!("DB lock: {e}")))?;

    // If this path is already open, just mark it active.
    if guard.contains_key(&db_path) {
        drop(guard);
        let mut ap = ACTIVE_PATH.lock().map_err(|e| Error::from_reason(format!("ActivePath lock: {e}")))?;
        *ap = Some(db_path);
        return Ok(());
    }

    std::fs::create_dir_all(path.parent().unwrap_or(std::path::Path::new("."))).ok();
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
    } else {
        // M12: Migration — surface errors instead of silently dropping them.
        let has_status: bool = conn
            .prepare("PRAGMA table_info(entries)")
            .and_then(|mut s| {
                let col_names: Vec<String> = s.query_map([], |r| r.get::<_, String>(1))?
                    .filter_map(|r| r.ok())
                    .collect();
                Ok(col_names.iter().any(|c| c == "status"))
            })
            .unwrap_or(false);
        if !has_status {
            conn.execute_batch(MIGRATION_ADD_STATUS)
                .map_err(|e| Error::from_reason(format!("Migration failed (add status column): {e}. Manual intervention required.")))?;
        }
    }

    guard.insert(db_path.clone(), conn);
    drop(guard);
    let mut ap = ACTIVE_PATH.lock().map_err(|e| Error::from_reason(format!("ActivePath lock: {e}")))?;
    *ap = Some(db_path);
    Ok(())
}

/// Close and remove a DB connection from the connection pool.
/// If db_path is None, closes the currently active DB.
/// M11: prevents file-handle leaks when switching between many projects.
#[napi]
pub fn knowledge_close(db_path: Option<String>) -> Result<()> {
    let mut guard = DB.lock().map_err(|e| Error::from_reason(format!("DB lock: {e}")))?;
    let target = match db_path {
        Some(p) => Some(p),
        None => {
            let ap = ACTIVE_PATH.lock().map_err(|e| Error::from_reason(format!("ActivePath lock: {e}")))?;
            ap.clone()
        }
    };
    if let Some(path) = target {
        guard.remove(&path);
        let mut ap = ACTIVE_PATH.lock().map_err(|e| Error::from_reason(format!("ActivePath lock: {e}")))?;
        if ap.as_ref() == Some(&path) {
            *ap = guard.keys().next().cloned();
        }
    }
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
    status: String,
) -> Result<String> {
    // Input validation
    validate_field("title", &title, 200)?;
    validate_field("content", &content, 32_000)?;
    validate_confidence(confidence)?;

    with_db(|conn| {
        // Dedup check: skip if an identical entry already exists.
        if is_duplicate(conn, &category, &title, &source) {
            return Err(format!("Duplicate knowledge entry: [{category}] {title}"));
        }

        let id = generate_id();
        let now = now_iso();
        let scope = scope.filter(|s| !s.is_empty());
        let status = if status.is_empty() { "confirmed".to_string() } else { status };
        conn.execute(
            "INSERT INTO entries (id, category, title, content, tags, scope, confidence, source, status, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![id, category, title, content, tags, scope, confidence, source, status, now, now],
        ).map_err(|e| format!("Insert: {e}"))?;

        let entry = KnowledgeEntry {
            id: id.clone(),
            category,
            title,
            content,
            tags: tags.split(',').filter(|s| !s.is_empty()).map(|s| s.trim().to_string()).collect(),
            scope,
            confidence,
            source,
            status,
            created_at: now.clone(),
            updated_at: now,
        };
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

        // Only confirmed entries participate in search.
        const STATUS_FILTER: &str = "AND status = 'confirmed'";

        // 1. Scope match — check path boundary to avoid /foo matching /foobar.
        // M5/M6: use explicit ESCAPE clause and match both '/' and '\' separators
        // (the previous "scope || '\\%'" relied on SQLite's default LIKE behavior
        // and didn't handle Windows backslash paths consistently).
        if let Some(ref path) = scope_path {
            let sql = format!(
                "SELECT id,category,title,content,tags,scope,confidence,source,created_at,updated_at,status FROM entries WHERE confidence >= ?1 {STATUS_FILTER} AND (scope IS NULL OR ?2 = scope OR ?2 LIKE scope || '/' || '%' ESCAPE '\\' OR ?2 LIKE scope || '\\' || '%' ESCAPE '\\') ORDER BY confidence DESC LIMIT 20"
            );
            let mut stmt = conn.prepare(&sql).map_err(|e| format!("{e}"))?;
            let rows = stmt.query_map(params![min_confidence, path], |r| row_to_entry(r)).map_err(|e| format!("{e}"))?;
            for row in rows.flatten() {
                let score = if row.scope.is_some() { 3.0 } else { 1.0 };
                let id = row.id.clone();
                let e = results_map.entry(id).or_insert_with(|| (row, 0.0, vec![]));
                e.1 += score;
                e.2.push("scope".to_string());
            }
        }

        // 2. FTS5 — safe query construction
        if !query.is_empty() && query != "*" {
            let fts_query = build_fts_query(&query);
            if !fts_query.is_empty() {
                let sql = format!(
                    "SELECT e.id,e.category,e.title,e.content,e.tags,e.scope,e.confidence,e.source,e.created_at,e.updated_at,e.status,rank FROM entries_fts f JOIN entries e ON e.rowid=f.rowid WHERE entries_fts MATCH ?1 AND e.confidence >= ?2 {STATUS_FILTER} ORDER BY rank LIMIT 20"
                );
                if let Ok(mut stmt) = conn.prepare(&sql) {
                    if let Ok(rows) = stmt.query_map(params![fts_query, min_confidence], |r| {
                        let entry = row_to_entry(r)?;
                        let rank: f64 = r.get(11)?;
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
        }

        // 3. Tag overlap — use SQL LIKE with each tag, indexed via idx_entries_tags
        // (M7: previously loaded ALL tagged rows into memory and computed set
        // intersection in Rust; now we let SQLite filter via LIKE on indexed
        // tags column and count overlaps per matched row.)
        if let Some(ref tag_str) = tags {
            let query_tags: Vec<String> = tag_str.split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            if !query_tags.is_empty() {
                // Build a parameterized OR-of-LIKEs clause: each tag matches if
                // tags column equals it, starts with it+',' , ends with ','+it,
                // or contains ','+it+','. This is exact-tag matching.
                let mut clauses: Vec<String> = Vec::new();
                for _ in &query_tags {
                    clauses.push("(tags = ? OR tags LIKE ? OR tags LIKE ? OR tags LIKE ?)".to_string());
                }
                let or_clause = clauses.join(" OR ");
                let sql = format!(
                    "SELECT id,category,title,content,tags,scope,confidence,source,created_at,updated_at,status FROM entries WHERE confidence >= ?1 {STATUS_FILTER} AND ({or_clause}) ORDER BY confidence DESC LIMIT 20"
                );
                let mut stmt = conn.prepare(&sql).map_err(|e| format!("{e}"))?;
                // Bind min_confidence first, then 4 params per tag
                let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
                params_vec.push(Box::new(min_confidence));
                for t in &query_tags {
                    params_vec.push(Box::new(t.clone()));                                   // tags = ?
                    params_vec.push(Box::new(format!("{t},%")));                           // LIKE 'tag,%'
                    params_vec.push(Box::new(format!("%,{t}")));                           // LIKE '%,tag'
                    params_vec.push(Box::new(format!("%,{t},%")));                         // LIKE '%,tag,%'
                }
                let param_refs: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|b| b.as_ref()).collect();
                let rows = stmt.query_map(param_refs.as_slice(), |r| row_to_entry(r)).map_err(|e| format!("{e}"))?;
                let query_tags_set: HashSet<&str> = query_tags.iter().map(|s| s.as_str()).collect();
                for row in rows.flatten() {
                    let entry_tags: HashSet<&str> = row.tags.iter().map(|s| s.as_str()).collect();
                    let overlap = query_tags_set.intersection(&entry_tags).count();
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
            "UPDATE entries SET confidence = 1.0, source = 'ai-confirmed', status = 'confirmed', updated_at = ?1 WHERE id = ?2",
            params![now, id],
        ).map_err(|e| format!("{e}"))?;
        Ok(affected > 0)
    })
}

#[napi]
pub fn knowledge_reject(id: String) -> Result<bool> {
    with_db(|conn| {
        let now = now_iso();
        // Soft-reject: mark status as 'rejected' rather than hard-delete.
        let affected = conn.execute(
            "UPDATE entries SET status = 'rejected', updated_at = ?1 WHERE id = ?2",
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

        let mut by_status = HashMap::new();
        let mut stmt = conn.prepare("SELECT status, count(*) FROM entries GROUP BY status").map_err(|e| format!("{e}"))?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_,String>(0)?, r.get::<_,usize>(1)?))).map_err(|e| format!("{e}"))?;
        for row in rows.flatten() { by_status.insert(row.0, row.1); }

        let avg_confidence: f64 = conn.query_row("SELECT COALESCE(avg(confidence),0) FROM entries", [], |r| r.get(0)).map_err(|e| format!("{e}"))?;

        let stats = Stats { total, by_category, by_source, by_status, avg_confidence };
        serde_json::to_string(&stats).map_err(|e| format!("JSON: {e}"))
    })
}

#[napi]
pub fn knowledge_import(markdown: String) -> Result<String> {
    // C3: Reject oversized imports to prevent OOM.
    const MAX_IMPORT_BYTES: usize = 10_000_000; // 10MB
    if markdown.len() > MAX_IMPORT_BYTES {
        return Err(Error::from_reason(format!(
            "markdown import exceeds {MAX_IMPORT_BYTES} byte limit (got {} bytes)",
            markdown.len()
        )));
    }

    // Valid categories — must match the CHECK constraint on the entries table.
    const VALID_CATEGORIES: &[&str] = &["coding-style", "pitfall", "architecture", "workflow"];

    with_db(|conn| {
        let content = markdown.replace("\r\n", "\n");
        let blocks: Vec<&str> = content.split("\n---\n").collect();
        let mut entries = Vec::new();
        let mut skipped: Vec<String> = Vec::new();

        for block in blocks {
            let block = block.trim();
            if block.is_empty() { continue; }
            let lines: Vec<&str> = block.lines().collect();
            if lines.is_empty() { continue; }

            let header = lines[0].trim_start_matches('#').trim();
            let (cat_str, title) = match header.split_once(':') {
                Some((c, t)) => (c.trim(), t.trim()),
                None => {
                    skipped.push(format!("missing 'category: title' header: {}", header));
                    continue;
                }
            };

            // M8: validate category against the CHECK constraint.
            if !VALID_CATEGORIES.contains(&cat_str) {
                skipped.push(format!("invalid category '{cat_str}' (allowed: coding-style, pitfall, architecture, workflow)"));
                continue;
            }

            // M8: validate title and content lengths.
            if let Err(e) = validate_field("title", title, 200) {
                skipped.push(format!("invalid title: {e}"));
                continue;
            }

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
            if entry_content.is_empty() {
                skipped.push(format!("empty content for [{cat_str}] {title}"));
                continue;
            }
            // M8: validate content length.
            if let Err(e) = validate_field("content", &entry_content, 32_000) {
                skipped.push(format!("[{cat_str}] {title}: {e}"));
                continue;
            }

            // M9: dedup against ANY source (not just 'human').
            if is_duplicate_any_source(conn, cat_str, title) {
                skipped.push(format!("duplicate skipped: [{cat_str}] {title}"));
                continue;
            }

            let id = generate_id();
            let now = now_iso();
            // M8: surface insert errors instead of silently dropping them.
            match conn.execute(
                "INSERT INTO entries (id,category,title,content,tags,scope,confidence,source,status,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,1.0,'human','confirmed',?7,?8)",
                params![id, cat_str, title, entry_content, tags, scope, now, now],
            ) {
                Ok(_) => {
                    entries.push(KnowledgeEntry { id, category: cat_str.to_string(), title: title.to_string(), content: entry_content, tags: if tags.is_empty() { vec![] } else { tags.split(',').map(|s| s.to_string()).collect() }, scope, confidence: 1.0, source: "human".to_string(), status: "confirmed".to_string(), created_at: now.clone(), updated_at: now });
                }
                Err(e) => {
                    skipped.push(format!("[{cat_str}] {title}: insert failed: {e}"));
                }
            }
        }

        // M8: include skipped reasons in the output so callers can see what happened.
        #[derive(Serialize)]
        struct ImportResult {
            entries: Vec<KnowledgeEntry>,
            skipped: Vec<String>,
        }
        let result = ImportResult { entries, skipped };
        serde_json::to_string(&result).map_err(|e| format!("JSON: {e}"))
    })
}
