use rusqlite::Connection;
use crate::models::{Category, Source};
use crate::store;

pub fn run(
    conn: &Connection,
    title: &str,
    category: &str,
    content: &str,
    tags: Option<&str>,
    scope: Option<&str>,
    source: Option<&str>,
    confidence: Option<f64>,
    json_output: bool,
) -> Result<(), String> {
    let category = Category::from_str(category)?;
    let source = source.map(Source::from_str).transpose()?.unwrap_or(Source::Human);
    let confidence = confidence.unwrap_or(1.0);
    let tags: Vec<String> = tags
        .map(|t| t.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
        .unwrap_or_default();

    let entry = store::add_entry(conn, &category, title, content, &tags, scope, &source, confidence)
        .map_err(|e| format!("Failed to add entry: {e}"))?;

    if json_output {
        println!("{}", serde_json::to_string_pretty(&entry).unwrap());
    } else {
        println!("Added: [{}] {} (id: {})", entry.category, entry.title, entry.id);
    }
    Ok(())
}
