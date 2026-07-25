use rusqlite::Connection;
use crate::store;

pub fn run(conn: &Connection, category: Option<&str>, tag: Option<&str>, source: Option<&str>, json_output: bool) -> Result<(), String> {
    let entries = store::list_entries(conn, category, tag, source)
        .map_err(|e| format!("Failed to list entries: {e}"))?;

    if json_output {
        println!("{}", serde_json::to_string_pretty(&entries).unwrap());
    } else {
        if entries.is_empty() {
            println!("No entries found.");
            return Ok(());
        }
        println!("{:<8} {:<14} {:<40} {:<6} {}", "ID", "Category", "Title", "Conf", "Tags");
        println!("{}", "─".repeat(90));
        for e in &entries {
            let id_short = &e.id[..8.min(e.id.len())];
            let title_short = if e.title.chars().count() > 38 {
                let truncated: String = e.title.chars().take(37).collect();
                format!("{truncated}…")
            } else {
                e.title.clone()
            };
            println!("{:<8} {:<14} {:<40} {:<6.2} {}", id_short, e.category, title_short, e.confidence, e.tags.join(","));
        }
        println!("\n{} entries total.", entries.len());
    }
    Ok(())
}
