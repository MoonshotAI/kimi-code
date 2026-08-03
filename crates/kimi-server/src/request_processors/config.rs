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
        processor.register(kimi_protocol::methods::CONFIG_GET, |_params| async move {
            match kimi_agent::config::loader::load_config_with_env() {
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
                let mut base = kimi_agent::config::loader::load_config_with_env()
                    .map_err(|e| JsonRpcError::internal_error(format!("config load: {e}")))?;
                let patch = strip_null_deletes(input.patch, &mut base);
                let merged = kimi_agent::config::merge::merge_configs(base, patch);
                let toml_str = kimi_agent::config::toml::serialize_config(&merged)
                    .map_err(|e| JsonRpcError::internal_error(format!("serialize: {e}")))?;
                let path = kimi_agent::config::loader::find_config_paths()
                    .into_iter()
                    .next()
                    .ok_or_else(|| JsonRpcError::internal_error("no config path found".into()))?;
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
}
