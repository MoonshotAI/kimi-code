use rusqlite::Connection;
use crate::store;

pub fn run(conn: &Connection, id: &str, title: Option<&str>, content: Option<&str>, tags: Option<&str>, category: Option<&str>, scope: Option<String>, json_output: bool) -> Result<(), String> {
    let scope_opt = scope.as_ref().map(|s| if s.is_empty() { None } else { Some(s.as_str()) });
    let updated = store::update_entry(conn, id, title, content, tags, category, scope_opt)
        .map_err(|e| format!("Failed to update: {e}"))?;

    if !updated {
        return Err(format!("Entry not found: {id}"));
    }

    if json_output {
        let entry = store::get_entry(conn, id).map_err(|e| format!("{e}"))?.unwrap();
        println!("{}", serde_json::to_string_pretty(&entry).unwrap());
    } else {
        println!("Updated entry: {id}");
    }
    Ok(())
}
