use rusqlite::Connection;
use crate::store;

pub fn run(conn: &Connection, id: &str, json_output: bool) -> Result<(), String> {
    let removed = store::remove_entry(conn, id)
        .map_err(|e| format!("Failed to remove: {e}"))?;

    if !removed {
        return Err(format!("Entry not found: {id}"));
    }

    if json_output {
        let result = serde_json::json!({"removed": id});
        println!("{}", serde_json::to_string(&result).unwrap());
    } else {
        println!("Removed entry: {id}");
    }
    Ok(())
}
