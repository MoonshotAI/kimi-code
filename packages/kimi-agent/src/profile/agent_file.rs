//! Agent-file parsing — Markdown files with YAML frontmatter that define
//! custom agents (main or sub-agent).
//!
//! Corresponds to upstream `agent-core-v2/src/app/agentFileCatalog/agentFile.ts`
//! (#2232 / #2365). Pure functions with no IO: callers read the file text and
//! pass it in. Unknown frontmatter fields are ignored so later format
//! extensions stay forward-compatible. Compatibility conventions match other
//! agent CLIs: a missing `name` falls back to the file name (OpenCode), a
//! lone `*` in `tools` / `subagents` means unrestricted like an omitted
//! field, and list fields accept either a bare comma-separated string or the
//! YAML list form (Claude Code).

use serde::Serialize;

/// Source of an agent file (upstream `AgentFileSource`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentFileSource {
    Plugin,
    Project,
    User,
    Extra,
    Explicit,
}

/// A parsed agent Markdown file (upstream `AgentFileDefinition`).
#[derive(Debug, Clone, Serialize)]
pub struct AgentFileDefinition {
    pub name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub when_to_use: Option<String>,
    #[serde(default)]
    pub override_builtin: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disallowed_tools: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subagents: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_preference: Option<ModelPreference>,
    pub prompt: String,
    pub path: String,
    pub source: AgentFileSource,
}

/// Primary / secondary model preference for an agent file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelPreference {
    Primary,
    Secondary,
}

const AGENT_NAME_PATTERN: &str = r"^[a-z0-9]+(?:-[a-z0-9]+)*$";

/// Parse a single agent Markdown file (frontmatter + body).
pub fn parse_agent_file(
    path: &str,
    source: AgentFileSource,
    text: &str,
) -> Result<AgentFileDefinition, String> {
    let (frontmatter, body) = split_frontmatter(path, text)?;
    let fields = parse_frontmatter_fields(path, frontmatter)?;

    let name = match fields.get("name") {
        Some(Value::Str(name)) if !name.trim().is_empty() => name.trim().to_string(),
        Some(_) => return Err(field_error(path, "name", "must be a non-empty string")),
        None => derive_name_from_path(path).ok_or_else(|| {
            format!("Missing required frontmatter field \"name\" in {path}")
        })?,
    };
    if !regex::Regex::new(AGENT_NAME_PATTERN)
        .map(|re| re.is_match(&name))
        .unwrap_or(false)
    {
        return Err(format!(
            "Invalid agent name \"{name}\" in {path}: expected kebab-case (e.g. \"code-reviewer\")"
        ));
    }

    let description = required_string(fields.get("description"), path, "description")?;
    let when_to_use = optional_string(fields.get("whenToUse"), path, "whenToUse")?;
    let override_builtin = parse_bool(fields.get("override"), path, "override")?;
    let tools = parse_string_list(fields.get("tools"), path, "tools")?;
    let tools = collapse_star(tools);
    let disallowed_tools = collapse_star(parse_string_list(
        fields.get("disallowedTools"),
        path,
        "disallowedTools",
    )?);
    let subagents = collapse_star(parse_string_list(fields.get("subagents"), path, "subagents")?);
    let model_preference = parse_model_preference(fields.get("model_preference"), path)?;

    let prompt = body.trim();
    if prompt.is_empty() {
        return Err(format!("Missing prompt body in {path}"));
    }

    Ok(AgentFileDefinition {
        name,
        description,
        when_to_use,
        override_builtin,
        tools,
        disallowed_tools,
        subagents,
        model_preference,
        prompt: prompt.to_string(),
        path: path.to_string(),
        source,
    })
}

/// Split a document into (frontmatter, body). The document must start with a
/// `---` fence; a missing fence is an error (upstream requires frontmatter).
fn split_frontmatter<'a>(path: &str, text: &'a str) -> Result<(&'a str, &'a str), String> {
    let body = text.strip_prefix("---\n").or_else(|| text.strip_prefix("---\r\n"));
    let Some(body) = body else {
        return Err(format!("Missing frontmatter in {path}"));
    };
    let end = body
        .find("\n---")
        .or_else(|| body.find("\r\n---"))
        .ok_or_else(|| format!("Unterminated frontmatter in {path}"))?;
    let frontmatter = &body[..end];
    let after = body[end..]
        .strip_prefix("\n---")
        .or_else(|| body[end..].strip_prefix("\r\n---"))
        .unwrap_or("");
    let after = after.strip_prefix('\n').unwrap_or(after);
    Ok((frontmatter, after))
}

/// A minimal parsed frontmatter value — the YAML subset agent files use.
#[derive(Debug, Clone, PartialEq)]
enum Value {
    Str(String),
    Bool(bool),
    List(Vec<String>),
}

/// Parse the frontmatter block (simple `key: value` lines plus `- item` list
/// entries) into a map. Unknown keys are kept so callers can ignore them.
fn parse_frontmatter_fields(
    path: &str,
    frontmatter: &str,
) -> Result<std::collections::HashMap<String, Value>, String> {
    let mut map = std::collections::HashMap::new();
    let mut current_list: Option<(String, Vec<String>)> = None;

    for (idx, raw_line) in frontmatter.lines().enumerate() {
        let line = raw_line.trim_end_matches('\r');
        if line.trim().is_empty() {
            continue;
        }
        // List continuation: `- item` (possibly indented).
        let trimmed = line.trim_start();
        if let Some(item) = trimmed.strip_prefix('-') {
            let item = item.trim();
            if item.is_empty() {
                return Err(frontmatter_line_error(path, idx + 1, "empty list item"));
            }
            if let Some((_, ref mut items)) = current_list {
                items.push(strip_quotes(item).to_string());
                continue;
            }
            return Err(frontmatter_line_error(
                path,
                idx + 1,
                "list item without a preceding key",
            ));
        }
        // A non-list line closes any pending list and commits it.
        if let Some((key, items)) = current_list.take() {
            if !items.is_empty() {
                map.insert(key, Value::List(items));
            }
        }
        let Some((key, value)) = line.split_once(':') else {
            return Err(frontmatter_line_error(
                path,
                idx + 1,
                "expected \"key: value\"",
            ));
        };
        let key = key.trim();
        if key.is_empty() {
            return Err(frontmatter_line_error(path, idx + 1, "empty key"));
        }
        let value = value.trim();
        if value.is_empty() {
            // May be a following list.
            current_list = Some((key.to_string(), Vec::new()));
            continue;
        }
        let parsed = parse_scalar(value)
            .ok_or_else(|| frontmatter_line_error(path, idx + 1, "unsupported value"))?;
        map.insert(key.to_string(), parsed);
    }

    // Commit a trailing list left open at the end of the block.
    if let Some((key, items)) = current_list {
        if !items.is_empty() {
            map.insert(key, Value::List(items));
        }
    }
    Ok(map)
}

/// Parse a single scalar value: quoted string, bool, or bare string.
fn parse_scalar(value: &str) -> Option<Value> {
    if value == "true" {
        return Some(Value::Bool(true));
    }
    if value == "false" {
        return Some(Value::Bool(false));
    }
    Some(Value::Str(strip_quotes(value).to_string()))
}

fn strip_quotes(value: &str) -> &str {
    let value = value.trim();
    if (value.starts_with('"') && value.ends_with('"'))
        || (value.starts_with('\'') && value.ends_with('\''))
    {
        &value[1..value.len() - 1]
    } else {
        value
    }
}

fn field_error(path: &str, field: &str, message: &str) -> String {
    format!("Frontmatter field \"{field}\" in {path} {message}")
}

fn frontmatter_line_error(path: &str, line: usize, message: &str) -> String {
    format!("Invalid frontmatter in {path} at line {line}: {message}")
}

fn required_string(
    value: Option<&Value>,
    path: &str,
    field: &str,
) -> Result<String, String> {
    match value {
        Some(Value::Str(s)) if !s.trim().is_empty() => Ok(s.trim().to_string()),
        Some(_) => Err(field_error(path, field, "must be a non-empty string")),
        None => Err(format!(
            "Missing required frontmatter field \"{field}\" in {path}"
        )),
    }
}

fn optional_string(
    value: Option<&Value>,
    path: &str,
    field: &str,
) -> Result<Option<String>, String> {
    match value {
        None => Ok(None),
        Some(Value::Str(s)) if !s.trim().is_empty() => Ok(Some(s.trim().to_string())),
        Some(_) => Err(field_error(path, field, "must be a non-empty string")),
    }
}

fn parse_bool(value: Option<&Value>, path: &str, field: &str) -> Result<bool, String> {
    match value {
        None => Ok(false),
        Some(Value::Bool(b)) => Ok(*b),
        Some(_) => Err(field_error(path, field, "must be a boolean")),
    }
}

fn parse_string_list(
    value: Option<&Value>,
    path: &str,
    field: &str,
) -> Result<Option<Vec<String>>, String> {
    match value {
        None => Ok(None),
        Some(Value::Str(s)) => Ok(Some(
            s.split(',')
                .map(|item| item.trim())
                .filter(|item| !item.is_empty())
                .map(|item| item.to_string())
                .collect(),
        )),
        Some(Value::List(items)) => {
            if items.iter().any(|item| item.trim().is_empty()) {
                return Err(field_error(path, field, "must be a list of non-empty strings"));
            }
            Ok(Some(items.clone()))
        }
        Some(Value::Bool(_)) => Err(field_error(
            path,
            field,
            "must be a comma-separated string or a list of strings",
        )),
    }
}

/// A lone `*` in a list field means unrestricted (same as omitting it).
fn collapse_star(list: Option<Vec<String>>) -> Option<Vec<String>> {
    match list {
        Some(ref items) if items.len() == 1 && items[0] == "*" => None,
        other => other,
    }
}

fn parse_model_preference(
    value: Option<&Value>,
    path: &str,
) -> Result<Option<ModelPreference>, String> {
    match value {
        None => Ok(None),
        Some(Value::Str(s)) if s == "primary" => Ok(Some(ModelPreference::Primary)),
        Some(Value::Str(s)) if s == "secondary" => Ok(Some(ModelPreference::Secondary)),
        Some(_) => Err(field_error(
            path,
            "model_preference",
            "must be \"primary\" or \"secondary\"",
        )),
    }
}

/// Derive an agent name from the file path (OpenCode convention): the file
/// stem, kebab-cased.
fn derive_name_from_path(path: &str) -> Option<String> {
    let stem = std::path::Path::new(path)
        .file_stem()?
        .to_string_lossy()
        .to_lowercase();
    let mut out = String::new();
    let mut prev_dash = false;
    for c in stem.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    let name = out.trim_matches('-').to_string();
    if name.is_empty() { None } else { Some(name) }
}

/// Discover agent files under the given roots, parsing each Markdown file
/// (upstream `discoverAgentFiles`). Files that fail to parse are reported in
/// `skipped` rather than aborting the scan. Directory traversal follows
/// symlinks, mirroring the upstream discovery over `.md` files.
pub fn discover_agent_files(
    roots: &[&str],
    source: AgentFileSource,
) -> (Vec<AgentFileDefinition>, Vec<(String, String)>) {
    let mut agents = Vec::new();
    let mut skipped = Vec::new();
    for root in roots {
        let Ok(entries) = std::fs::read_dir(root) else {
            skipped.push((root.to_string(), "directory unreadable".to_string()));
            continue;
        };
        let mut paths: Vec<std::path::PathBuf> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.is_file() && p.extension().map_or(false, |x| x == "md"))
            .collect();
        paths.sort();
        for path in paths {
            let path_str = path.to_string_lossy().to_string();
            match std::fs::read_to_string(&path) {
                Ok(text) => match parse_agent_file(&path_str, source, &text) {
                    Ok(def) => agents.push(def),
                    Err(reason) => skipped.push((path_str, reason)),
                },
                Err(e) => skipped.push((path_str, format!("unreadable: {e}"))),
            }
        }
    }
    (agents, skipped)
}

#[cfg(test)]
mod tests {
    use super::*;

    const AGENT_MD: &str = "---\n\
name: code-reviewer\n\
description: Reviews code for quality\n\
whenToUse: When the user asks for a review\n\
override: true\n\
tools: read, grep, edit\n\
subagents:\n  - explorer\nmodel_preference: secondary\n\
---\n\
You are a code reviewer. Always review.\n";

    #[test]
    fn parses_full_agent_file() {
        let def = parse_agent_file("/tmp/agents/code-reviewer.md", AgentFileSource::User, AGENT_MD)
            .expect("parse");
        assert_eq!(def.name, "code-reviewer");
        assert_eq!(def.description, "Reviews code for quality");
        assert_eq!(def.when_to_use.as_deref(), Some("When the user asks for a review"));
        assert!(def.override_builtin);
        assert_eq!(def.tools.as_deref(), Some(&["read".to_string(), "grep".to_string(), "edit".to_string()][..]));
        assert_eq!(def.subagents.as_deref(), Some(&["explorer".to_string()][..]));
        assert_eq!(def.model_preference, Some(ModelPreference::Secondary));
        assert_eq!(def.prompt, "You are a code reviewer. Always review.");
        assert_eq!(def.source, AgentFileSource::User);
    }

    #[test]
    fn star_in_tools_means_unrestricted() {
        let text = "---\nname: x\ndescription: d\ntools: '*'\n---\nbody\n";
        let def = parse_agent_file("/tmp/x.md", AgentFileSource::Project, text).expect("parse");
        assert_eq!(def.tools, None);
    }

    #[test]
    fn missing_name_falls_back_to_file_stem() {
        let text = "---\ndescription: d\n---\nbody\n";
        let def = parse_agent_file("/tmp/agents/my-reviewer.md", AgentFileSource::Plugin, text)
            .expect("parse");
        assert_eq!(def.name, "my-reviewer");
        assert_eq!(def.source, AgentFileSource::Plugin);
    }

    #[test]
    fn rejects_bad_name_and_missing_body() {
        let err = parse_agent_file("/tmp/Uppercase.md", AgentFileSource::User, "---\nname: Bad Name\ndescription: d\n---\nbody\n")
            .expect_err("bad name");
        assert!(err.contains("kebab-case"));

        let err = parse_agent_file("/tmp/x.md", AgentFileSource::User, "---\nname: x\ndescription: d\n---\n   \n")
            .expect_err("empty body");
        assert!(err.contains("prompt body"));
    }

    #[test]
    fn missing_frontmatter_is_an_error() {
        let err = parse_agent_file("/tmp/x.md", AgentFileSource::User, "# no frontmatter")
            .expect_err("missing frontmatter");
        assert!(err.contains("Missing frontmatter"));
    }

    #[test]
    fn discover_scans_roots_and_reports_skipped() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("ok.md"), "---\nname: alpha\ndescription: d\n---\nbody\n")
            .unwrap();
        std::fs::write(
            dir.path().join("bad.md"),
            "---\nname: Bad Name\ndescription: d\n---\nbody\n",
        )
        .unwrap();
        std::fs::write(dir.path().join("not-agent.txt"), "ignored").unwrap();

        let root = dir.path().to_str().unwrap().to_string();
        let (agents, skipped) = discover_agent_files(&[&root], AgentFileSource::User);
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].name, "alpha");
        assert_eq!(skipped.len(), 1);
        assert!(skipped[0].0.ends_with("bad.md"));
    }
}
