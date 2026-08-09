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
    ("/q", "tui.cmd.quit"),
    ("/exit", "tui.cmd.exit"),
    ("/help", "tui.cmd.help"),
    ("/h", "tui.cmd.help"),
    ("/?", "tui.cmd.help"),
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
    ("/effort", "tui.cmd.thinking"),
    ("/permission", "tui.cmd.permission"),
    ("/yolo", "tui.cmd.yolo"),
    ("/yes", "tui.cmd.yolo"),
    ("/auto", "tui.cmd.auto"),
    ("/new", "tui.cmd.new"),
    ("/init", "tui.cmd.init"),
    ("/title", "tui.cmd.title"),
    ("/rename", "tui.cmd.title"),
    ("/mcp", "tui.cmd.mcp"),
    ("/tasks", "tui.cmd.tasks"),
    ("/task", "tui.cmd.tasks"),
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
    ("/btw", "tui.cmd.btw"),
    ("/endbtw", "tui.cmd.endbtw"),
    ("/login", "tui.cmd.login"),
    ("/logout", "tui.cmd.logout"),
    ("/disconnect", "tui.cmd.logout"),
    ("/locale", "tui.cmd.locale"),
    ("/editor", "tui.cmd.editor"),
    ("/settings", "tui.cmd.settings"),
    ("/copy", "tui.cmd.copy"),
    ("/export-md", "tui.cmd.export-md"),
    ("/discuss", "tui.cmd.discuss"),
    ("/workflow", "tui.cmd.workflow"),
    ("/provider", "tui.cmd.provider"),
    ("/providers", "tui.cmd.provider"),
    ("/experiments", "tui.cmd.experiments"),
    ("/multi-llm", "tui.cmd.multi-llm"),
    ("/feedback", "tui.cmd.feedback"),
    ("/web", "tui.cmd.web"),
    ("/reload-tui", "tui.cmd.reload-tui"),
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
    "/add-dir",
    "/approvals",
    "/approve",
    "/archive",
    "/auto",
    "/btw",
    "/clear",
    "/compact",
    "/config",
    "/deny",
    "/endbtw",
    "/exit",
    "/export",
    "/fork",
    "/goal",
    "/goal-cancel",
    "/goal-pause",
    "/goal-resume",
    "/goal-status",
    "/help",
    "/h",
    "/?",
    "/import",
    "/info",
    "/init",
    "/locale",
    "/login",
    "/logout",
    "/disconnect",
    "/mcp",
    "/model",
    "/models",
    "/new",
    "/permission",
    "/plan",
    "/plugins",
    "/quit",
    "/q",
    "/reload",
    "/resume",
    "/session",
    "/sessions",
    "/settings",
    "/skills",
    "/status",
    "/steer",
    "/swarm",
    "/tasks",
    "/task",
    "/theme",
    "/thinking",
    "/effort",
    "/title",
    "/rename",
    "/undo",
    "/usage",
    "/version",
    "/yolo",
    "/yes",
    "/editor",
    "/copy",
    "/export-md",
    "/discuss",
    "/workflow",
    "/provider",
    "/providers",
    "/reload-tui",
];

// ── Input editing (char-index based) ────────────────────────────────────

/// Byte offset of the `cursor`-th char (clamped to the string end).
fn byte_of_char(input: &str, cursor: usize) -> usize {
    input
        .char_indices()
        .nth(cursor)
        .map_or(input.len(), |(i, _)| i)
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
/// The dim argument hint shown right after `/cmd ` while the argument is
/// still empty (TS custom-editor `computeArgumentHint` parity): the closed
/// argument set for commands that have one, model aliases for `/model `.
/// Returns `None` outside a command argument (or once the user typed one).
pub fn argument_hint(input: &str, model_aliases: &[String]) -> Option<String> {
    let (cmd, arg) = input.split_once(' ')?;
    if !arg.is_empty() {
        return None;
    }
    let joined = match cmd {
        "/plan" | "/swarm" => ON_OFF_ARGS.join("|"),
        "/thinking" => THINKING_ARGS.join("|"),
        "/permission" => PERMISSION_ARGS.join("|"),
        "/goal" => GOAL_ARGS.join("|"),
        "/session" => "set".to_string(),
        "/model" => model_aliases.join("|"),
        _ => return None,
    };
    Some(joined)
}

/// History entries matching the current input mode: bash drafts
/// (`!`-prefixed) recall only `!`-prefixed entries (TS editor
/// history-filter parity). Plain drafts see the whole history.
pub fn filtered_history<'a>(history: &'a [String], bash: bool) -> Vec<&'a String> {
    history
        .iter()
        .filter(|h| !bash || h.starts_with('!'))
        .collect()
}

pub fn complete_line(
    base: &str,
    model_aliases: &[String],
    tab_idx: Option<usize>,
) -> (String, Option<usize>) {
    // @mention takes priority (TS file-mention parity: typing `@` inside a
    // slash command's argument text — e.g. `/goal Fix the @checkout` — must
    // complete files, not the command's argument set). The token is replaced
    // in place; the rest of the input is preserved.
    if let Some(token) = at_mention_token(base) {
        if let Some((done, i)) = complete_mention(token, tab_idx) {
            let head = &base[..base.len() - token.len()];
            return (format!("{head}{done}"), Some(i));
        }
    }
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
        let matches: Vec<&&str> = SLASH_COMMANDS
            .iter()
            .filter(|c| c.starts_with(base))
            .collect();
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
    let matches: Vec<&str> = options
        .iter()
        .copied()
        .filter(|o| o.starts_with(arg))
        .collect();
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
) -> Option<(String, usize)> {    if model_aliases.is_empty() {
        return None;
    }
    let matches: Vec<&String> = model_aliases
        .iter()
        .filter(|a| a.starts_with(prefix))
        .collect();
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
    let entries = fs_entries(&dir, &partial)?;
    let idx = tab_idx.map_or(0, |i| (i + 1) % entries.len());
    Some((format!("{dir}{}", entries[idx]), idx))
}

/// Directory entries under `dir` whose name starts with `partial` (hidden
/// files only when `partial` explicitly asks for them; directories get a
/// trailing `/` so a completed directory can be extended with the next `/`).
fn fs_entries(dir: &str, partial: &str) -> Option<Vec<String>> {
    let entries: Vec<String> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.starts_with(partial) {
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
    (!entries.is_empty()).then_some(entries)
}

/// The last whitespace-delimited token when it starts with `@` — the
/// @mention trigger (TS `extractAtPrefix` parity: the token spans path
/// separators, so `@src/main` is one token).
fn at_mention_token(base: &str) -> Option<&str> {
    let token = base.split_whitespace().next_back()?;
    token.starts_with('@').then_some(token)
}

/// Complete an `@token` file mention against the current directory (TS
/// file-mention parity: directories get a trailing `/` so the next Tab
/// extends the path, paths containing spaces are quoted `@"…"`). Returns
/// the full `@…` replacement and the next cycle index, or `None` when no
/// entry matches.
pub fn complete_mention(token: &str, tab_idx: Option<usize>) -> Option<(String, usize)> {
    let query = &token[1..];
    let (dir, partial) = match query.rfind(['/', '\\']) {
        Some(i) => (query[..=i].to_string(), query[i + 1..].to_string()),
        None => (String::new(), query.to_string()),
    };
    let entries = fs_entries(&dir, &partial)?;
    let idx = tab_idx.map_or(0, |i| (i + 1) % entries.len());
    let path = format!("{dir}{}", entries[idx]);
    let done = if path.contains(' ') {
        format!("@\"{path}\"")
    } else {
        format!("@{path}")
    };
    Some((done, idx))
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
    fn aliases_appear_in_completion() {
        // Alias entries are listed with the canonical command's description
        // (TS registry `aliases` parity — the popup offers both spellings).
        let descs = command_descriptions();
        for alias in [
            "/h", "/?", "/q", "/yes", "/rename", "/task", "/effort", "/providers",
            "/disconnect",
        ] {
            let (_, desc) = descs
                .iter()
                .find(|(name, _)| name == alias)
                .unwrap_or_else(|| panic!("alias {alias} missing from descriptions"));
            assert!(!desc.is_empty(), "alias {alias} desc empty");
        }
        // Tab completion expands aliases to the canonical name.
        let (done, _) = complete_line("/q", &[], None);
        assert_eq!(done, "/quit");
        let (done, _) = complete_line("/provid", &[], None);
        assert_eq!(done, "/provider");
    }

    #[test]
    fn btw_commands_are_registered() {
        // `/btw` and `/endbtw` appear in Tab completion and carry a
        // description (the side-question agent surface).
        let descs = command_descriptions();
        for command in ["/btw", "/endbtw"] {
            assert!(
                SLASH_COMMANDS.contains(&command),
                "{command} missing from SLASH_COMMANDS"
            );
            let (_, desc) = descs
                .iter()
                .find(|(name, _)| name == command)
                .unwrap_or_else(|| panic!("{command} missing from descriptions"));
            assert!(!desc.is_empty(), "{command} desc empty");
        }
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
        assert!(
            done.ends_with("alpha/") || done.ends_with("alpha.txt"),
            "done: {done}"
        );

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

    #[test]
    fn completes_at_mentions() {
        // A temp dir with known entries; `@` mention completes file paths
        // (TS file-mention parity).
        let dir = std::env::temp_dir().join(format!("kimi-mention-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("main.rs"), b"fn main() {}").unwrap();
        std::fs::write(dir.join(".hidden"), b"x").unwrap();
        let root = dir.to_string_lossy().to_string();

        // File completion via the last token.
        let token = format!("@{root}/main");
        let (done, idx) = complete_line(&token, &[], None);
        assert_eq!(done, format!("@{root}/main.rs"), "done: {done}");
        assert!(idx.is_some());

        // Directory candidates carry a trailing `/` so the next Tab extends.
        let token = format!("@{root}/s");
        let (done, _) = complete_line(&token, &[], None);
        assert_eq!(done, format!("@{root}/sub/"), "done: {done}");

        // Hidden files are skipped unless requested.
        let token = format!("@{root}/.");
        let (done, _) = complete_line(&token, &[], None);
        assert!(done.contains(".hidden"), "done: {done}");

        // Mention takes priority over slash-command argument completion
        // (TS parity: `@` inside argument text completes files).
        let input = format!("/goal fix the @{root}/main");
        let (done, _) = complete_line(&input, &[], None);
        assert_eq!(done, format!("/goal fix the @{root}/main.rs"), "done: {done}");

        // A bare `@` with no match is left alone (no crash, no fallback).
        let (done, _) = complete_line(&format!("@{root}/nope"), &[], None);
        assert_eq!(done, format!("@{root}/nope"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn mention_paths_with_spaces_are_quoted() {
        let dir = std::env::temp_dir().join(format!("kimi-mention-sp-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("my dir")).unwrap();
        let root = dir.to_string_lossy().to_string();
        let (done, _) = complete_line(&format!("@{root}/my"), &[], None);
        // Directory completion keeps the trailing `/`; spaces quote the path.
        assert_eq!(done, format!("@\"{root}/my dir/\""), "done: {done}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn argument_hint_shows_closed_sets_after_command() {
        let aliases = vec!["kimi-k2".to_string(), "kimi-k2-thinking".to_string()];
        // Empty argument right after `/cmd ` shows the set.
        assert_eq!(
            argument_hint("/permission ", &aliases).as_deref(),
            Some("manual|plan|auto|yolo")
        );
        assert_eq!(
            argument_hint("/thinking ", &aliases).as_deref(),
            Some("low|medium|high")
        );
        assert_eq!(
            argument_hint("/model ", &aliases).as_deref(),
            Some("kimi-k2|kimi-k2-thinking")
        );
        assert_eq!(
            argument_hint("/goal ", &aliases).as_deref(),
            Some("status|pause|resume|cancel|replace|next")
        );
        // Once an argument is typed the hint disappears.
        assert_eq!(argument_hint("/permission m", &aliases), None);
        // Unknown commands / plain text have no hint.
        assert_eq!(argument_hint("/zzz ", &aliases), None);
        assert_eq!(argument_hint("hello ", &aliases), None);
        assert_eq!(argument_hint("/permission", &aliases), None);
    }

    #[test]
    fn filtered_history_recalls_bash_entries_only_in_bash_mode() {
        let history = vec![
            "plain prompt".to_string(),
            "!git status".to_string(),
            "another prompt".to_string(),
            "!ls".to_string(),
        ];
        // Bash drafts see only `!` entries, in order.
        let bash = filtered_history(&history, true);
        assert_eq!(bash.len(), 2);
        assert_eq!(bash[0].as_str(), "!git status");
        assert_eq!(bash[1].as_str(), "!ls");
        // Plain drafts see everything.
        let all = filtered_history(&history, false);
        assert_eq!(all.len(), 4);
        // Empty history never panics.
        assert!(filtered_history(&[], true).is_empty());
    }
}
