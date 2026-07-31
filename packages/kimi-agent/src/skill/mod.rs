/// SkillManager — skill registration and activation.
///
/// Corresponds to `packages/agent-core/src/agent/skill/index.ts`.
///
/// Manages a registry of skills that can be activated by the user or model.
/// Skills provide reusable capabilities (prompts, commands, workflows).

use std::collections::HashMap;
use std::path::Path;

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
    /// The full skill content, loaded from the skill file.
    /// When present, activation uses this instead of description.
    #[serde(default)]
    pub content: Option<String>,
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

    /// Get a mutable reference to a skill by name.
    pub fn get_skill_mut(&mut self, name: &str) -> Option<&mut SkillMetadata> {
        self.skills.get_mut(name)
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

/// Host-supplied skill metadata on the `session/create` wire. The host
/// discovers skills (dirs, plugin manifests) and hands the engine flat records;
/// `into_metadata` maps to the registry's [`SkillMetadata`].
#[derive(Debug, Clone, Deserialize)]
pub struct SkillMetadataInput {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_skill_type")]
    pub skill_type: String,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub dir: Option<String>,
    #[serde(default)]
    pub content: Option<String>,
}

fn default_skill_type() -> String {
    "prompt".to_string()
}

impl SkillMetadataInput {
    pub fn into_metadata(self) -> SkillMetadata {
        SkillMetadata {
            name: self.name,
            description: self.description,
            skill_type: self.skill_type,
            source: self.source,
            path: self.path,
            dir: self.dir,
            content: self.content,
        }
    }
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
    pub fn activate(&mut self, input: ActivateSkillPayload) -> Result<(SkillActivationOrigin, String), String> {
        let skill_path = self.registry.get_skill(&input.name)
            .and_then(|s| s.path.clone());
        let skill_dir = self.registry.get_skill(&input.name)
            .and_then(|s| s.dir.clone());
        
        // Try to load skill content from file if not already loaded
        let loaded_content = if let Some(ref path) = skill_path {
            // Check if content is already cached
            let needs_load = self.registry.get_skill(&input.name)
                .map(|s| s.content.is_none())
                .unwrap_or(false);
            
            if needs_load {
                load_skill_content(path, skill_dir.as_deref()).ok()
            } else {
                None
            }
        } else {
            None
        };
        
        // Cache loaded content
        if let Some(ref content) = loaded_content {
            if let Some(skill) = self.registry.get_skill_mut(&input.name) {
                skill.content = Some(content.clone());
            }
        }
        
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
        let content = skill.content.as_deref();
        let rendered_prompt = render_skill_prompt(&skill.name, &skill_args, &skill.description, content);

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

/// Load skill content from a file on disk.
fn load_skill_content(path: &str, dir: Option<&str>) -> Result<String, String> {
    // Try path as-is first
    let file_path = Path::new(path);
    if file_path.exists() {
        return std::fs::read_to_string(file_path)
            .map_err(|e| format!("Cannot read skill file {path}: {e}"));
    }
    
    // Try relative to dir
    if let Some(base_dir) = dir {
        let joined = Path::new(base_dir).join(path);
        if joined.exists() {
            return std::fs::read_to_string(&joined)
                .map_err(|e| format!("Cannot read skill file {}: {e}", joined.display()));
        }
    }
    
    // Try adding .skill.md extension
    let with_ext = format!("{}.skill.md", path);
    let ext_path = Path::new(&with_ext);
    if ext_path.exists() {
        return std::fs::read_to_string(ext_path)
            .map_err(|e| format!("Cannot read skill file {with_ext}: {e}"));
    }
    
    // Try with extension relative to dir
    if let Some(base_dir) = dir {
        let joined_ext = Path::new(base_dir).join(&with_ext);
        if joined_ext.exists() {
            return std::fs::read_to_string(&joined_ext)
                .map_err(|e| format!("Cannot read skill file {}: {e}", joined_ext.display()));
        }
    }
    
    Err(format!("Skill file not found: {path}"))
}

/// Check if a skill type is user-activatable.
fn is_user_activatable_skill_type(skill_type: &str) -> bool {
    matches!(skill_type, "prompt" | "workflow" | "command")
}

/// Render a skill prompt from the skill name, args, description, and optional content.
fn render_skill_prompt(name: &str, args: &str, description: &str, content: Option<&str>) -> String {
    let body = content.unwrap_or(description);
    if args.is_empty() {
        format!(
            "[Skill: {}]\n{}\n[/Skill]",
            name, body
        )
    } else {
        format!(
            "[Skill: {}]\n{}\nArgs: {}\n[/Skill]",
            name, body, args
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
            content: None,
        }
    }

    fn make_skill_with_content() -> SkillMetadata {
        SkillMetadata {
            name: "with-content".to_string(),
            description: "Description only".to_string(),
            skill_type: "prompt".to_string(),
            source: None,
            path: None,
            dir: None,
            content: Some("Full skill file content here\nWith multiple lines".to_string()),
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
            content: None,
        });
        assert_eq!(registry.list_skills().len(), 2);
    }

    #[test]
    fn test_activate_skill() {
        let mut registry = SkillRegistry::new();
        registry.register(make_sample_skill());
        let mut manager = SkillManager::new(registry);

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
    fn test_activate_skill_with_content() {
        let mut registry = SkillRegistry::new();
        registry.register(make_skill_with_content());
        let mut manager = SkillManager::new(registry);

        let result = manager.activate(ActivateSkillPayload {
            name: "with-content".to_string(),
            args: None,
        });
        assert!(result.is_ok());

        let (_origin, prompt) = result.unwrap();
        // Should use content, not description
        assert!(prompt.contains("Full skill file content here"));
        assert!(!prompt.contains("Description only"));
    }

    #[test]
    fn test_activate_nonexistent_fails() {
        let mut manager = SkillManager::new(SkillRegistry::new());
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
            content: None,
        });
        let mut manager = SkillManager::new(registry);
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
        let prompt = render_skill_prompt("test", "arg1", "A test skill", None);
        assert!(prompt.contains("[Skill: test]"));
        assert!(prompt.contains("A test skill"));
        assert!(prompt.contains("Args: arg1"));
        assert!(prompt.contains("[/Skill]"));
    }

    #[test]
    fn test_render_skill_prompt_without_args() {
        let prompt = render_skill_prompt("test", "", "A test skill", None);
        assert!(prompt.contains("[Skill: test]"));
        assert!(prompt.contains("[/Skill]"));
        assert!(!prompt.contains("Args:"));
    }

    #[test]
    fn test_render_skill_prompt_with_content_instead_of_description() {
        let prompt = render_skill_prompt("test", "", "description only", Some("actual file content here"));
        assert!(prompt.contains("actual file content here"));
        assert!(!prompt.contains("description only"));
    }

    #[test]
    fn test_is_user_activatable() {
        assert!(is_user_activatable_skill_type("prompt"));
        assert!(is_user_activatable_skill_type("workflow"));
        assert!(is_user_activatable_skill_type("command"));
        assert!(!is_user_activatable_skill_type("internal"));
        assert!(!is_user_activatable_skill_type(""));
    }

    #[test]
    fn test_load_skill_content_file_not_found() {
        let result = load_skill_content("/nonexistent/path/to/skill.md", None);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }
}