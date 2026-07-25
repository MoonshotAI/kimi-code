use rusqlite::Connection;
use crate::store;

pub fn run(conn: &Connection, json_output: bool) -> Result<(), String> {
    let stats = store::get_stats(conn).map_err(|e| format!("Failed to get stats: {e}"))?;

    if json_output {
        println!("{}", serde_json::to_string_pretty(&stats).unwrap());
    } else {
        println!("Knowledge Base Statistics");
        println!("═══════════════════════════════════");
        println!("Total entries:    {}", stats.total);
        println!("Avg confidence:   {:.2}", stats.avg_confidence);
        println!();
        println!("By category:");
        for (cat, count) in &stats.by_category {
            println!("  {:<16} {}", cat, count);
        }
        println!();
        println!("By source:");
        for (src, count) in &stats.by_source {
            println!("  {:<16} {}", src, count);
        }
    }
    Ok(())
}
