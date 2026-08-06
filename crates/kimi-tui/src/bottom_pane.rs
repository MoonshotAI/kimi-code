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

/// Command names for `/…` Tab completion.
pub const SLASH_COMMANDS: &[&str] = &[
    "/add-dir", "/approvals", "/approve", "/archive", "/auto", "/clear", "/compact", "/config",
    "/deny", "/exit", "/export", "/fork", "/goal", "/goal-cancel", "/goal-pause", "/goal-resume",
    "/goal-status", "/help", "/import", "/info", "/init", "/mcp", "/model", "/models", "/new",
    "/permission", "/plan", "/plugins", "/quit", "/reload", "/resume", "/session", "/sessions",
    "/skills", "/status", "/steer", "/swarm", "/tasks", "/theme", "/thinking", "/title", "/undo",
    "/usage", "/version", "/yolo",
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
    // `/permission `, `/session `.
    if let Some((cmd, arg)) = base.split_once(' ') {
        let next = match cmd {
            "/plan" | "/swarm" => complete_from(cmd, arg, ON_OFF_ARGS, tab_idx),
            "/thinking" => complete_from(cmd, arg, THINKING_ARGS, tab_idx),
            "/permission" => complete_from(cmd, arg, PERMISSION_ARGS, tab_idx),
            "/session" => complete_from(cmd, arg, &["set"], tab_idx),
            "/model" => complete_model_arg(arg, model_aliases, tab_idx),
            _ => None,
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
}
