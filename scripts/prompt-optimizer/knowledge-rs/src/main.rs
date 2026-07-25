mod commands;
mod db;
#[allow(dead_code)]
mod embedding;
mod import_export;
mod models;
mod search;
mod store;

use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "kimi-knowledge", version, about = "Local AI knowledge base for coding standards")]
struct Cli {
    /// Database file path (default: .kimi-code/knowledge.db)
    #[arg(long, global = true)]
    db: Option<PathBuf>,

    /// Output JSON format (for programmatic consumption)
    #[arg(long, global = true)]
    json: bool,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Add a new knowledge entry
    Add {
        #[arg(long)]
        title: String,
        #[arg(long)]
        category: String,
        #[arg(long)]
        content: String,
        #[arg(long)]
        tags: Option<String>,
        #[arg(long)]
        scope: Option<String>,
        #[arg(long)]
        source: Option<String>,
        #[arg(long)]
        confidence: Option<f64>,
    },
    /// List entries with optional filters
    List {
        #[arg(long)]
        category: Option<String>,
        #[arg(long)]
        tag: Option<String>,
        #[arg(long)]
        source: Option<String>,
    },
    /// Search entries by query
    Search {
        query: String,
        #[arg(long)]
        scope: Option<String>,
        #[arg(long)]
        tags: Option<String>,
        #[arg(long, default_value = "5")]
        limit: usize,
        #[arg(long, default_value = "0.5")]
        min_confidence: f64,
    },
    /// Get a single entry by ID
    Get { id: String },
    /// Edit an existing entry
    Edit {
        id: String,
        #[arg(long)]
        title: Option<String>,
        #[arg(long)]
        content: Option<String>,
        #[arg(long)]
        tags: Option<String>,
        #[arg(long)]
        category: Option<String>,
        #[arg(long)]
        scope: Option<String>,
    },
    /// Remove an entry
    Remove { id: String },
    /// Confirm an AI-learned entry (set confidence to 1.0)
    Confirm { id: String },
    /// Reject an entry (delete it)
    Reject { id: String },
    /// Import entries from a markdown file
    Import { file: PathBuf },
    /// Export all entries to markdown
    Export {
        #[arg(long)]
        file: Option<PathBuf>,
    },
    /// Show statistics
    Stats,
}

fn resolve_db_path(db_arg: Option<PathBuf>) -> PathBuf {
    if let Some(path) = db_arg {
        return path;
    }
    // Default: .kimi-code/knowledge.db relative to cwd
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    cwd.join(".kimi-code").join("knowledge.db")
}

fn main() {
    let cli = Cli::parse();
    let db_path = resolve_db_path(cli.db);
    let json_output = cli.json;

    let conn = match db::open_database(&db_path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Failed to open database at {}: {}", db_path.display(), e);
            std::process::exit(1);
        }
    };

    let result = match cli.command {
        Commands::Add { title, category, content, tags, scope, source, confidence } => {
            commands::add::run(&conn, &title, &category, &content, tags.as_deref(), scope.as_deref(), source.as_deref(), confidence, json_output)
        }
        Commands::List { category, tag, source } => {
            commands::list::run(&conn, category.as_deref(), tag.as_deref(), source.as_deref(), json_output)
        }
        Commands::Search { query, scope, tags, limit, min_confidence } => {
            commands::search_cmd::run(&conn, &query, scope.as_deref(), tags.as_deref(), limit, min_confidence, json_output)
        }
        Commands::Get { id } => {
            commands::get::run(&conn, &id, json_output)
        }
        Commands::Edit { id, title, content, tags, category, scope } => {
            commands::edit::run(&conn, &id, title.as_deref(), content.as_deref(), tags.as_deref(), category.as_deref(), scope, json_output)
        }
        Commands::Remove { id } => {
            commands::remove::run(&conn, &id, json_output)
        }
        Commands::Confirm { id } => {
            commands::confirm::run(&conn, &id, json_output)
        }
        Commands::Reject { id } => {
            commands::remove::run(&conn, &id, json_output)
        }
        Commands::Import { file } => {
            commands::import_cmd::run(&conn, &file, json_output)
        }
        Commands::Export { file } => {
            commands::export_cmd::run(&conn, file.as_deref(), json_output)
        }
        Commands::Stats => {
            commands::stats::run(&conn, json_output)
        }
    };

    if let Err(e) = result {
        eprintln!("Error: {e}");
        std::process::exit(1);
    }
}
