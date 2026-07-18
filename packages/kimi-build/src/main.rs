use clap::{Parser, Subcommand};

mod inject;

#[derive(Parser)]
#[command(name = "kimi-build", about = "Kimi Code native build tool")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Inject a SEA blob into a Node.js executable
    Inject {
        /// Path to the Node.js executable to inject into
        input: String,
        /// Path to the SEA blob file
        blob: String,
        /// Output path for the injected executable (defaults to overwriting input)
        #[arg(short = 'o', long)]
        output: Option<String>,
    },
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Commands::Inject { input, blob, output } => {
            let output = output.unwrap_or_else(|| input.clone());
            inject::run(&input, &blob, &output)?;
            println!("Injected SEA blob into {}", output);
        }
    }
    Ok(())
}