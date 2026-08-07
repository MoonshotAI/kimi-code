//! Bottom pane — the input line editor and Tab completion (G-4 chatwidget
//! component tree, step 2). Pure functions over the input string + cursor so
//! the app shell stays thin and the editor is unit-testable without a
//! terminal.

// ── Tab completion constants ────────────────────────────────────────────

/// Closed argument sets for Tab completion of a few commands.
pub const ON_OFF_ARGS: &[&str] = &["on", "off"];
pub const THINKING_ARGS: &[&str] = &["low", "medium", "high"];
/// `/permission` modes (TS picker parity).
pub const PERMISSION_ARGS: &[&str] = &["manual", "plan", "auto", "yolo"];
/// `/goal` subcommands (TS `GOAL_ARG_COMPLETIONS` parity; a bare objective
/// still creates a goal).
pub const GOAL_ARGS: &[&str] = &["status", "pause", "resume", "cancel", "replace", "next"];

/// Slash commands with a one-line description key (the completion popup's
/// description column; TS registry parity). The second element is an i18n
/// key under `tui.cmd.*` — resolve via [`command_descriptions`].
pub const COMMAND_DESCRIPTIONS: &[(&str, &str)] = &[
    ("/quit", "tui.cmd.quit"),
    ("/exit", "tui.cmd.exit"),
    ("/help", "tui.cmd.help"),
    ("/approvals", "tui.cmd.approvals"),
    ("/approve", "tui.cmd.approve"),
    ("/deny", "tui.cmd.deny"),
    ("/status", "tui.cmd.status"),
    ("/info", "tui.cmd.info"),
    ("/session", "tui.cmd.session"),
    ("/plugins", "tui.cmd.plugins"),
    ("/config", "tui.cmd.config"),
    ("/skills", "tui.cmd.skills"),
    ("/plan", "tui.cmd.plan"),
    ("/swarm", "tui.cmd.swarm"),
    ("/thinking", "tui.cmd.thinking"),
    ("/permission", "tui.cmd.permission"),
    ("/yolo", "tui.cmd.yolo"),
    ("/auto", "tui.cmd.auto"),
    ("/new", "tui.cmd.new"),
    ("/init", "tui.cmd.init"),
    ("/title", "tui.cmd.title"),
    ("/mcp", "tui.cmd.mcp"),
    ("/tasks", "tui.cmd.tasks"),
    ("/theme", "tui.cmd.theme"),
    ("/version", "tui.cmd.version"),
    ("/models", "tui.cmd.models"),
    ("/model", "tui.cmd.model"),
    ("/reload", "tui.cmd.reload"),
    ("/resume", "tui.cmd.resume"),
    ("/goal", "tui.cmd.goal"),
    ("/goal-cancel", "tui.cmd.goal-cancel"),
    ("/goal-pause", "tui.cmd.goal-pause"),
    ("/goal-resume", "tui.cmd.goal-resume"),
    ("/goal-status", "tui.cmd.goal-status"),
    ("/add-dir", "tui.cmd.add-dir"),
    ("/clear", "tui.cmd.clear"),
    ("/compact", "tui.cmd.compact"),
    ("/usage", "tui.cmd.usage"),
    ("/undo", "tui.cmd.undo"),
    ("/fork", "tui.cmd.fork"),
    ("/steer", "tui.cmd.steer"),
    ("/import", "tui.cmd.import"),
    ("/sessions", "tui.cmd.sessions"),
    ("/export", "tui.cmd.export"),
    ("/archive", "tui.cmd.archive"),
    ("/login", "tui.cmd.login"),
    ("/logout", "tui.cmd.logout"),
    ("/locale", "tui.cmd.locale"),
    ("/editor", "tui.cmd.editor"),
    ("/settings", "tui.cmd.settings"),
    ("/copy", "tui.cmd.copy"),
    ("/export-md", "tui.cmd.export-md"),
];

/// Resolved `(command, description)` pairs for the active locale (the
/// completion popup / `/help` description column).
pub fn command_descriptions() -> Vec<(String, String)> {
    COMMAND_DESCRIPTIONS
        .iter()
        .map(|(name, key)| ((*name).to_string(), crate::i18n::t(key).to_string()))
        .collect()
}

/// Command names for `/…` Tab completion.
pub const SLASH_COMMANDS: &[&str] = &[
    "/add-dir", "/approvals", "/approve", "/archive", "/auto", "/clear", "/compact", "/config",
    "/deny", "/exit", "/export", "/fork", "/goal", "/goal-cancel", "/goal-pause", "/goal-resume",
    "/goal-status", "/help", "/import", "/info", "/init", "/locale", "/login", "/logout", "/mcp",
    "/model", "/models", "/new", "/permission", "/plan", "/plugins", "/quit", "/reload",
    "/resume", "/session", "/sessions", "/settings", "/skills", "/status", "/steer", "/swarm",
    "/tasks", "/theme", "/thinking", "/title", "/undo", "/usage", "/version", "/yolo", "/editor",
    "/copy", "/export-md",
];

// ── Input editing (char-index based) ────────────────────────────────────

/// Byte offset of the `cursor`-th char (clamped to the string end).
fn byte_of_char(input: &str, cursor: usize) -> usize {
    input.char_indices().nth(cursor).map_or(input.len(), |(i, _)| i)
}

/// Insert `ch` at the char index `cursor`; returns the new input and cursor.
pub fn insert_char(input: &str, cursor: usize, ch: char) -> (String, usize) {
    let cursor = cursor.min(input.chars().count());
    let at = byte_of_char(input, cursor);
    let mut out = String::with_capacity(input.len() + ch.len_utf8());
    out.push_str(&input[..at]);
    out.push(ch);
    out.push_str(&input[at..]);
    (out, cursor + 1)
}

/// Insert a whole `text` at the char index `cursor` (bracketed paste).
pub fn insert_text(input: &str, cursor: usize, text: &str) -> (String, usize) {
    let cursor = cursor.min(input.chars().count());
    let at = byte_of_char(input, cursor);
    let mut out = String::with_capacity(input.len() + text.len());
    out.push_str(&input[..at]);
    out.push_str(text);
    out.push_str(&input[at..]);
    (out, cursor + text.chars().count())
}

/// Delete the char before `cursor`; returns the new input and cursor.
pub fn backspace(input: &str, cursor: usize) -> (String, usize) {
    let cursor = cursor.min(input.chars().count());
    if cursor == 0 {
        return (input.to_string(), 0);
    }
    let start = byte_of_char(input, cursor - 1);
    let end = byte_of_char(input, cursor);
    let mut out = String::with_capacity(input.len());
    out.push_str(&input[..start]);
    out.push_str(&input[end..]);
    (out, cursor - 1)
}

/// Delete the char at `cursor` (Delete key); unchanged at end of input.
pub fn delete_forward(input: &str, cursor: usize) -> String {
    let chars = input.chars().count();
    let cursor = cursor.min(chars);
    if cursor >= chars {
        return input.to_string();
    }
    let start = byte_of_char(input, cursor);
    let end = byte_of_char(input, cursor + 1);
    let mut out = String::with_capacity(input.len());
    out.push_str(&input[..start]);
    out.push_str(&input[end..]);
    out
}

/// Move the cursor left (`dir < 0`) or right (`dir > 0`), clamped to bounds.
pub fn move_cursor(input: &str, cursor: usize, dir: i8) -> usize {
    let chars = input.chars().count();
    let cursor = cursor.min(chars);
    match dir {
        d if d < 0 => cursor.saturating_sub(1),
        d if d > 0 => (cursor + 1).min(chars),
        _ => cursor,
    }
}

/// The 0-based `(line, col)` of `cursor` in a `\n`-separated buffer.
pub fn cursor_line_col(input: &str, cursor: usize) -> (usize, usize) {
    let cursor = cursor.min(input.chars().count());
    let prefix = &input[..byte_of_char(input, cursor)];
    let mut row = 0;
    let mut col = 0;
    for c in prefix.chars() {
        if c == '\n' {
            row += 1;
            col = 0;
        } else {
            col += 1;
        }
    }
    (row, col)
}

/// Index of the char at `(row, col)`, clamped to the target line's end.
fn line_col_index(input: &str, row: usize, col: usize) -> usize {
    let mut r = 0;
    let mut c = 0;
    for (i, ch) in input.chars().enumerate() {
        if r == row {
            if c >= col || ch == '\n' {
                return i;
            }
            c += 1;
        } else if ch == '\n' {
            r += 1;
            if r > row {
                return i;
            }
        }
    }
    input.chars().count()
}

/// Move the cursor one visual line up (`dir < 0`) or down (`dir > 0`) at
/// the same column, clamped to the target line's end. No-op on the first
/// line up / last line down.
pub fn move_cursor_vert(input: &str, cursor: usize, dir: i8) -> usize {
    let (row, col) = cursor_line_col(input, cursor);
    let rows = input.chars().filter(|c| *c == '\n').count() + 1;
    match dir {
        d if d < 0 => {
            if row == 0 {
                0
            } else {
                line_col_index(input, row - 1, col)
            }
        }
        d if d > 0 => {
            if row + 1 >= rows {
                input.chars().count()
            } else {
                line_col_index(input, row + 1, col)
            }
        }
        _ => cursor,
    }
}

/// Ctrl-U: delete everything before the cursor; cursor jumps to the start.
pub fn kill_to_start(input: &str, cursor: usize) -> (String, usize) {
    let cursor = cursor.min(input.chars().count());
    (input[byte_of_char(input, cursor)..].to_string(), 0)
}

/// Ctrl-K: delete everything from the cursor to the end of the input.
pub fn kill_to_end(input: &str, cursor: usize) -> String {
    let cursor = cursor.min(input.chars().count());
    input[..byte_of_char(input, cursor)].to_string()
}

/// Ctrl-W: delete the word before the cursor (skipping intervening
/// whitespace); returns the new input and cursor.
pub fn kill_word(input: &str, cursor: usize) -> (String, usize) {
    let chars: Vec<char> = input.chars().collect();
    let cursor = cursor.min(chars.len());
    if cursor == 0 {
        return (input.to_string(), 0);
    }
    let mut i = cursor;
    while i > 0 && chars[i - 1].is_whitespace() {
        i -= 1;
    }
    while i > 0 && !chars[i - 1].is_whitespace() {
        i -= 1;
    }
    let start = byte_of_char(input, i);
    let end = byte_of_char(input, cursor);
    let mut out = String::with_capacity(input.len());
    out.push_str(&input[..start]);
    out.push_str(&input[end..]);
    (out, i)
}

// ── Tab completion ──────────────────────────────────────────────────────

/// Resolve a Tab press against `base` (the input when the cycle started, or
/// the current input). Returns the completed input and the next cycle index.
pub fn complete_line(
    base: &str,
    model_aliases: &[String],
    tab_idx: Option<usize>,
) -> (String, Option<usize>) {
    // Argument completion: `/plan `, `/swarm `, `/thinking `, `/model `,
    // `/permission `, `/session `, `/goal `, plus filesystem paths.
    if let Some((cmd, arg)) = base.split_once(' ') {
        let next = match cmd {
            "/plan" | "/swarm" => complete_from(cmd, arg, ON_OFF_ARGS, tab_idx),
            "/thinking" => complete_from(cmd, arg, THINKING_ARGS, tab_idx),
            "/permission" => complete_from(cmd, arg, PERMISSION_ARGS, tab_idx),
            "/session" => complete_from(cmd, arg, &["set"], tab_idx),
            "/goal" => complete_from(cmd, arg, GOAL_ARGS, tab_idx),
            "/model" => complete_model_arg(arg, model_aliases, tab_idx),
            // Any path-like argument falls through to filesystem completion.
            _ => complete_path(arg, tab_idx),
        };
        return next.map_or((base.to_string(), None), |(s, i)| (s, Some(i)));
    }
    // Command-name completion while typing `/…`.
    if base.starts_with('/') {
        let matches: Vec<&&str> = SLASH_COMMANDS.iter().filter(|c| c.starts_with(base)).collect();
        if matches.is_empty() {
            return (base.to_string(), None);
        }
        let idx = tab_idx.map_or(0, |i| (i + 1) % matches.len());
        return ((*matches[idx]).to_string(), Some(idx));
    }
    (base.to_string(), None)
}

/// Cycle through a closed argument set (`on|off`, `low|medium|high`, …).
pub fn complete_from(
    cmd: &str,
    arg: &str,
    options: &[&str],
    tab_idx: Option<usize>,
) -> Option<(String, usize)> {
    let matches: Vec<&str> = options.iter().copied().filter(|o| o.starts_with(arg)).collect();
    if matches.is_empty() {
        return None;
    }
    let idx = tab_idx.map_or(0, |i| (i + 1) % matches.len());
    Some((format!("{cmd} {}", matches[idx]), idx))
}

/// Cycle through live model aliases for `/model <prefix>`.
pub fn complete_model_arg(
    prefix: &str,
    model_aliases: &[String],
    tab_idx: Option<usize>,
) -> Option<(String, usize)> {
    if model_aliases.is_empty() {
        return None;
    }
    let matches: Vec<&String> = model_aliases.iter().filter(|a| a.starts_with(prefix)).collect();
    if matches.is_empty() {
        return None;
    }
    let idx = tab_idx.map_or(0, |i| (i + 1) % matches.len());
    Some(((*matches[idx]).clone(), idx))
}

// ── Filesystem path completion ─────────────────────────────────────────

/// The user's home directory (USERPROFILE on Windows, HOME elsewhere).
fn home_dir() -> Option<String> {
    let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var(key).ok().filter(|h| !h.is_empty())
}

/// Whether `arg` looks like a path (empty, `.`/`..`, or contains a `/` or
/// starts with `~`) — the trigger for filesystem completion.
fn is_path_like(arg: &str) -> bool {
    arg.is_empty()
        || arg == "."
        || arg == ".."
        || arg.starts_with("./")
        || arg.starts_with("../")
        || arg.starts_with('/')
        || arg.starts_with('~')
        || arg.contains('/')
}

/// Complete a filesystem path argument (`~` expands; directories get a
/// trailing `/`). Returns the completed argument and the next cycle index.
pub fn complete_path(arg: &str, tab_idx: Option<usize>) -> Option<(String, usize)> {
    if !is_path_like(arg) {
        return None;
    }
    let expanded = if arg == "~" {
        format!("{}/", home_dir()?)
    } else if let Some(rest) = arg.strip_prefix("~/") {
        format!("{}/{rest}", home_dir()?)
    } else {
        arg.to_string()
    };
    let (dir, partial) = match expanded.rfind('/') {
        Some(i) => (expanded[..=i].to_string(), expanded[i + 1..].to_string()),
        None => (String::new(), expanded.clone()),
    };
    let entries: Vec<String> = std::fs::read_dir(&dir)
        .ok()?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.starts_with(&partial) {
                return None;
            }
            // Hidden files only when the partial explicitly asks for them.
            if name.starts_with('.') && !partial.starts_with('.') {
                return None;
            }
            let is_dir = e.path().is_dir();
            Some(if is_dir { format!("{name}/") } else { name })
        })
        .collect();
    if entries.is_empty() {
        return None;
    }
    let idx = tab_idx.map_or(0, |i| (i + 1) % entries.len());
    Some((format!("{dir}{}", entries[idx]), idx))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completes_command_names_and_cycles() {
        // `/s` matches `/session` (first by order) — Tab cycles onward.
        let (done, idx) = complete_line("/s", &[], None);
        assert_eq!(done, "/session", "{done}");
        let (done2, idx2) = complete_line("/s", &[], idx);
        assert!(done2.starts_with('/'), "{done2}");
        assert_ne!(done2, done, "cycle advances");
        assert!(idx2.is_some());
    }

    #[test]
    fn completes_closed_argument_sets() {
        let (done, _) = complete_line("/plan ", &[], None);
        assert_eq!(done, "/plan on");
        let (done, _) = complete_line("/thinking l", &[], None);
        assert_eq!(done, "/thinking low");
        // `/permission` modes and the `/session` subcommand.
        let (done, _) = complete_line("/permission a", &[], None);
        assert_eq!(done, "/permission auto");
        let (done, _) = complete_line("/session ", &[], None);
        assert_eq!(done, "/session set");
        let (done, _) = complete_line("/swarm o", &[], None);
        assert_eq!(done, "/swarm on");
        // `/goal` subcommands (TS registry parity).
        let (done, _) = complete_line("/goal p", &[], None);
        assert_eq!(done, "/goal pause");
        let (done, _) = complete_line("/goal c", &[], None);
        assert_eq!(done, "/goal cancel");
        let (done, _) = complete_line("/goal status", &[], None);
        assert_eq!(done, "/goal status");
    }

    #[test]
    fn completes_model_aliases() {
        let aliases = vec!["kimi-k2".to_string(), "kimi-k2-thinking".to_string()];
        let (done, _) = complete_line("/model kimi-k2", &aliases, None);
        assert_eq!(done, "kimi-k2", "{done}");
        let (done, _) = complete_line("/model kimi", &aliases, None);
        assert_eq!(done, "kimi-k2", "{done}");
    }

    #[test]
    fn editing_helpers_roundtrip() {
        let (out, cur) = insert_char("he", 2, 'y');
        assert_eq!((out.as_str(), cur), ("hey", 3));
        let (out, cur) = backspace(&out, cur);
        assert_eq!((out.as_str(), cur), ("he", 2));
        assert_eq!(delete_forward("abc", 0), "bc");
        assert_eq!(move_cursor("abc", 0, 1), 1);
        let (out, _) = kill_word("hello world", 11);
        assert_eq!(out, "hello ");
    }

    #[test]
    fn multiline_cursor_navigates_lines() {
        // "ab\ncd\nef" — cursor at index 3 ('c').
        let input = "ab\ncd\nef";
        assert_eq!(cursor_line_col(input, 3), (1, 0));
        // Up from (1,0) → (0,0).
        assert_eq!(move_cursor_vert(input, 3, -1), 0);
        // Down from (1,0) → (2,0) = 'e' (index 6).
        assert_eq!(move_cursor_vert(input, 3, 1), 6);
        // Up from the first line is a no-op.
        assert_eq!(move_cursor_vert(input, 1, -1), 0);
        // Down from the last line lands at the end.
        assert_eq!(move_cursor_vert(input, 5, 1), 8);
    }

    #[test]
    fn multiline_cursor_clamps_to_line_end() {
        // "ab\ncd\nef" — cursor at index 5 ('e'), col 0.
        // Up to line 0 (len 2) clamps to index 2.
        assert_eq!(move_cursor_vert("ab\ncd\nef", 5, -1), 2);
        // Down to line 1 col 1 clamps to 'd' (index 4).
        assert_eq!(move_cursor_vert("ab\ncd\nef", 1, 1), 4);
    }

    #[test]
    fn newline_insert_and_delete_roundtrip() {
        let (out, cur) = insert_char("ab", 1, '\n');
        assert_eq!((out.as_str(), cur), ("a\nb", 2));
        assert_eq!(cursor_line_col(&out, cur), (1, 0));
        let (out2, cur2) = backspace(&out, cur);
        assert_eq!((out2.as_str(), cur2), ("ab", 1));
    }

    #[test]
    fn completes_filesystem_paths() {
        // A temp dir with known entries; non-path args are left alone.
        let dir = std::env::temp_dir().join(format!("kimi-tab-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("alpha")).unwrap();
        std::fs::create_dir_all(dir.join("beta")).unwrap();
        std::fs::write(dir.join("alpha.txt"), b"x").unwrap();
        std::fs::write(dir.join(".hidden"), b"x").unwrap();

        let prefix = format!("{}/al", dir.display());
        let (done, _idx) = complete_path(&prefix, None).expect("completes");
        assert!(done.ends_with("alpha/") || done.ends_with("alpha.txt"), "done: {done}");

        // Directory listing when the arg ends with a slash.
        let prefix = format!("{}/", dir.display());
        let (done, _) = complete_path(&prefix, None).expect("completes dir");
        assert!(done.starts_with(&prefix), "done: {done}");

        // Hidden files are skipped unless requested.
        let prefix = format!("{}/.", dir.display());
        let (done, _) = complete_path(&prefix, None).expect("completes hidden");
        assert!(done.contains(".hidden"), "done: {done}");

        // Non-path args do not trigger.
        assert!(complete_path("plain-arg", None).is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
