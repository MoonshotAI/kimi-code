use rusqlite::{params, Connection, Result};
use std::collections::HashSet;

use crate::models::{KnowledgeEntry, SearchResult};

pub fn search(
    conn: &Connection,
    query: &str,
    scope_path: Option<&str>,
    tags: Option<&[String]>,
    limit: usize,
    min_confidence: f64,
) -> Result<Vec<SearchResult>> {
    let mut results_map: std::collections::HashMap<String, (KnowledgeEntry, f64, Vec<String>)> =
        std::collections::HashMap::new();

    // 1. Scope match: entries whose scope is a prefix of the given path (or global)
    if let Some(path) = scope_path {
        let mut stmt = conn.prepare(
            "SELECT id, category, title, content, tags, scope, confidence, source, created_at, updated_at
             FROM entries
             WHERE confidence >= ?1 AND (scope IS NULL OR substr(?2, 1, length(scope)) = scope)
             ORDER BY confidence DESC
             LIMIT 20",
        )?;
        let rows = stmt.query_map(params![min_confidence, path], |row| row_to_entry(row))?;
        for row in rows {
            let entry = row?;
            let score = if entry.scope.is_some() { 3.0 } else { 1.0 };
            let id = entry.id.clone();
            let e = results_map.entry(id).or_insert_with(|| (entry, 0.0, vec![]));
            e.1 += score;
            e.2.push("scope".to_string());
        }
    }

    // 2. FTS5 full-text search
    if !query.is_empty() && query != "*" {
        // Quote each word to prevent FTS5 operator interpretation (NOT, AND, OR, NEAR)
        let fts_query = if query.contains('"') {
            query.to_string()
        } else {
            query.split_whitespace()
                .map(|w| format!("\"{}\"", w.replace('"', "\"\"")))
                .collect::<Vec<_>>()
                .join(" OR ")
        };

        let sql = "SELECT e.id, e.category, e.title, e.content, e.tags, e.scope, e.confidence, e.source, e.created_at, e.updated_at, rank
                   FROM entries_fts f
                   JOIN entries e ON e.rowid = f.rowid
                   WHERE entries_fts MATCH ?1 AND e.confidence >= ?2
                   ORDER BY rank
                   LIMIT 20";

        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(params![fts_query, min_confidence], |row| {
            let entry = row_to_entry(row)?;
            let rank: f64 = row.get(10)?;
            Ok((entry, rank))
        });

        if let Ok(rows) = rows {
            for row in rows {
                if let Ok((entry, rank)) = row {
                    // FTS rank is negative (more negative = better match), normalize
                    let score = 2.0 * (1.0 / (1.0 + rank.abs()));
                    let e = results_map.entry(entry.id.clone()).or_insert_with(|| (entry, 0.0, vec![]));
                    e.1 += score;
                    e.2.push("fts".to_string());
                }
            }
        }
    }

    // 3. Tag overlap
    if let Some(query_tags) = tags {
        let tag_set: HashSet<&str> = query_tags.iter().map(|s| s.as_str()).collect();

        let mut stmt = conn.prepare(
            "SELECT id, category, title, content, tags, scope, confidence, source, created_at, updated_at
             FROM entries WHERE confidence >= ?1 AND tags != ''",
        )?;
        let rows = stmt.query_map(params![min_confidence], |row| row_to_entry(row))?;

        for row in rows {
            if let Ok(entry) = row {
                let entry_tags: HashSet<&str> = entry.tags.iter().map(|s| s.as_str()).collect();
                let overlap = tag_set.intersection(&entry_tags).count();
                if overlap > 0 {
                    let score = overlap as f64;
                    let e = results_map.entry(entry.id.clone()).or_insert_with(|| (entry, 0.0, vec![]));
                    e.1 += score;
                    e.2.push("tag".to_string());
                }
            }
        }
    }

    // Sort by relevance (score * confidence), then truncate
    let mut results: Vec<SearchResult> = results_map
        .into_values()
        .map(|(entry, score, sources)| {
            let relevance = score * entry.confidence;
            // Deduplicate match sources
            let unique_sources: Vec<String> = sources.into_iter().collect::<HashSet<_>>().into_iter().collect();
            SearchResult { entry, relevance, match_source: unique_sources }
        })
        .collect();

    results.sort_by(|a, b| b.relevance.partial_cmp(&a.relevance).unwrap_or(std::cmp::Ordering::Equal));
    results.truncate(limit);

    Ok(results)
}

fn row_to_entry(row: &rusqlite::Row) -> Result<KnowledgeEntry> {
    use crate::models::{Category, Source};
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
