/// SkillManager — skill registration and activation.
///
/// Corresponds to `packages/agent-core/src/agent/skill/index.ts`.
///
/// Manages a registry of skills that can be activated by the user or model.
/// Skills provide reusable capabilities (prompts, commands, workflows).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Metadata about a skill.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillMetadata {
    pub name: String,
    pub description: String,
    pub skill_type: String,
    pub source: Option<String>,
    pub path: Option<String>,
    pub dir: Option<String>,
}

/// The skill registry — a collection of known skills.
#[derive(Debug, Clone, Default)]
pub struct SkillRegistry {
    skills: HashMap<String, SkillMetadata>,
}

impl SkillRegistry {
    /// Create a new empty registry.
    pub fn new() -> Self {
        Self {
            skills: HashMap::new(),
        }
    }

    /// Register a skill.
    pub fn register(&mut self, skill: SkillMetadata) {
        self.skills.insert(skill.name.clone(), skill);
    }

    /// Get a skill by name.
    pub fn get_skill(&self, name: &str) -> Option<&SkillMetadata> {
        self.skills.get(name)
    }

    /// Check if a skill exists.
    pub fn has_skill(&self, name: &str) -> bool {
        self.skills.contains_key(name)
    }

    /// List all registered skills.
    pub fn list_skills(&self) -> Vec<&SkillMetadata> {
        self.skills.values().collect()
    }

    /// Number of registered skills.
    pub fn len(&self) -> usize {
        self.skills.len()
    }

    /// Whether the registry is empty.
    pub fn is_empty(&self) -> bool {
        self.skills.is_empty()
    }
}

/// Input for activating a skill.
#[derive(Debug, Clone)]
pub struct ActivateSkillPayload {
    pub name: String,
    pub args: Option<String>,
}

/// Origin of a skill activation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillActivationOrigin {
    pub activation_id: String,
    pub skill_name: String,
    pub trigger: String,
    pub skill_type: String,
    pub skill_path: Option<String>,
    pub skill_source: Option<String>,
    pub skill_args: Option<String>,
}

/// SkillManager — manages skill registration and activation.
pub struct SkillManager {
    pub registry: SkillRegistry,
}

impl SkillManager {
    /// Create a new SkillManager with the given registry.
    pub fn new(registry: SkillRegistry) -> Self {
        Self { registry }
    }

    /// Activate a skill by name.
    ///
    /// Returns the activation origin and the rendered prompt text on success,
    /// or an error string if the skill is not found or not user-activatable.
    pub fn activate(&self, input: ActivateSkillPayload) -> Result<(SkillActivationOrigin, String), String> {
        let skill = self.registry.get_skill(&input.name).ok_or_else(|| {
            format!("Skill \"{}\" was not found", input.name)
        })?;

        if !is_user_activatable_skill_type(&skill.skill_type) {
            return Err(format!(
                "Skill \"{}\" cannot be activated by the user",
                skill.name
            ));
        }

        let skill_args = input.args.unwrap_or_default();
        let rendered_prompt = render_skill_prompt(&skill.name, &skill_args, &skill.description);

        let origin = SkillActivationOrigin {
            activation_id: generate_activation_id(),
            skill_name: skill.name.clone(),
            trigger: "user-slash".to_string(),
            skill_type: skill.skill_type.clone(),
            skill_path: skill.path.clone(),
            skill_source: skill.source.clone(),
            skill_args: Some(skill_args),
        };

        Ok((origin, rendered_prompt))
    }

    /// Record a skill activation (for event emission).
    pub fn record_activation(&self, origin: &SkillActivationOrigin) -> serde_json::Value {
        serde_json::json!({
            "type": "skill.activated",
            "activationId": origin.activation_id,
            "skillName": origin.skill_name,
            "trigger": origin.trigger,
            "skillArgs": origin.skill_args,
            "skillPath": origin.skill_path,
            "skillSource": origin.skill_source,
        })
    }
}

/// Check if a skill type is user-activatable.
fn is_user_activatable_skill_type(skill_type: &str) -> bool {
    matches!(skill_type, "prompt" | "workflow" | "command")
}

/// Render a skill prompt from the skill name, args, and content.
fn render_skill_prompt(name: &str, args: &str, description: &str) -> String {
    if args.is_empty() {
        format!(
            "[Skill: {}]\n{}\n[/Skill]",
            name, description
        )
    } else {
        format!(
            "[Skill: {}]\n{}\nArgs: {}\n[/Skill]",
            name, description, args
        )
    }
}

/// Generate a unique activation ID.
fn generate_activation_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let count = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("skill-{:x}-{:x}", now, count)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_sample_skill() -> SkillMetadata {
        SkillMetadata {
            name: "read-file".to_string(),
            description: "Read a file from the filesystem".to_string(),
            skill_type: "prompt".to_string(),
            source: Some("builtin".to_string()),
            path: Some("/skills/read-file.md".to_string()),
            dir: Some("/skills".to_string()),
        }
    }

    #[test]
    fn test_registry_empty() {
        let registry = SkillRegistry::new();
        assert!(registry.is_empty());
        assert_eq!(registry.len(), 0);
    }

    #[test]
    fn test_register_and_get() {
        let mut registry = SkillRegistry::new();
        registry.register(make_sample_skill());
        assert!(!registry.is_empty());
        assert_eq!(registry.len(), 1);

        let skill = registry.get_skill("read-file");
        assert!(skill.is_some());
        assert_eq!(skill.unwrap().description, "Read a file from the filesystem");
    }

    #[test]
    fn test_get_nonexistent() {
        let registry = SkillRegistry::new();
        assert!(registry.get_skill("nonexistent").is_none());
    }

    #[test]
    fn test_has_skill() {
        let mut registry = SkillRegistry::new();
        registry.register(make_sample_skill());
        assert!(registry.has_skill("read-file"));
        assert!(!registry.has_skill("write-file"));
    }

    #[test]
    fn test_list_skills() {
        let mut registry = SkillRegistry::new();
        registry.register(make_sample_skill());
        registry.register(SkillMetadata {
            name: "write-file".to_string(),
            description: "Write a file".to_string(),
            skill_type: "prompt".to_string(),
            source: None,
            path: None,
            dir: None,
        });
        assert_eq!(registry.list_skills().len(), 2);
    }

    #[test]
    fn test_activate_skill() {
        let mut registry = SkillRegistry::new();
        registry.register(make_sample_skill());
        let manager = SkillManager::new(registry);

        let result = manager.activate(ActivateSkillPayload {
            name: "read-file".to_string(),
            args: Some("path/to/file.txt".to_string()),
        });
        assert!(result.is_ok());

        let (origin, prompt) = result.unwrap();
        assert_eq!(origin.skill_name, "read-file");
        assert!(prompt.contains("read-file"));
        assert!(prompt.contains("Read a file"));
    }

    #[test]
    fn test_activate_nonexistent_fails() {
        let manager = SkillManager::new(SkillRegistry::new());
        let result = manager.activate(ActivateSkillPayload {
            name: "nonexistent".to_string(),
            args: None,
        });
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }

    #[test]
    fn test_activate_non_user_activatable_fails() {
        let mut registry = SkillRegistry::new();
        registry.register(SkillMetadata {
            name: "internal".to_string(),
            description: "Internal skill".to_string(),
            skill_type: "internal".to_string(),
            source: None,
            path: None,
            dir: None,
        });
        let manager = SkillManager::new(registry);
        let result = manager.activate(ActivateSkillPayload {
            name: "internal".to_string(),
            args: None,
        });
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("cannot be activated"));
    }

    #[test]
    fn test_record_activation_creates_event() {
        let origin = SkillActivationOrigin {
            activation_id: "act-1".to_string(),
            skill_name: "test".to_string(),
            trigger: "user-slash".to_string(),
            skill_type: "prompt".to_string(),
            skill_path: None,
            skill_source: None,
            skill_args: None,
        };
        let manager = SkillManager::new(SkillRegistry::new());
        let event = manager.record_activation(&origin);
        assert_eq!(event["type"], "skill.activated");
        assert_eq!(event["skillName"], "test");
    }

    #[test]
    fn test_render_skill_prompt_with_args() {
        let prompt = render_skill_prompt("test", "arg1", "A test skill");
        assert!(prompt.contains("[Skill: test]"));
        assert!(prompt.contains("A test skill"));
        assert!(prompt.contains("Args: arg1"));
        assert!(prompt.contains("[/Skill]"));
    }

    #[test]
    fn test_render_skill_prompt_without_args() {
        let prompt = render_skill_prompt("test", "", "A test skill");
        assert!(prompt.contains("[Skill: test]"));
        assert!(prompt.contains("[/Skill]"));
        assert!(!prompt.contains("Args:"));
    }

    #[test]
    fn test_is_user_activatable() {
        assert!(is_user_activatable_skill_type("prompt"));
        assert!(is_user_activatable_skill_type("workflow"));
        assert!(is_user_activatable_skill_type("command"));
        assert!(!is_user_activatable_skill_type("internal"));
        assert!(!is_user_activatable_skill_type(""));
    }
}