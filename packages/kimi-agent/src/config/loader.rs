/// Configuration search and loading system.
///
/// Scans well-known paths, merges user-level config with project-level config,
/// applies environment variable overrides, and supports hot-reload with callbacks.
/// A reload only commits a fully loaded and validated config: a corrupted
/// (e.g. half-written) config.toml fails the reload and keeps the last good
/// configuration, so the loaded provider/model catalogs are never cleared.
use std::path::{Path, PathBuf};
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

/// The most recently loaded configuration that passed validation.
///
/// A failed reload leaves this snapshot untouched, so the engine's loaded
/// provider/model catalogs survive a transiently corrupted config.toml — the
/// caller can restore them via [`last_good_config`].
static LAST_GOOD_CONFIG: LazyLock<Mutex<Option<KimiConfig>>> =
    LazyLock::new(|| Mutex::new(None));

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

    // 4. User-level: ~/.kimi-code/config.toml (KIMI_CODE_HOME is the
    //    `.kimi-code` directory itself — same semantic as server.token).
    if let Ok(dir) = std::env::var("KIMI_CODE_HOME") {
        paths.push(PathBuf::from(dir).join("config.toml"));
    } else if let Some(home) = home_dir() {
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

/// Load a config from a path, treating an absent file as optional.
///
/// Returns `Ok(None)` when the file does not exist (config paths are
/// optional). Any other failure — an unreadable or unparsable file, e.g. a
/// half-written config.toml — is propagated, so a corrupted file aborts the
/// whole load/reload instead of being silently skipped and leaving the merged
/// result without the providers/models that file declared.
fn try_load(path: &PathBuf) -> Result<Option<KimiConfig>> {
    if !path.exists() {
        return Ok(None);
    }
    let s = path.to_string_lossy();
    match load_config_from_file(&s) {
        Ok(config) => Ok(Some(config)),
        Err(e) => Err(anyhow::anyhow!("Failed to load config {s}: {e}")),
    }
}

/// Load and merge a list of paths into a single config.
/// Earlier paths in the list are loaded as the base, later paths override.
/// A missing file is skipped; a corrupted file aborts the whole merge.
fn load_and_merge(paths: &[PathBuf]) -> Result<KimiConfig> {
    let mut merged = KimiConfig::empty();

    for path in paths {
        if let Some(config) = try_load(path)? {
            merged = merge_configs(merged, config);
        }
    }

    Ok(merged)
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

/// Load, merge and validate the config from an explicit path list.
///
/// `paths` are partitioned into user-level (base), project-level (override)
/// and `KIMI_CONFIG_PATH` (highest file priority) groups, then merged in that
/// order. A missing file is skipped; a corrupted file aborts the whole load.
/// Environment variable overrides (`KIMI_PROVIDER_*`) are applied last when
/// `apply_env` is set.
fn load_from_paths(paths: &[PathBuf], apply_env: bool, validate: bool) -> Result<KimiConfig> {
    let (user_paths, project_paths, env_override) = partition_paths(paths);

    // Start with empty config
    let mut config = KimiConfig::empty();

    // 1. Load user-level configs (lowest priority)
    let user_config = load_and_merge(&user_paths)?;
    config = merge_configs(config, user_config);

    // 2. Load project-level configs (override user-level)
    let project_config = load_and_merge(&project_paths)?;
    config = merge_configs(config, project_config);

    // 3. Load KIMI_CONFIG_PATH (highest file priority)
    if let Some(env_path) = &env_override {
        if let Some(env_config) = try_load(env_path)? {
            config = merge_configs(config, env_config);
        }
    }

    if validate {
        validate_config(&config)?;
    }

    if apply_env {
        apply_env_overrides(&mut config);
    }

    Ok(config)
}

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
    load_from_paths(&find_config_paths(), false, true)
}

/// Load configuration and apply environment variable overrides.
///
/// Same as [`load_config`], but also applies `KIMI_PROVIDER_*` environment
/// variables (e.g. `KIMI_PROVIDER_OPENAI_API_KEY`, `KIMI_PROVIDER_ANTHROPIC_MODEL`)
/// on top of all file-based configuration.
pub fn load_config_with_env() -> Result<KimiConfig> {
    load_from_paths(&find_config_paths(), true, true)
}

/// Load configuration with environment overrides but WITHOUT the
/// at-least-one-provider validation (TS parity — the read/write paths
/// `config/get` / `config/set` must tolerate an empty fresh home; the
/// provider requirement is enforced by `doctor` / startup instead).
pub fn load_config_with_env_unvalidated() -> Result<KimiConfig> {
    load_from_paths(&find_config_paths(), true, false)
}

/// Parse and validate a single config file (used by `kimi doctor config
/// <path>`): reads the one file, applies no merging and no environment
/// overrides, and validates the result like a real load.
pub fn parse_config_file(path: &Path) -> Result<KimiConfig> {
    let mut config = KimiConfig::empty();
    if let Some(loaded) = try_load(&path.to_path_buf())? {
        config = merge_configs(config, loaded);
    }
    validate_config(&config)?;
    Ok(config)
}

// ── Hot reload ─────────────────────────────────────────────────────────────

/// Reload configuration from the well-known paths with environment overrides,
/// then notify all registered callbacks.
///
/// The reload is atomic on failure: the new config is fully loaded and
/// validated before anything is committed, so a corrupted (e.g. half-written)
/// config.toml returns an error without disturbing the last successfully
/// loaded config — the previously loaded provider/model catalogs stay
/// available through [`last_good_config`] and are never cleared by a failed
/// reload.
pub fn reload_config() -> Result<KimiConfig> {
    match reload_from_paths(&find_config_paths()) {
        Ok(config) => Ok(config),
        Err(e) => {
            eprintln!(
                "[kimi-agent] Config reload failed, keeping last good config: {e}"
            );
            Err(e)
        }
    }
}

/// Core reload logic over an explicit path list.
///
/// Loads and validates the whole config first, and only then — atomically —
/// records it as the last good config and notifies callbacks. Extracted from
/// [`reload_config`] so tests can drive reloads from temp files without
/// depending on process-global environment variables.
fn reload_from_paths(paths: &[PathBuf]) -> Result<KimiConfig> {
    let config = load_from_paths(paths, true, true)?;

    // Commit the new state only after the whole load succeeded, so a failed
    // reload never clears the previously loaded provider/model catalogs.
    *LAST_GOOD_CONFIG.lock().unwrap() = Some(config.clone());

    let callbacks = CONFIG_CALLBACKS.lock().unwrap();
    for cb in callbacks.iter() {
        cb(&config);
    }

    Ok(config)
}

/// Return a clone of the last successfully loaded configuration, if any.
///
/// A failed [`reload_config`] leaves this untouched, so callers can restore
/// the previously loaded provider/model catalogs instead of losing them.
pub fn last_good_config() -> Option<KimiConfig> {
    LAST_GOOD_CONFIG.lock().unwrap().clone()
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
    /// Serializes tests that touch the process-global config snapshots
    /// (LAST_GOOD_CONFIG / CONFIG_CALLBACKS): cargo runs tests in parallel
    /// threads, which would race the shared statics.
    static TEST_SERIAL: std::sync::LazyLock<std::sync::Mutex<()>> =
        std::sync::LazyLock::new(|| std::sync::Mutex::new(()));

    fn serial_guard() -> std::sync::MutexGuard<'static, ()> {
        TEST_SERIAL.lock().unwrap_or_else(|e| e.into_inner())
    }

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
        let _g = serial_guard();
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

    // ── Atomic reload / fault tolerance ────────────────────────────────────

    /// Write a valid config with one provider and one model alias.
    fn write_valid_config(path: &std::path::Path) {
        use std::fs::write;
        write(
            path,
            r#"
[providers.openai]
type = "openai"
apiKey = "sk-test"
defaultModel = "gpt-4"

[models."acme/m1"]
provider = "acme"
model = "m1"
"#,
        )
        .expect("write config");
    }

    #[test]
    fn test_reload_success_records_last_good() {
        let _g = serial_guard();
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("config.toml");
        write_valid_config(&path);

        let config = reload_from_paths(&[path])
            .expect("reload with a valid config should succeed");
        let providers = config.providers.as_ref().unwrap();
        assert_eq!(providers.len(), 1);
        assert!(providers.contains_key("openai"));
        assert!(config.model_aliases.as_ref().unwrap().contains_key("acme/m1"));

        // The successful reload is recorded as the last good config.
        let last_good = last_good_config().expect("last good config recorded");
        assert_eq!(last_good, config);
    }

    #[test]
    fn test_reload_corrupt_toml_keeps_last_good() {
        let _g = serial_guard();
        use std::fs::write;

        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("config.toml");

        // First, a valid config is loaded and recorded as last good.
        write_valid_config(&path);
        let good = reload_from_paths(&[path.clone()])
            .expect("first reload should succeed");
        assert!(good.providers.as_ref().unwrap().contains_key("openai"));

        // Then the file is corrupted (simulating a half-written config.toml
        // mid-refresh). The reload must fail WITHOUT clearing the previously
        // loaded provider/model catalogs.
        write(&path, "[providers.openai\napiKey = \"sk-test\"").unwrap();
        let err = reload_from_paths(&[path.clone()]);
        assert!(
            err.is_err(),
            "a corrupted config file must fail the reload, got: {err:?}"
        );

        let last_good = last_good_config().expect("last good must be retained");
        let providers = last_good.providers.as_ref().unwrap();
        assert_eq!(providers.len(), 1);
        assert!(providers.contains_key("openai"));
        assert_eq!(
            providers.get("openai").unwrap().model,
            Some("gpt-4".into())
        );
        assert!(last_good.model_aliases.as_ref().unwrap().contains_key("acme/m1"));
    }

    #[test]
    fn test_reload_missing_or_empty_config_fails() {
        let _g = serial_guard();
        use std::fs::write;

        let dir = tempfile::tempdir().expect("tempdir");
        let missing = dir.path().join("does-not-exist.toml");

        // No config anywhere: reload must error rather than return an empty
        // config that would silently clear the loaded catalog.
        assert!(reload_from_paths(&[missing.clone()]).is_err());

        // An empty (parseable but provider-less) file fails validation the
        // same way.
        write(&missing, "").unwrap();
        assert!(reload_from_paths(&[missing]).is_err());
    }

    #[test]
    fn test_load_and_merge_skips_missing_file() {
        let _g = serial_guard();
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = dir.path().join("missing.toml");

        let config = load_and_merge(&[missing])
            .expect("a missing config path is optional and must be skipped");
        assert!(config.providers.is_none());
    }

    #[test]
    fn test_corrupt_file_aborts_merge() {
        let _g = serial_guard();
        use std::fs::write;

        let dir = tempfile::tempdir().expect("tempdir");
        let good = dir.path().join("good.toml");
        let corrupt = dir.path().join("corrupt.toml");
        write_valid_config(&good);
        write(&corrupt, "[providers.openai\napiKey = ").unwrap();

        // A corrupted file anywhere in the list must abort the whole merge —
        // otherwise the good file alone could silently produce a degraded
        // catalog missing the corrupted file's providers/models.
        let err = load_and_merge(&[good, corrupt]);
        assert!(
            err.is_err(),
            "a corrupted file in the path list must abort the merge, got: {err:?}"
        );
    }
}