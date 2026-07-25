use rusqlite::Connection;
use std::path::Path;
use crate::import_export;

pub fn run(conn: &Connection, file: &Path, json_output: bool) -> Result<(), String> {
    let entries = import_export::import_from_markdown(conn, file)?;

    if json_output {
        println!("{}", serde_json::to_string_pretty(&entries).unwrap());
    } else {
        println!("Imported {} entries from {}", entries.len(), file.display());
        for e in &entries {
            println!("  + [{}] {}", e.category, e.title);
        }
    }
    Ok(())
}
