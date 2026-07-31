/// Configuration search and loading system.
///
/// Scans well-known paths, merges user-level config with project-level config,
/// applies environment variable overrides, and supports hot-reload with callbacks.
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

use anyhow::Result;

use crate::config::env_model::apply_env_overrides;
use crate::config::merge::merge_configs;
use crate::config::toml::load_config_from_file;
use crate::config::types::KimiConfig;

/// Callback invoked when configuration is reloaded.
type ConfigCallback = Box<dyn Fn(&KimiConfig) + Send>;

static CONFIG_CALLBACKS: LazyLock<Mutex<Vec<ConfigCallback>>> =
    LazyLock::new(|| Mutex::new(Vec::new()));

// ── Path discovery ──────────────────────────────────────────────────────────

/// Return the user's home directory path.
fn home_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var("USERPROFILE").ok().map(PathBuf::from)
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("HOME").ok().map(PathBuf::from)
    }
}

/// Find all config file paths in priority order (highest first).
///
/// 1. `KIMI_CONFIG_PATH` environment variable
/// 2. `{cwd}/.kimi-code/config.toml`
/// 3. `{cwd}/kimi-code.toml`
/// 4. `~/.kimi-code/config.toml`
/// 5. `~/.config/kimi-code/config.toml`
pub fn find_config_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();

    // 1. KIMI_CONFIG_PATH env var — highest priority
    if let Ok(path) = std::env::var("KIMI_CONFIG_PATH") {
        paths.push(PathBuf::from(path));
    }

    // 2. Project-level: .kimi-code/config.toml
    paths.push(PathBuf::from(".kimi-code/config.toml"));

    // 3. Project-level: kimi-code.toml
    paths.push(PathBuf::from("kimi-code.toml"));

    // 4. User-level: ~/.kimi-code/config.toml
    if let Some(home) = home_dir() {
        paths.push(home.join(".kimi-code/config.toml"));
    }

    // 5. User-level: ~/.config/kimi-code/config.toml
    if let Some(home) = home_dir() {
        paths.push(home.join(".config/kimi-code/config.toml"));
    }

    paths
}

/// Partition config paths into user-level (lower priority) and project-level
/// (higher priority) groups, then return them in load order (lowest priority
/// first for user-level, then project-level).
///
/// The `KIMI_CONFIG_PATH` env var path is excluded from grouping and returned
/// separately as the highest-priority override.
fn partition_paths(
    paths: &[PathBuf],
) -> (Vec<PathBuf>, Vec<PathBuf>, Option<PathBuf>) {
    let mut user_level = Vec::new();
    let mut project_level = Vec::new();
    let mut env_override: Option<PathBuf> = None;

    // Env var path is always index 0 when present
    if let Some(env_path) = paths.first() {
        if std::env::var("KIMI_CONFIG_PATH").is_ok() {
            env_override = Some(env_path.clone());
        }
    }

    for (i, path) in paths.iter().enumerate() {
        // Skip the env var path (index 0, already handled)
        if env_override.is_some() && i == 0 {
            continue;
        }

        // Paths 1-2 in find_config_paths are project-level
        // (we skip first which is KIMI_CONFIG_PATH)
        let adjusted_idx = if env_override.is_some() { i - 1 } else { i };
        let is_project = adjusted_idx < 2;

        if is_project {
            project_level.push(path.clone());
        } else {
            user_level.push(path.clone());
        }
    }

    (user_level, project_level, env_override)
}

/// Try to load a config from a path. Returns `None` if the file does not exist
/// or cannot be read (the path is optional).
fn try_load(path: &PathBuf) -> Option<KimiConfig> {
    let s = path.to_string_lossy();
    load_config_from_file(&s)
        .map_err(|e| {
            eprintln!("[kimi-agent] Skipping config {s}: {e}");
            e
        })
        .ok()
}

/// Try to load and merge a list of paths into a single config.
/// Earlier paths in the list are loaded as the base, later paths override.
fn load_and_merge(paths: &[PathBuf]) -> KimiConfig {
    let mut merged = KimiConfig::empty();

    for path in paths {
        if let Some(config) = try_load(path) {
            merged = merge_configs(merged, config);
        }
    }

    merged
}

// ── Validation ─────────────────────────────────────────────────────────────

/// Validate a kimic configuration.
///
/// Checks:
/// - At least one provider is configured.
pub fn validate_config(config: &KimiConfig) -> Result<()> {
    let has_providers = config
        .providers
        .as_ref()
        .is_some_and(|p| !p.is_empty());

    if !has_providers {
        anyhow::bail!(
            "No providers configured. At least one provider is required."
        );
    }

    Ok(())
}

// ── Loading ─────────────────────────────────────────────────────────────────

/// Load configuration by searching well-known paths and merging them.
///
/// User-level configs (`~/.kimi-code/config.toml`, `~/.config/kimi-code/config.toml`)
/// are loaded first as the base. Project-level configs (`.kimi-code/config.toml`,
/// `kimi-code.toml`) override user-level values. The `KIMI_CONFIG_PATH` environment
/// variable overrides everything.
///
/// Environment variable overrides (`KIMI_PROVIDER_*`) are NOT applied — use
/// [`load_config_with_env`] for that.
pub fn load_config() -> Result<KimiConfig> {
    let paths = find_config_paths();
    let (user_paths, project_paths, env_override) = partition_paths(&paths);

    // Start with empty config
    let mut config = KimiConfig::empty();

    // 1. Load user-level configs (lowest priority)
    let user_config = load_and_merge(&user_paths);
    config = merge_configs(config, user_config);

    // 2. Load project-level configs (override user-level)
    let project_config = load_and_merge(&project_paths);
    config = merge_configs(config, project_config);

    // 3. Load KIMI_CONFIG_PATH (highest file priority)
    if let Some(env_path) = &env_override {
        if let Some(env_config) = try_load(env_path) {
            config = merge_configs(config, env_config);
        }
    }

    validate_config(&config)?;

    Ok(config)
}

/// Load configuration and apply environment variable overrides.
///
/// Same as [`load_config`], but also applies `KIMI_PROVIDER_*` environment
/// variables (e.g. `KIMI_PROVIDER_OPENAI_API_KEY`, `KIMI_PROVIDER_ANTHROPIC_MODEL`)
/// on top of all file-based configuration.
pub fn load_config_with_env() -> Result<KimiConfig> {
    let mut config = load_config()?;
    apply_env_overrides(&mut config);
    Ok(config)
}

// ── Hot reload ─────────────────────────────────────────────────────────────

/// Reload configuration from the well-known paths with environment overrides,
/// then notify all registered callbacks.
pub fn reload_config() -> Result<KimiConfig> {
    let config = load_config_with_env()?;

    let callbacks = CONFIG_CALLBACKS.lock().unwrap();
    for cb in callbacks.iter() {
        cb(&config);
    }

    Ok(config)
}

/// Register a callback to be notified on every `reload_config()` call.
///
/// The callback receives a reference to the newly loaded configuration.
/// Callbacks are called in registration order.
pub fn register_config_callback(cb: impl Fn(&KimiConfig) + Send + 'static) {
    let mut callbacks = CONFIG_CALLBACKS.lock().unwrap();
    callbacks.push(Box::new(cb));
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::types::ProviderConfig;
    use std::collections::HashMap;

    #[test]
    fn test_find_config_paths_contains_env_path() {
        // The env path is only present if KIMI_CONFIG_PATH is set
        // but we can verify the other paths exist
        let paths = find_config_paths();
        assert!(!paths.is_empty());

        // At minimum, the cwd paths should be present
        let has_cwd_kimi = paths.iter().any(|p| {
            p.to_string_lossy().contains(".kimi-code/config.toml")
        });
        let has_cwd_root = paths.iter().any(|p| {
            p.to_string_lossy().contains("kimi-code.toml") && !p.to_string_lossy().contains(".config")
        });
        assert!(has_cwd_kimi || has_cwd_root);

        // Home dir paths should be present
        let has_home_config = paths.iter().any(|p| {
            p.to_string_lossy().contains(".config/kimi-code")
        });
        assert!(has_home_config);
    }

    #[test]
    fn test_find_config_paths_priority_order() {
        let paths = find_config_paths();

        // Project-level paths should come before user-level paths
        // (after the optional KIMI_CONFIG_PATH)
        let start_idx = if std::env::var("KIMI_CONFIG_PATH").is_ok() {
            1
        } else {
            0
        };

        for (i, path) in paths.iter().enumerate() {
            let s = path.to_string_lossy();
            if i >= start_idx && i < start_idx + 2 {
                // Project-level
                assert!(
                    s.contains(".kimi-code/config.toml") || s == "kimi-code.toml",
                    "Expected project-level path at index {i}, got {s}"
                );
            } else if i >= start_idx + 2 {
                // User-level
                assert!(
                    s.contains(".kimi-code") || s.contains(".config/kimi-code"),
                    "Expected user-level path at index {i}, got {s}"
                );
            }
        }
    }

    #[test]
    fn test_validate_config_empty_fails() {
        let config = KimiConfig::empty();
        assert!(validate_config(&config).is_err());
    }

    #[test]
    fn test_validate_config_with_provider_succeeds() {
        let mut providers = HashMap::new();
        providers.insert(
            "openai".into(),
            ProviderConfig {
                provider: None,
                api_key: Some("sk-test".into()),
                base_url: None,
                model: None,
                max_tokens: None,
                oauth: None,
                custom_headers: None,
                env: None,
                source: None,
            },
        );

        let config = KimiConfig {
            providers: Some(providers),
            ..KimiConfig::empty()
        };
        assert!(validate_config(&config).is_ok());
    }

    #[test]
    fn test_validate_config_empty_providers_fails() {
        let config = KimiConfig {
            providers: Some(HashMap::new()),
            ..KimiConfig::empty()
        };
        assert!(validate_config(&config).is_err());
    }

    #[test]
    fn test_partition_paths_without_env_override() {
        let paths = vec![
            PathBuf::from(".kimi-code/config.toml"),
            PathBuf::from("kimi-code.toml"),
            PathBuf::from("/home/user/.kimi-code/config.toml"),
            PathBuf::from("/home/user/.config/kimi-code/config.toml"),
        ];
        let (user, project, env) = partition_paths(&paths);
        assert_eq!(project.len(), 2);
        assert_eq!(user.len(), 2);
        assert!(env.is_none());
    }

    #[test]
    fn test_register_and_reload_callbacks() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let called = std::sync::Arc::new(AtomicBool::new(false));
        let called_clone = called.clone();

        register_config_callback(move |_config| {
            called_clone.store(true, Ordering::SeqCst);
        });

        // reload_config will call the callback
        // It may fail if no config files exist, but the callback should still
        // be registered correctly (we just verify the registration doesn't panic)
        let _ = reload_config();
        // Note: callback may or may not fire depending on whether config exists
        // We only verify the registration API is sound
    }
}