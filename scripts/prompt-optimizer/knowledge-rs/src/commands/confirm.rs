use rusqlite::Connection;
use crate::store;

pub fn run(conn: &Connection, id: &str, json_output: bool) -> Result<(), String> {
    let confirmed = store::confirm_entry(conn, id)
        .map_err(|e| format!("Failed to confirm: {e}"))?;

    if !confirmed {
        return Err(format!("Entry not found: {id}"));
    }

    if json_output {
        let entry = store::get_entry(conn, id).map_err(|e| format!("{e}"))?.unwrap();
        println!("{}", serde_json::to_string_pretty(&entry).unwrap());
    } else {
        println!("Confirmed entry: {id} (confidence → 1.0, source → ai-confirmed)");
    }
    Ok(())
}
