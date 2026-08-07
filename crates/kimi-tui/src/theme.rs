//! TUI theme — semantic color tokens for the transcript and UI chrome,
//! resolved from `~/.kimi-code/tui.toml` (`theme = "dark" | "light" | "auto"`).
//! Mirrors the TS `ColorPalette` (dark/light) in a compact form.

use ratatui::style::Color;
use std::path::PathBuf;

/// Semantic color tokens the renderer uses (no hardcoded ratatui colors).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Theme {
    /// User prompt prefix.
    pub user: Color,
    /// Assistant text (default foreground).
    pub assistant: Color,
    /// Live streamed assistant text.
    pub stream: Color,
    /// Model reasoning (transient, dimmed).
    pub thinking: Color,
    /// Tool progress lines.
    pub tool: Color,
    /// Status / informational lines.
    pub status: Color,
    /// Errors.
    pub error: Color,
    /// Markdown headings.
    pub heading: Color,
    /// Inline / fenced code.
    pub code: Color,
    /// Blockquote text.
    pub quote: Color,
}

impl Theme {
    /// The dark palette (default).
    pub fn dark() -> Self {
        Self {
            user: Color::White,
            assistant: Color::White,
            stream: Color::Cyan,
            thinking: Color::DarkGray,
            tool: Color::Blue,
            status: Color::DarkGray,
            error: Color::Red,
            heading: Color::LightCyan,
            code: Color::Yellow,
            quote: Color::Gray,
        }
    }

    /// The light palette (dark text on a light terminal).
    pub fn light() -> Self {
        Self {
            user: Color::Black,
            assistant: Color::Black,
            stream: Color::Blue,
            thinking: Color::Gray,
            tool: Color::Magenta,
            status: Color::Gray,
            error: Color::Red,
            heading: Color::Blue,
            code: Color::Yellow,
            quote: Color::DarkGray,
        }
    }
}

/// Which theme the user requested (`auto` falls back to the dark palette).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThemeChoice {
    Dark,
    Light,
    Auto,
}

/// Parse the `theme` value from a TUI config.
fn parse_theme_choice(value: Option<&str>) -> ThemeChoice {
    match value.map(str::trim) {
        Some("light") => ThemeChoice::Light,
        Some("dark") => ThemeChoice::Dark,
        // "auto" (and anything unknown) defers to terminal background
        // detection — we approximate with dark.
        _ => ThemeChoice::Auto,
    }
}

/// Load the resolved theme from `tui.toml` (or the default dark palette when
/// the file / theme field is absent).
pub fn load_theme() -> Theme {
    let choice = tui_theme_choice();
    match choice {
        ThemeChoice::Dark => Theme::dark(),
        ThemeChoice::Light => Theme::light(),
        ThemeChoice::Auto => Theme::dark(),
    }
}

/// The `theme` field value from `~/.kimi-code/tui.toml` (None when absent).
pub fn tui_theme_choice() -> ThemeChoice {
    let Some(path) = tui_config_path() else {
        return ThemeChoice::Auto;
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return ThemeChoice::Auto;
    };
    let Ok(value) = text.parse::<toml::Value>() else {
        return ThemeChoice::Auto;
    };
    let theme = value
        .get("theme")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    parse_theme_choice(theme.as_deref())
}

/// The TUI config path: `$KIMI_CODE_HOME/tui.toml` or `~/.kimi-code/tui.toml`.
pub fn tui_config_path() -> Option<PathBuf> {
    if let Ok(home) = std::env::var("KIMI_CODE_HOME") {
        if !home.trim().is_empty() {
            return Some(PathBuf::from(home).join("tui.toml"));
        }
    }
    let base = if cfg!(windows) {
        std::env::var("USERPROFILE").ok()
    } else {
        std::env::var("HOME").ok()
    }?;
    Some(PathBuf::from(base).join(".kimi-code").join("tui.toml"))
}

/// Read a top-level string field from `tui.toml`.
pub fn tui_config_field(key: &str) -> Option<String> {
    let path = tui_config_path()?;
    let text = std::fs::read_to_string(path).ok()?;
    let value: toml::Value = text.parse().ok()?;
    value.get(key).and_then(|v| v.as_str()).map(str::to_string)
}

/// Set a top-level field in `tui.toml` (creates the file when absent).
/// Shared by `/locale`, `/editor`, and future chrome settings.
pub fn set_tui_config_field(key: &str, value: toml::Value) -> anyhow::Result<()> {
    let Some(path) = tui_config_path() else {
        anyhow::bail!("cannot locate tui.toml");
    };
    let mut doc = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| text.parse::<toml::Value>().ok())
        .unwrap_or_else(|| toml::Table::new().into());
    doc[key] = value;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, doc.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dark_and_light_palettes_are_distinct() {
        let dark = Theme::dark();
        let light = Theme::light();
        assert_ne!(dark.tool, light.tool);
        assert_ne!(dark.stream, light.stream);
        assert_ne!(dark.heading, light.heading);
    }

    #[test]
    fn theme_choice_parses() {
        assert_eq!(parse_theme_choice(Some("dark")), ThemeChoice::Dark);
        assert_eq!(parse_theme_choice(Some("light")), ThemeChoice::Light);
        assert_eq!(parse_theme_choice(Some("auto")), ThemeChoice::Auto);
        assert_eq!(parse_theme_choice(Some("fancy-custom")), ThemeChoice::Auto);
        assert_eq!(parse_theme_choice(None), ThemeChoice::Auto);
    }

    #[test]
    fn load_theme_never_fails() {
        // No KIMI_CODE_HOME, no tui.toml in the test env -> falls back.
        let theme = load_theme();
        let _ = theme.user;
    }
}
