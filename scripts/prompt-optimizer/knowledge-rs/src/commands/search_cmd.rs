use rusqlite::Connection;
use crate::search;

pub fn run(conn: &Connection, query: &str, scope: Option<&str>, tags: Option<&str>, limit: usize, min_confidence: f64, json_output: bool) -> Result<(), String> {
    let tag_vec: Option<Vec<String>> = tags.map(|t| t.split(',').map(|s| s.trim().to_string()).collect());
    let results = search::search(conn, query, scope, tag_vec.as_deref(), limit, min_confidence)
        .map_err(|e| format!("Search failed: {e}"))?;

    if json_output {
        println!("{}", serde_json::to_string_pretty(&results).unwrap());
    } else {
        if results.is_empty() {
            println!("No results found for: {query}");
            return Ok(());
        }
        for (i, r) in results.iter().enumerate() {
            println!("{}. [{}] {} (relevance: {:.2}, via: {})",
                i + 1, r.entry.category, r.entry.title, r.relevance, r.match_source.join("+"));
            println!("   {}", r.entry.content.lines().next().unwrap_or(""));
            println!();
        }
    }
    Ok(())
}
