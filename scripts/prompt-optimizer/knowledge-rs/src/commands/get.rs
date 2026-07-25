use rusqlite::Connection;
use crate::store;

pub fn run(conn: &Connection, id: &str, json_output: bool) -> Result<(), String> {
    let entry = store::get_entry(conn, id)
        .map_err(|e| format!("Failed to get entry: {e}"))?
        .ok_or_else(|| format!("Entry not found: {id}"))?;

    if json_output {
        println!("{}", serde_json::to_string_pretty(&entry).unwrap());
    } else {
        println!("ID:         {}", entry.id);
        println!("Category:   {}", entry.category);
        println!("Title:      {}", entry.title);
        println!("Tags:       {}", entry.tags.join(", "));
        println!("Scope:      {}", entry.scope.as_deref().unwrap_or("(global)"));
        println!("Confidence: {:.2}", entry.confidence);
        println!("Source:     {}", entry.source);
        println!("Created:    {}", entry.created_at);
        println!("Updated:    {}", entry.updated_at);
        println!("─────────────────────────────────────────");
        println!("{}", entry.content);
    }
    Ok(())
}
