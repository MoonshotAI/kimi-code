//! Config method family — engine config read, ported from the engine's
//! `config/get` handler. The engine owns the config source of truth
//! (`kimi_agent::config::loader`); this processor is the host-facing surface.

use kimi_protocol::rpc::JsonRpcError;

use crate::processor::{MessageProcessor, Processor};

/// Strip null-valued delete markers from a config patch and apply the
/// deletes to the base config (port of main.rs `strip_null_deletes`).
fn strip_null_deletes(
    patch: serde_json::Value,
    base: &mut kimi_agent::config::types::KimiConfig,
) -> kimi_agent::config::types::KimiConfig {
    if let Some(patch_obj) = patch.as_object() {
        for (section, _) in [("providers", "providers"), ("models", "model_aliases")] {
            if let Some(section_val) = patch_obj.get(section).and_then(|v| v.as_object()) {
                let deletes: Vec<&String> = section_val
                    .iter()
                    .filter(|(_, v)| v.is_null())
                    .map(|(k, _)| k)
                    .collect();
                if !deletes.is_empty() {
                    match section {
                        "providers" => {
                            if let Some(map) = base.providers.as_mut() {
                                for key in deletes {
                                    map.remove(key);
                                }
                            }
                        }
                        _ => {
                            if let Some(map) = base.model_aliases.as_mut() {
                                for key in deletes {
                                    map.remove(key);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    match patch {
        serde_json::Value::Object(mut obj) => {
            for section in ["providers", "models"] {
                if let Some(section_val) = obj.get_mut(section).and_then(|v| v.as_object_mut()) {
                    section_val.retain(|_, v| !v.is_null());
                }
            }
            serde_json::from_value(serde_json::Value::Object(obj))
                .unwrap_or_else(|_| kimi_agent::config::types::KimiConfig::empty())
        }
        _ => serde_json::from_value(patch)
            .unwrap_or_else(|_| kimi_agent::config::types::KimiConfig::empty()),
    }
}

/// Config methods.
pub struct ConfigProcessor;

impl Processor for ConfigProcessor {
    fn register(&self, processor: &mut MessageProcessor) {
        // `config/get` — the engine's parsed config.toml (KimiConfig shape).
        // Unvalidated load: an empty fresh home must return defaults, not
        // "No providers configured" (TS parity).
        processor.register(kimi_protocol::methods::CONFIG_GET, |_params| async move {
            match kimi_agent::config::loader::load_config_with_env_unvalidated() {
                Ok(config) => serde_json::to_value(&config)
                    .map_err(|e| JsonRpcError::internal_error(format!("Serialize error: {e}"))),
                Err(error) => Err(JsonRpcError::internal_error(format!("config load: {error}"))),
            }
        });

        // `config/set` — merge a patch and write it back to disk.
        processor.register(kimi_protocol::methods::CONFIG_SET, move |params| {
            Box::pin(async move {
                let input: kimi_protocol::wire_types::ConfigSetParams =
                    serde_json::from_value(params)
                        .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let mut base = kimi_agent::config::loader::load_config_with_env_unvalidated()
                    .map_err(|e| JsonRpcError::internal_error(format!("config load: {e}")))?;
                let patch = strip_null_deletes(input.patch, &mut base);
                let merged = kimi_agent::config::merge::merge_configs(base, patch);
                let toml_str = kimi_agent::config::toml::serialize_config(&merged)
                    .map_err(|e| JsonRpcError::internal_error(format!("serialize: {e}")))?;
                // Write target: `KIMI_CONFIG_PATH` when set (explicit file),
                // else the user-level config (`$KIMI_CODE_HOME/config.toml`
                // or `~/.kimi-code/config.toml`) — the durable,
                // cwd-independent target (TS parity). Project-level
                // `.kimi-code/` in the cwd is a load-time override, not the
                // set target.
                let path = {
                    let explicit = std::env::var("KIMI_CONFIG_PATH").map(std::path::PathBuf::from);
                    match explicit {
                        Ok(p) => p,
                        Err(_) => {
                            let dir = std::env::var("KIMI_CODE_HOME")
                                .map(std::path::PathBuf::from)
                                .or_else(|_| {
                                    std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                                        .map(|h| std::path::PathBuf::from(h).join(".kimi-code"))
                                })
                                .unwrap_or_else(|_| std::path::PathBuf::from(".kimi-code"));
                            dir.join("config.toml")
                        }
                    }
                };
                // Create the `.kimi-code/` parent so the write lands on a fresh
                // checkout (main.rs parity gap fixed here).
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent)
                        .map_err(|e| JsonRpcError::internal_error(format!("mkdir: {e}")))?;
                }
                std::fs::write(&path, toml_str)
                    .map_err(|e| JsonRpcError::internal_error(format!("write: {e}")))?;
                Ok(serde_json::json!({ "ok": true, "path": path.display().to_string() }))
            })
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kimi_protocol::rpc::JsonRpcRequest;

    #[tokio::test]
    async fn config_get_returns_kimi_config() {
        let _guard = CONFIG_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut processor = MessageProcessor::new();
        ConfigProcessor.register(&mut processor);
        let body = processor
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(1),
                method: "config/get".into(),
                params: serde_json::Value::Null,
            })
            .await;
        // KimiConfig serializes to an object; no error envelope.
        assert!(body.get("error").is_none(), "config/get should not error: {body}");
        assert!(body["result"].is_object() || body["result"].is_null());
    }

    /// Serializes tests that touch `KIMI_CONFIG_PATH` (process-global env).
    static CONFIG_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[tokio::test]
    async fn config_set_writes_file_and_persists() {
        let _guard = CONFIG_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // Point the highest-priority config path at a temp file so the write
        // lands where we can assert on it.
        let tmp = std::env::temp_dir().join(format!("kimi-config-set-{}", std::process::id()));
        std::fs::write(
            &tmp,
            "[providers.mock]\ntype = \"openai\"\nbaseUrl = \"http://localhost:9999/v1\"\n",
        )
        .expect("seed config");
        let previous = std::env::var_os("KIMI_CONFIG_PATH");
        std::env::set_var("KIMI_CONFIG_PATH", &tmp);

        async {
            let mut processor = MessageProcessor::new();
            ConfigProcessor.register(&mut processor);
            let body = processor
                .handle(JsonRpcRequest {
                    jsonrpc: "2.0".into(),
                    id: serde_json::json!(1),
                    method: "config/set".into(),
                    params: serde_json::json!({
                        "patch": { "defaultModel": "kimi-k2" }
                    }),
                })
                .await;
            assert!(body.get("error").is_none(), "config/set failed: {body}");
            assert_eq!(body["result"]["ok"], true);

            // The patch value lands on disk.
            let on_disk = std::fs::read_to_string(&tmp).expect("read back");
            assert!(
                on_disk.contains("defaultModel") && on_disk.contains("kimi-k2"),
                "patched value persisted: {on_disk}"
            );

            // And config/get reflects it.
            let body = processor
                .handle(JsonRpcRequest {
                    jsonrpc: "2.0".into(),
                    id: serde_json::json!(2),
                    method: "config/get".into(),
                    params: serde_json::Value::Null,
                })
                .await;
            assert_eq!(body["result"]["defaultModel"], "kimi-k2", "get: {body}");
        }
        .await;

        match previous {
            Some(v) => std::env::set_var("KIMI_CONFIG_PATH", v),
            None => std::env::remove_var("KIMI_CONFIG_PATH"),
        }
        let _ = std::fs::remove_file(&tmp);
    }

    /// The engine config schema has no `permission` section — upstream's
    /// `default_permission_mode` / yolo derivation is a host projection. The
    /// engine must still tolerate a host-passed patch carrying such keys:
    /// unknown fields are dropped without an error and existing values are
    /// preserved.
    #[tokio::test]
    async fn config_set_tolerates_host_unknown_fields() {
        let _guard = CONFIG_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = std::env::temp_dir().join(format!("kimi-config-lenient-{}", std::process::id()));
        std::fs::write(
            &tmp,
            "[providers.mock]\ntype = \"openai\"\nbaseUrl = \"http://localhost:9999/v1\"\n",
        )
        .expect("seed config");
        let previous = std::env::var_os("KIMI_CONFIG_PATH");
        std::env::set_var("KIMI_CONFIG_PATH", &tmp);

        async {
            let mut processor = MessageProcessor::new();
            ConfigProcessor.register(&mut processor);
            let body = processor
                .handle(JsonRpcRequest {
                    jsonrpc: "2.0".into(),
                    id: serde_json::json!(1),
                    method: "config/set".into(),
                    params: serde_json::json!({
                        "patch": {
                            "default_permission_mode": "yolo",
                            "defaultModel": "kimi-k2",
                        }
                    }),
                })
                .await;
            assert!(body.get("error").is_none(), "lenient set failed: {body}");

            // The known field survived; the unknown one is dropped, and a
            // subsequent get still reflects the known value.
            let on_disk = std::fs::read_to_string(&tmp).expect("read back");
            assert!(on_disk.contains("defaultModel"), "known field kept: {on_disk}");
            let body = processor
                .handle(JsonRpcRequest {
                    jsonrpc: "2.0".into(),
                    id: serde_json::json!(2),
                    method: "config/get".into(),
                    params: serde_json::Value::Null,
                })
                .await;
            assert_eq!(body["result"]["defaultModel"], "kimi-k2", "get: {body}");
        }
        .await;

        match previous {
            Some(v) => std::env::set_var("KIMI_CONFIG_PATH", v),
            None => std::env::remove_var("KIMI_CONFIG_PATH"),
        }
        let _ = std::fs::remove_file(&tmp);
    }
}
