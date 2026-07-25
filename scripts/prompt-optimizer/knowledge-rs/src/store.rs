use chrono::Utc;
use rusqlite::{params, Connection, Result};
use ulid::Ulid;

use crate::models::{Category, KnowledgeEntry, Source, Stats};

pub fn add_entry(
    conn: &Connection,
    category: &Category,
    title: &str,
    content: &str,
    tags: &[String],
    scope: Option<&str>,
    source: &Source,
    confidence: f64,
) -> Result<KnowledgeEntry> {
    let id = Ulid::new().to_string();
    let now = Utc::now().to_rfc3339();
    let tags_str = tags.join(",");
    // Normalize empty scope to NULL (global)
    let scope = scope.filter(|s| !s.is_empty());

    conn.execute(
        "INSERT INTO entries (id, category, title, content, tags, scope, confidence, source, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![id, category.as_str(), title, content, tags_str, scope, confidence, source.as_str(), now, now],
    )?;

    Ok(KnowledgeEntry {
        id,
        category: category.clone(),
        title: title.to_string(),
        content: content.to_string(),
        tags: tags.to_vec(),
        scope: scope.map(|s| s.to_string()),
        confidence,
        source: source.clone(),
        created_at: now.clone(),
        updated_at: now,
    })
}

pub fn get_entry(conn: &Connection, id: &str) -> Result<Option<KnowledgeEntry>> {
    let mut stmt = conn.prepare(
        "SELECT id, category, title, content, tags, scope, confidence, source, created_at, updated_at FROM entries WHERE id = ?1",
    )?;
    let mut rows = stmt.query(params![id])?;
    match rows.next()? {
        Some(row) => Ok(Some(row_to_entry(row)?)),
        None => Ok(None),
    }
}

pub fn list_entries(
    conn: &Connection,
    category: Option<&str>,
    tag: Option<&str>,
    source: Option<&str>,
) -> Result<Vec<KnowledgeEntry>> {
    let mut sql = String::from(
        "SELECT id, category, title, content, tags, scope, confidence, source, created_at, updated_at FROM entries WHERE 1=1",
    );
    let mut param_values: Vec<String> = Vec::new();

    if let Some(cat) = category {
        param_values.push(cat.to_string());
        sql.push_str(&format!(" AND category = ?{}", param_values.len()));
    }
    if let Some(t) = tag {
        param_values.push(format!("%{t}%"));
        sql.push_str(&format!(" AND tags LIKE ?{}", param_values.len()));
    }
    if let Some(src) = source {
        param_values.push(src.to_string());
        sql.push_str(&format!(" AND source = ?{}", param_values.len()));
    }
    sql.push_str(" ORDER BY updated_at DESC");

    let mut stmt = conn.prepare(&sql)?;
    let params_refs: Vec<&dyn rusqlite::types::ToSql> = param_values.iter().map(|s| s as &dyn rusqlite::types::ToSql).collect();
    let rows = stmt.query_map(params_refs.as_slice(), |row| row_to_entry(row))?;

    let mut entries = Vec::new();
    for row in rows {
        entries.push(row?);
    }
    Ok(entries)
}

pub fn update_entry(
    conn: &Connection,
    id: &str,
    title: Option<&str>,
    content: Option<&str>,
    tags: Option<&str>,
    category: Option<&str>,
    scope: Option<Option<&str>>,
) -> Result<bool> {
    let now = Utc::now().to_rfc3339();
    let mut sets = vec!["updated_at = ?1".to_string()];
    let mut param_values: Vec<String> = vec![now];

    if let Some(t) = title {
        param_values.push(t.to_string());
        sets.push(format!("title = ?{}", param_values.len()));
    }
    if let Some(c) = content {
        param_values.push(c.to_string());
        sets.push(format!("content = ?{}", param_values.len()));
    }
    if let Some(t) = tags {
        param_values.push(t.to_string());
        sets.push(format!("tags = ?{}", param_values.len()));
    }
    if let Some(cat) = category {
        param_values.push(cat.to_string());
        sets.push(format!("category = ?{}", param_values.len()));
    }
    if let Some(s) = scope {
        param_values.push(s.unwrap_or("").to_string());
        sets.push(format!("scope = NULLIF(?{}, '')", param_values.len()));
    }

    param_values.push(id.to_string());
    let id_param = param_values.len();
    let sql = format!("UPDATE entries SET {} WHERE id = ?{}", sets.join(", "), id_param);

    let params_refs: Vec<&dyn rusqlite::types::ToSql> = param_values.iter().map(|s| s as &dyn rusqlite::types::ToSql).collect();
    let affected = conn.execute(&sql, params_refs.as_slice())?;
    Ok(affected > 0)
}

pub fn remove_entry(conn: &Connection, id: &str) -> Result<bool> {
    let affected = conn.execute("DELETE FROM entries WHERE id = ?1", params![id])?;
    Ok(affected > 0)
}

pub fn confirm_entry(conn: &Connection, id: &str) -> Result<bool> {
    let now = Utc::now().to_rfc3339();
    let affected = conn.execute(
        "UPDATE entries SET confidence = 1.0, source = 'ai-confirmed', updated_at = ?1 WHERE id = ?2",
        params![now, id],
    )?;
    Ok(affected > 0)
}

pub fn get_stats(conn: &Connection) -> Result<Stats> {
    let total: usize = conn.query_row("SELECT count(*) FROM entries", [], |r| r.get(0))?;

    let mut by_category = std::collections::HashMap::new();
    let mut stmt = conn.prepare("SELECT category, count(*) FROM entries GROUP BY category")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, usize>(1)?))
    })?;
    for row in rows {
        let (cat, count) = row?;
        by_category.insert(cat, count);
    }

    let mut by_source = std::collections::HashMap::new();
    let mut stmt = conn.prepare("SELECT source, count(*) FROM entries GROUP BY source")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, usize>(1)?))
    })?;
    for row in rows {
        let (src, count) = row?;
        by_source.insert(src, count);
    }

    let avg_confidence: f64 = conn
        .query_row("SELECT COALESCE(avg(confidence), 0) FROM entries", [], |r| r.get(0))?;

    Ok(Stats { total, by_category, by_source, avg_confidence })
}

fn row_to_entry(row: &rusqlite::Row) -> Result<KnowledgeEntry> {
    let category_str: String = row.get(1)?;
    let source_str: String = row.get(7)?;
    let tags_str: String = row.get(4)?;

    Ok(KnowledgeEntry {
        id: row.get(0)?,
        category: Category::from_str(&category_str).unwrap_or(Category::Pitfall),
        title: row.get(2)?,
        content: row.get(3)?,
        tags: if tags_str.is_empty() { vec![] } else { tags_str.split(',').map(|s| s.trim().to_string()).collect() },
        scope: row.get(5)?,
        confidence: row.get(6)?,
        source: Source::from_str(&source_str).unwrap_or(Source::Human),
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}
