//! Workspace/user skill discovery — local port of the node-sdk
//! `discoverSkills` (rust/rpc-client.ts). Reads `*/SKILL.md` bundles from
//! `<work_dir>/.kimi-code/skills` (project) and `<KIMI_CODE_HOME>/skills`
//! (user); project wins on a same-name collision; results are name-sorted.
//!
//! The frontmatter parser handles the flat `key: value` subset SKILL.md
//! bundles use in practice (name / description / disable_model_invocation,
//! with quote stripping and booleans). Block scalars (`|`) are not parsed —
//! matching the simple flat shape of the in-repo bundles.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// A discovered skill bundle (node-sdk `SkillSummary` parity).
#[derive(Debug, Clone)]
pub struct SkillSummary {
    pub name: String,
    pub description: String,
    /// `"project"` or `"user"`.
    pub source: String,
    /// Absolute path of the bundle's `SKILL.md`.
    pub path: String,
    pub disable_model_invocation: Option<bool>,
}

struct SkillFrontmatter {
    name: String,
    description: String,
    disable_model_invocation: Option<bool>,
}

/// Skills visible to a new session in `work_dir`, without creating that
/// session — node-sdk `listWorkspaceSkills` parity. Errors when `work_dir`
/// is empty (the SDK requires it).
pub fn list_workspace_skills(work_dir: &str) -> Result<Vec<SkillSummary>, String> {
    if work_dir.trim().is_empty() {
        return Err("listWorkspaceSkills requires workDir".to_string());
    }
    let home = crate::config::resolve_kimi_home().unwrap_or_default();
    let roots: [(PathBuf, &str); 2] = [
        (Path::new(work_dir).join(".kimi-code").join("skills"), "project"),
        (PathBuf::from(home).join("skills"), "user"),
    ];
    let mut by_name: HashMap<String, SkillSummary> = HashMap::new();
    for (root, source) in roots {
        for skill in discover_skill_bundles(&root, source) {
            by_name.entry(skill.name.clone()).or_insert(skill);
        }
    }
    let mut skills: Vec<SkillSummary> = by_name.into_values().collect();
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(skills)
}

/// Scan one skills root (`<root>/*/SKILL.md`); unreadable roots yield nothing.
fn discover_skill_bundles(root: &Path, source: &str) -> Vec<SkillSummary> {
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let skill_path = dir.join("SKILL.md");
        let Ok(text) = std::fs::read_to_string(&skill_path) else {
            continue;
        };
        let fallback = entry.file_name().to_string_lossy().into_owned();
        let Some(parsed) = parse_skill_frontmatter(&text, &fallback) else {
            continue;
        };
        out.push(SkillSummary {
            name: parsed.name,
            description: parsed.description,
            source: source.to_string(),
            path: skill_path.to_string_lossy().into_owned(),
            disable_model_invocation: parsed.disable_model_invocation,
        });
    }
    out
}

/// Parse a SKILL.md's YAML frontmatter (`---` delimited). Missing fields fall
/// back to the bundle dir name and an empty description; no parseable
/// frontmatter yields `None` (node-sdk `parseSkillFrontmatter` parity).
fn parse_skill_frontmatter(text: &str, fallback_name: &str) -> Option<SkillFrontmatter> {
    let lines: Vec<&str> = text.lines().collect();
    if lines.first().map(|line| line.trim()) != Some("---") {
        return None;
    }
    let close = lines
        .iter()
        .enumerate()
        .skip(1)
        .find(|(_, line)| line.trim() == "---")
        .map(|(index, _)| index)?;
    let mut name: Option<String> = None;
    let mut description: Option<String> = None;
    let mut disable_model_invocation: Option<bool> = None;
    for line in lines[1..close].iter() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim();
        let value = parse_scalar(value.trim());
        match key {
            "name" => {
                if !value.is_empty() {
                    name = Some(value);
                }
            }
            "description" => {
                description = Some(value);
            }
            // The TS side accepts all three spellings.
            "disable_model_invocation" | "disable-model-invocation" | "disableModelInvocation" => {
                disable_model_invocation = Some(value == "true");
            }
            _ => {}
        }
    }
    Some(SkillFrontmatter {
        name: name.unwrap_or_else(|| fallback_name.to_string()),
        description: description.unwrap_or_default(),
        disable_model_invocation,
    })
}

/// Strip matching quotes from a scalar value (`"x"` / `'x'`), else as-is.
fn parse_scalar(value: &str) -> String {
    let value = value.trim();
    if value.len() >= 2 {
        let bytes = value.as_bytes();
        if (bytes[0] == b'"' && bytes[value.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[value.len() - 1] == b'\'')
        {
            return value[1..value.len() - 1].to_string();
        }
    }
    value.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Shared with config.rs's env-dependent tests (one lock for the whole
    /// process-global env).
    use crate::config::ENV_LOCK;

    /// Pins `KIMI_CODE_HOME` to a scratch dir and restores it on drop.
    struct HomeGuard(Option<std::ffi::OsString>);

    impl HomeGuard {
        fn set(dir: &Path) -> Self {
            let previous = std::env::var_os("KIMI_CODE_HOME");
            std::env::set_var("KIMI_CODE_HOME", dir);
            Self(previous)
        }
    }

    impl Drop for HomeGuard {
        fn drop(&mut self) {
            match &self.0 {
                Some(value) => std::env::set_var("KIMI_CODE_HOME", value),
                None => std::env::remove_var("KIMI_CODE_HOME"),
            }
        }
    }

    fn tmp_skills(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kimi-sdk-skills-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("mkdir");
        dir
    }

    #[test]
    fn discovers_bundles_with_project_priority_and_sorting() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let root = tmp_skills("discover");
        let home = root.join("home");
        std::fs::create_dir_all(&home).expect("mkdir home");
        let _home_guard = HomeGuard::set(&home);
        // project: zeta + alpha; user: alpha (loses) + beta.
        for (name, dir) in [
            ("zeta", root.join(".kimi-code/skills/zeta")),
            ("alpha", root.join(".kimi-code/skills/alpha")),
            ("alpha-user", home.join("skills/alpha")),
            ("beta", home.join("skills/beta")),
        ] {
            std::fs::create_dir_all(&dir).expect("mkdir bundle");
            let real_name = if name == "alpha-user" { "alpha" } else { name };
            std::fs::write(
                dir.join("SKILL.md"),
                format!(
                    "---\nname: {real_name}\ndescription: {name} description\n---\nbody\n"
                ),
            )
            .expect("write");
        }
        let skills = list_workspace_skills(root.to_str().unwrap()).expect("skills");
        let names: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
        // alpha (project, not user) + beta + zeta, name-sorted.
        assert_eq!(names, vec!["alpha", "beta", "zeta"], "{names:?}");
        let alpha = skills.iter().find(|s| s.name == "alpha").expect("alpha");
        assert_eq!(alpha.source, "project");
        assert_eq!(alpha.description, "alpha description");
        assert!(
            alpha.path.replace('\\', "/").ends_with(".kimi-code/skills/alpha/SKILL.md"),
            "path: {}",
            alpha.path
        );
    }

    #[test]
    fn empty_work_dir_errors() {
        assert!(list_workspace_skills("").is_err());
    }

    #[test]
    fn missing_roots_yield_empty() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = tmp_skills("missing");
        let _home_guard = HomeGuard::set(&home);
        let skills =
            list_workspace_skills("/nonexistent-dir-for-kimi-skills-test").expect("ok");
        assert!(skills.is_empty());
    }

    #[test]
    fn frontmatter_without_dashes_is_skipped() {
        let parsed = parse_skill_frontmatter("# no frontmatter\nname: x\n", "fallback");
        assert!(parsed.is_none());
    }

    #[test]
    fn frontmatter_falls_back_to_dir_name() {
        let parsed = parse_skill_frontmatter("---\ndescription: only desc\n---\n", "dir-name");
        let parsed = parsed.expect("parsed");
        assert_eq!(parsed.name, "dir-name");
        assert_eq!(parsed.description, "only desc");
    }

    #[test]
    fn frontmatter_parses_quotes_and_booleans() {
        let parsed = parse_skill_frontmatter(
            "---\nname: \"quoted name\"\ndisable_model_invocation: true\n---\n",
            "fallback",
        )
        .expect("parsed");
        assert_eq!(parsed.name, "quoted name");
        assert_eq!(parsed.disable_model_invocation, Some(true));
    }

    #[test]
    fn frontmatter_accepts_camel_and_kebab_spellings() {
        for key in ["disable_model_invocation", "disable-model-invocation", "disableModelInvocation"] {
            let parsed = parse_skill_frontmatter(&format!("---\n{key}: true\n---\n"), "fb")
                .expect("parsed");
            assert_eq!(parsed.disable_model_invocation, Some(true), "key: {key}");
        }
    }
}
