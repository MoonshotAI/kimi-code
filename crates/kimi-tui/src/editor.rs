//! External editor for the input pane (Ctrl-G) — TS `openExternalEditor` /
//! `editInExternalEditor` parity. The TUI is suspended (raw mode off,
//! alternate screen left), the editor runs on a temp file seeded with the
//! current input, and the edited text comes back into the input line.

/// The external editor command string, or `None` when none is configured.
///
/// Resolution order (TS `resolveEditorCommand` parity): the `editor` field
/// from `tui.toml` (set via `/editor`) → `KIMI_CODE_EDITOR` (extension) →
/// `VISUAL` → `EDITOR` → platform default (`notepad` on Windows, `vi`
/// elsewhere). The value is passed to the shell verbatim, so argv-style
/// strings like `code --wait` or `nvim +"set ft=markdown"` work.
pub fn resolve_editor() -> Option<String> {
    if let Some(configured) = crate::theme::tui_config_field("editor") {
        if !configured.trim().is_empty() {
            return Some(configured.trim().to_string());
        }
    }
    for var in ["KIMI_CODE_EDITOR", "VISUAL", "EDITOR"] {
        if let Ok(value) = std::env::var(var) {
            if !value.trim().is_empty() {
                return Some(value.trim().to_string());
            }
        }
    }
    Some(if cfg!(windows) {
        "notepad".to_string()
    } else {
        "vi".to_string()
    })
}

/// Persist the editor command to `tui.toml` (`editor` field).
pub fn save_editor(command: &str) -> anyhow::Result<()> {
    if command.trim().is_empty() {
        anyhow::bail!("editor command cannot be empty");
    }
    crate::theme::set_tui_config_field("editor", toml::Value::String(command.trim().to_string()))
}

/// Open the external editor seeded with `seed`, returning the edited text.
///
/// Mirrors TS `editInExternalEditor`: the command runs through the platform
/// shell against a temp file; a non-zero exit keeps the original text
/// (editor cancel doesn't clobber the input); CRLF line endings are
/// normalised to LF and one trailing newline is stripped. The TUI is
/// suspended around the editor and restored either way.
pub fn edit_external(seed: &str) -> anyhow::Result<String> {
    let Some(cmd) = resolve_editor() else {
        anyhow::bail!("no editor configured (set $EDITOR)");
    };
    let dir = std::env::temp_dir();
    let path = dir.join(format!("kimi-edit-{}.txt", std::process::id()));
    std::fs::write(&path, seed)?;

    // Suspend the TUI so the editor owns the terminal.
    crossterm::terminal::disable_raw_mode()?;
    crossterm::execute!(std::io::stdout(), crossterm::terminal::LeaveAlternateScreen)?;

    // Shell out so the command string keeps its argv quoting semantics.
    let shell_cmd = format!("{cmd} \"{}\"", path.display());
    let status = if cfg!(windows) {
        std::process::Command::new("cmd")
            .args(["/C", &shell_cmd])
            .status()
    } else {
        std::process::Command::new("sh")
            .args(["-c", &shell_cmd])
            .status()
    };

    // Restore the TUI either way.
    let resume = || -> anyhow::Result<()> {
        crossterm::execute!(std::io::stdout(), crossterm::terminal::EnterAlternateScreen)?;
        crossterm::terminal::enable_raw_mode()?;
        Ok(())
    };

    let status = match status {
        Ok(s) => s,
        Err(e) => {
            let _ = resume();
            return Err(anyhow::anyhow!("failed to launch {cmd}: {e}"));
        }
    };
    resume()?;

    if !status.success() {
        // Editor cancelled / failed: keep the original input, don't clobber.
        let _ = std::fs::remove_file(&path);
        return Ok(seed.to_string());
    }

    let text = std::fs::read_to_string(&path)?;
    let _ = std::fs::remove_file(&path);
    // Windows editors write CRLF; normalise and drop the trailing newline.
    Ok(text
        .replace("\r\n", "\n")
        .trim_end_matches('\n')
        .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serializes the env-mutating editor tests (they share the process
    /// `KIMI_CODE_EDITOR` variable).
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn resolves_from_environment() {
        let _g = ENV_LOCK.lock().unwrap();
        // KIMI_CODE_EDITOR wins over the platform default; other tests do
        // not read it, so setting it is safe here.
        std::env::set_var("KIMI_CODE_EDITOR", "code --wait");
        assert_eq!(resolve_editor(), Some("code --wait".to_string()));
    }

    #[test]
    fn empty_env_falls_back_to_default() {
        let _g = ENV_LOCK.lock().unwrap();
        std::env::set_var("KIMI_CODE_EDITOR", "   ");
        assert!(resolve_editor().is_some(), "platform default exists");
    }

    #[test]
    fn normalises_line_endings() {
        let text = "a\r\nb\r\n"
            .replace("\r\n", "\n")
            .trim_end_matches('\n')
            .to_string();
        assert_eq!(text, "a\nb");
    }
}
