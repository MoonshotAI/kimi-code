use std::fs;
use std::path::Path;

use crate::models::{Category, KnowledgeEntry, Source};
use crate::store;
use rusqlite::Connection;

/// Parse markdown import format:
/// ```
/// # category: title
/// tags: tag1, tag2
/// scope: optional/path/
///
/// Content here.
///
/// ---
/// ```
pub fn import_from_markdown(conn: &Connection, path: &Path) -> Result<Vec<KnowledgeEntry>, String> {
    let content = fs::read_to_string(path).map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    // Normalize line endings and split on --- separator (with optional surrounding blank lines)
    let content = content.replace("\r\n", "\n");
    let blocks: Vec<&str> = content.split("\n---\n").collect();
    let mut entries = Vec::new();

    for block in blocks {
        let block = block.trim();
        if block.is_empty() {
            continue;
        }

        let lines: Vec<&str> = block.lines().collect();
        if lines.is_empty() {
            continue;
        }

        // Parse header: # category: title
        let header = lines[0].trim_start_matches('#').trim();
        let (category_str, title) = header.split_once(':')
            .ok_or_else(|| format!("Invalid header format (expected '# category: title'): {}", lines[0]))?;

        let category = Category::from_str(category_str.trim())?;
        let title = title.trim();

        let mut tags: Vec<String> = Vec::new();
        let mut scope: Option<String> = None;
        let mut content_start = 1;

        // Parse metadata lines (tags:, scope:)
        for (i, line) in lines.iter().enumerate().skip(1) {
            if let Some(t) = line.strip_prefix("tags:") {
                tags = t.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
                content_start = i + 1;
            } else if let Some(s) = line.strip_prefix("scope:") {
                scope = Some(s.trim().to_string());
                content_start = i + 1;
            } else if line.is_empty() {
                content_start = i + 1;
                break;
            } else {
                break;
            }
        }

        let content_text = lines[content_start..].join("\n").trim().to_string();
        // Unescape --- separators that were escaped during export
        let content_text = content_text.replace("\n\\---\n", "\n---\n");
        if content_text.is_empty() {
            continue;
        }

        let entry = store::add_entry(
            conn,
            &category,
            title,
            &content_text,
            &tags,
            scope.as_deref(),
            &Source::Human,
            1.0,
        ).map_err(|e| format!("Failed to insert entry '{title}': {e}"))?;

        entries.push(entry);
    }

    Ok(entries)
}

/// Export all entries to markdown format.
pub fn export_to_markdown(conn: &Connection) -> Result<String, String> {
    let entries = store::list_entries(conn, None, None, None)
        .map_err(|e| format!("Failed to list entries: {e}"))?;

    let mut output = String::new();
    for (i, entry) in entries.iter().enumerate() {
        if i > 0 {
            output.push_str("\n---\n\n");
        }
        output.push_str(&format!("# {}: {}\n", entry.category, entry.title));
        if !entry.tags.is_empty() {
            output.push_str(&format!("tags: {}\n", entry.tags.join(", ")));
        }
        if let Some(scope) = &entry.scope {
            output.push_str(&format!("scope: {scope}\n"));
        }
        output.push('\n');
        // Escape content's own --- separators to prevent import corruption
        let escaped_content = entry.content.replace("\n---\n", "\n\\---\n");
        output.push_str(&escaped_content);
        output.push('\n');
    }

    Ok(output)
}
