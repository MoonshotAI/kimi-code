//! Config helpers — Kimi home resolution, model-alias lookup, and loader
//! wrappers (`resolve_config_paths` / `load_runtime_config_safe` /
//! `validate_config`) over the engine's config system, mirroring node-sdk's
//! `legacy/config.ts` path helpers and the `createKimiConfigRpc` surface.

use std::path::{Path, PathBuf};

use kimi_agent::config::loader;
use serde_json::Value;

/// Serializes tests that touch the process-global env (`KIMI_CODE_HOME`,
/// `HOME`, `USERPROFILE`, `KIMI_CONFIG_PATH`) — shared by every module's
/// env-dependent tests (config, skills, …).
#[cfg(test)]
pub(crate) static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Resolve the Kimi home directory (node-sdk `resolveKimiHome` parity):
/// `KIMI_CODE_HOME` when set, otherwise `.kimi-code` under the platform home
/// (`USERPROFILE` on Windows, `HOME` elsewhere). `None` when neither the
/// override nor the platform home env is set.
pub fn resolve_kimi_home() -> Option<String> {
    if let Some(home) = std::env::var_os("KIMI_CODE_HOME") {
        return Some(home.to_string_lossy().into_owned());
    }
    let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    let home = std::env::var_os(key)?;
    Some(
        Path::new(&home)
            .join(".kimi-code")
            .to_string_lossy()
            .into_owned(),
    )
}

/// Resolve the effective model alias for a requested model name against the
/// engine config JSON (the `config/get` result, `models` + `defaultModel`
/// keys):
/// 1. `requested` is itself a `models` key → that alias.
/// 2. `requested` equals some alias's `model` field value → that alias's key
///    (first match in the map's deterministic iteration order).
/// 3. Otherwise the config's `defaultModel`, when set.
///
/// `None` when nothing resolves. No direct TS counterpart — node-sdk's
/// `effectiveModelAlias` resolves a single alias record (merging `overrides`
/// and injecting Anthropic thinking profiles); this is the string → alias
/// lookup hosts need before resolving the winning record.
pub fn effective_model_alias(config: &Value, requested: &str) -> Option<String> {
    if let Some(models) = config.get("models").and_then(|m| m.as_object()) {
        if models.contains_key(requested) {
            return Some(requested.to_string());
        }
        for (alias_key, alias) in models {
            if alias.get("model").and_then(|m| m.as_str()) == Some(requested) {
                return Some(alias_key.clone());
            }
        }
    }
    config
        .get("defaultModel")
        .and_then(|m| m.as_str())
        .filter(|m| !m.is_empty())
        .map(str::to_string)
}

/// Find all config file paths in priority order (highest first), wrapping
/// the engine's `find_config_paths`:
/// 1. `KIMI_CONFIG_PATH` env var
/// 2. `{cwd}/.kimi-code/config.toml`
/// 3. `{cwd}/kimi-code.toml`
/// 4. `{KIMI_CODE_HOME}/config.toml` (`~/.kimi-code/config.toml` when unset)
/// 5. `~/.config/kimi-code/config.toml`
///
/// TS `resolveConfigPath` resolves a single default path
/// (`~/.kimi-code/config.toml`, `KIMI_CODE_HOME`-aware); this exposes the
/// engine's whole search list, which hosts need for load/doctor diagnostics.
pub fn resolve_config_paths() -> Vec<String> {
    loader::find_config_paths()
        .into_iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

/// Load, merge and validate the runtime config from the well-known paths —
/// wrapper over the engine's `load_config_with_env`. User-level configs are
/// the base, project-level override them, `KIMI_CONFIG_PATH` wins, and
/// `KIMI_PROVIDER_*` env overrides apply last. Returns the parsed
/// `KimiConfig` as JSON, or the first error as a plain string (a corrupted
/// file, or no providers configured).
pub fn load_runtime_config_safe() -> Result<Value, String> {
    let config = loader::load_config_with_env().map_err(|e| e.to_string())?;
    serde_json::to_value(config).map_err(|e| e.to_string())
}

/// Validate a config JSON value (the `config/get` shape — camelCase primary
/// keys, snake_case aliases accepted) against the engine's `KimiConfig`
/// schema and the at-least-one-provider rule. TS `validateConfigToml`
/// reports per-field Zod issues; this surfaces the first failure as a
/// plain string.
pub fn validate_config(config: &Value) -> Result<(), String> {
    let parsed: kimi_agent::config::types::KimiConfig =
        serde_json::from_value(config.clone()).map_err(|e| e.to_string())?;
    loader::validate_config(&parsed).map_err(|e| e.to_string())
}

/// Diagnostics for the most recent config load — node-sdk
/// `getConfigDiagnostics` parity. A fully valid config yields no warnings; a
/// broken config (missing file, no providers, parse failure) yields the
/// failure as a single actionable warning instead of throwing, so hosts can
/// render a "doctor" panel.
pub fn get_config_diagnostics() -> Vec<String> {
    match load_runtime_config_safe() {
        Ok(_) => Vec::new(),
        Err(error) => vec![error],
    }
}

const DEFAULT_CONFIG_FILE_TEXT: &str = "# ~/.kimi-code/config.toml
# Runtime settings for Kimi Code.
# This file starts empty so built-in defaults can apply.
# Login will populate managed Kimi provider and model entries.
";

/// Materialize the default config scaffold under the resolved config path
/// (node-sdk `ensureConfigFile` parity): `KIMI_CONFIG_PATH` when set, else
/// `<KIMI_CODE_HOME>/config.toml`. Creates the parent directory (0700) and
/// writes the default scaffold only when the file does not exist yet — an
/// existing file is left untouched.
pub fn ensure_config_file() -> Result<(), String> {
    let path = match std::env::var_os("KIMI_CONFIG_PATH") {
        Some(value) if !value.is_empty() => PathBuf::from(value),
        _ => {
            let home = resolve_kimi_home()
                .ok_or_else(|| "no kimi home to materialize config".to_string())?;
            PathBuf::from(home).join("config.toml")
        }
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
        }
    }
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
    {
        Ok(mut file) => {
            use std::io::Write;
            file.write_all(DEFAULT_CONFIG_FILE_TEXT.as_bytes())
                .map_err(|e| format!("write {}: {e}", path.display()))?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(format!("create {}: {error}", path.display())),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Uses the shared module-level lock (see `ENV_LOCK` above) so skills
    /// and config tests serialize on the same process-global env.
    use super::ENV_LOCK;

    /// Swaps the home-related env vars plus `KIMI_CONFIG_PATH` and restores
    /// the previous values on drop.
    struct HomeEnv {
        kimi_code_home: Option<std::ffi::OsString>,
        home: Option<std::ffi::OsString>,
        userprofile: Option<std::ffi::OsString>,
        kimi_config_path: Option<std::ffi::OsString>,
    }

    impl HomeEnv {
        fn apply(
            kimi_code_home: Option<&str>,
            home: Option<&str>,
            userprofile: Option<&str>,
            kimi_config_path: Option<&str>,
        ) -> Self {
            let guard = Self {
                kimi_code_home: std::env::var_os("KIMI_CODE_HOME"),
                home: std::env::var_os("HOME"),
                userprofile: std::env::var_os("USERPROFILE"),
                kimi_config_path: std::env::var_os("KIMI_CONFIG_PATH"),
            };
            match kimi_code_home {
                Some(v) => std::env::set_var("KIMI_CODE_HOME", v),
                None => std::env::remove_var("KIMI_CODE_HOME"),
            }
            match home {
                Some(v) => std::env::set_var("HOME", v),
                None => std::env::remove_var("HOME"),
            }
            match userprofile {
                Some(v) => std::env::set_var("USERPROFILE", v),
                None => std::env::remove_var("USERPROFILE"),
            }
            match kimi_config_path {
                Some(v) => std::env::set_var("KIMI_CONFIG_PATH", v),
                None => std::env::remove_var("KIMI_CONFIG_PATH"),
            }
            guard
        }
    }

    impl Drop for HomeEnv {
        fn drop(&mut self) {
            let restore = |key: &str, value: &Option<std::ffi::OsString>| match value {
                Some(v) => std::env::set_var(key, v),
                None => std::env::remove_var(key),
            };
            restore("KIMI_CODE_HOME", &self.kimi_code_home);
            restore("HOME", &self.home);
            restore("USERPROFILE", &self.userprofile);
            restore("KIMI_CONFIG_PATH", &self.kimi_config_path);
        }
    }

    fn test_home(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("{tag}-{}", std::process::id()))
    }

    #[test]
    fn kimi_home_prefers_env_override() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = test_home("kimi-sdk-home");
        let _env = HomeEnv::apply(Some(home.to_str().unwrap()), None, None, None);
        assert_eq!(resolve_kimi_home(), Some(home.to_string_lossy().into_owned()));
    }

    #[test]
    fn kimi_home_falls_back_to_platform_home() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = test_home("kimi-sdk-user");
        // Both envs set to the same dir so the expectation holds on either
        // platform (USERPROFILE wins on Windows, HOME elsewhere).
        let _env = HomeEnv::apply(
            None,
            Some(home.to_str().unwrap()),
            Some(home.to_str().unwrap()),
            None,
        );
        let expected = home.join(".kimi-code").to_string_lossy().into_owned();
        assert_eq!(resolve_kimi_home(), Some(expected));
    }

    #[test]
    fn kimi_home_none_when_unset() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _env = HomeEnv::apply(None, None, None, None);
        assert_eq!(resolve_kimi_home(), None);
    }

    fn config_fixture() -> Value {
        serde_json::json!({
            "models": {
                "fast": { "provider": "kimi", "model": "kimi-k2-flash" },
                "strong": { "provider": "kimi", "model": "kimi-k2" },
            },
            "defaultModel": "strong",
        })
    }

    #[test]
    fn alias_direct_hit_wins() {
        let config = config_fixture();
        assert_eq!(effective_model_alias(&config, "fast"), Some("fast".to_string()));
        assert_eq!(effective_model_alias(&config, "strong"), Some("strong".to_string()));
    }

    #[test]
    fn alias_matches_model_field_value() {
        let config = config_fixture();
        // A raw model id resolves to the alias that declares it.
        assert_eq!(effective_model_alias(&config, "kimi-k2-flash"), Some("fast".to_string()));
        assert_eq!(effective_model_alias(&config, "kimi-k2"), Some("strong".to_string()));
    }

    #[test]
    fn alias_falls_back_to_default_model() {
        let config = config_fixture();
        assert_eq!(
            effective_model_alias(&config, "does-not-exist"),
            Some("strong".to_string())
        );

        // No defaultModel → None.
        let mut config = config_fixture();
        config.as_object_mut().unwrap().remove("defaultModel");
        assert_eq!(effective_model_alias(&config, "does-not-exist"), None);

        // An empty defaultModel does not resolve either.
        config["defaultModel"] = serde_json::json!("");
        assert_eq!(effective_model_alias(&config, "does-not-exist"), None);
    }

    #[test]
    fn alias_ignores_missing_models_section() {
        let config = serde_json::json!({ "defaultModel": "kimi-k2" });
        assert_eq!(effective_model_alias(&config, "anything"), Some("kimi-k2".to_string()));
    }

    // ── Loader wrappers (config paths / load / validate) ─────────────────────────────────

    #[test]
    fn config_paths_include_project_and_kimi_home() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = test_home("kimi-sdk-paths");
        let _env = HomeEnv::apply(Some(home.to_str().unwrap()), None, None, None);

        let paths = resolve_config_paths();
        // Project-level paths (relative to the test cwd), with the
        // KIMI_CODE_HOME user path coming after them in priority order.
        let project_idx = paths.iter().position(|p| p == ".kimi-code/config.toml");
        let user_path = home.join("config.toml").to_string_lossy().into_owned();
        let user_idx = paths.iter().position(|p| *p == user_path);
        assert!(
            project_idx.is_some() && user_idx.is_some() && project_idx.unwrap() < user_idx.unwrap(),
            "expected project-level before KIMI_CODE_HOME user path, got {paths:?}"
        );
    }

    #[test]
    fn config_paths_fall_back_to_platform_home() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = test_home("kimi-sdk-paths-user");
        // Both envs set so the expectation holds on either platform.
        let _env = HomeEnv::apply(
            None,
            Some(home.to_str().unwrap()),
            Some(home.to_str().unwrap()),
            None,
        );

        let paths = resolve_config_paths();
        let dot_kimi = home
            .join(".kimi-code/config.toml")
            .to_string_lossy()
            .into_owned();
        let xdg = home
            .join(".config/kimi-code/config.toml")
            .to_string_lossy()
            .into_owned();
        assert!(
            paths.contains(&dot_kimi),
            "missing ~/.kimi-code path: {paths:?}"
        );
        assert!(paths.contains(&xdg), "missing ~/.config path: {paths:?}");
    }

    #[test]
    fn load_runtime_config_safe_reads_temp_home() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = test_home("kimi-sdk-load");
        std::fs::create_dir_all(&home).expect("create temp home");
        std::fs::write(
            home.join("config.toml"),
            r#"
[providers.openai]
type = "openai"
apiKey = "sk-test"
defaultModel = "gpt-4"
"#,
        )
        .expect("write temp config");
        let _env = HomeEnv::apply(Some(home.to_str().unwrap()), None, None, None);

        let config = load_runtime_config_safe().expect("load merged config");
        assert!(config.is_object());
        let provider = &config["providers"]["openai"];
        assert_eq!(provider["type"], "openai");
        assert_eq!(provider["apiKey"], "sk-test");
        assert_eq!(provider["defaultModel"], "gpt-4");
    }

    #[test]
    fn load_runtime_config_safe_errors_without_providers() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // Empty home everywhere (KIMI_CODE_HOME + platform home) and no
        // KIMI_CONFIG_PATH, so no config file can be found.
        let home = test_home("kimi-sdk-load-empty");
        let _env = HomeEnv::apply(
            Some(home.to_str().unwrap()),
            Some(home.to_str().unwrap()),
            Some(home.to_str().unwrap()),
            None,
        );

        let err = load_runtime_config_safe().expect_err("no config anywhere must fail");
        assert!(err.contains("providers"), "unexpected error: {err}");
    }

    #[test]
    fn validate_config_accepts_provider_json() {
        let config = serde_json::json!({
            "providers": {
                "openai": { "type": "openai", "apiKey": "sk-test" },
            },
            "defaultModel": "openai",
        });
        assert!(validate_config(&config).is_ok());
    }

    #[test]
    fn validate_config_accepts_snake_case_aliases() {
        // The serde shape is camelCase-primary with snake_case aliases; both
        // spellings must deserialize onto the same KimiConfig.
        let config = serde_json::json!({
            "providers": {
                "openai": { "type": "openai", "api_key": "sk-test", "default_model": "gpt-4" },
            },
            "default_model": "openai",
        });
        assert!(validate_config(&config).is_ok());
    }

    #[test]
    fn validate_config_rejects_missing_providers() {
        assert!(validate_config(&serde_json::json!({})).is_err());
        assert!(validate_config(&serde_json::json!({ "providers": {} })).is_err());
    }

    #[test]
    fn validate_config_rejects_malformed_json() {
        // Unknown provider type and a non-object root both fail schema parse.
        let bad_type = serde_json::json!({
            "providers": { "x": { "type": "bogus" } },
        });
        assert!(validate_config(&bad_type).is_err());
        assert!(validate_config(&serde_json::json!(42)).is_err());
    }
}
