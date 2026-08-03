//! Filesystem method family — read-class operations against a workspace
//! root via the engine's native toolset (Read/Glob/FsSearch). No session
//! state needed; the root comes from the request params.

use kimi_protocol::rpc::JsonRpcError;
use kimi_protocol::wire_types::SessionFsParams;

use crate::processor::{MessageProcessor, Processor};

/// Filesystem methods.
pub struct FsProcessor;

impl Processor for FsProcessor {
    fn register(&self, processor: &mut MessageProcessor) {
        // `session/fs` — read / list / search against the workspace root.
        processor.register(kimi_protocol::methods::SESSION_FS, move |params| {
            Box::pin(async move {
                let input: SessionFsParams = serde_json::from_value(params)
                    .map_err(|e| JsonRpcError::internal_error(format!("Invalid params: {e}")))?;
                let root = input.homedir.clone().unwrap_or_default();
                let toolset = kimi_agent::tools::NativeToolset::new(&root)
                    .ok_or_else(|| JsonRpcError::internal_error("fs: bad workspace root".into()))?;
                let mut args = serde_json::Map::new();
                if let Some(path) = input.path.clone() {
                    args.insert("path".to_string(), serde_json::Value::String(path));
                }
                if let Some(offset) = input.line_offset {
                    args.insert("line_offset".to_string(), serde_json::json!(offset));
                }
                if let Some(n) = input.n_lines {
                    args.insert("n_lines".to_string(), serde_json::json!(n));
                }
                let tool_name = match input.action.as_str() {
                    "read" => "Read",
                    "list" => "Glob",
                    "search" => "FsSearch",
                    other => {
                        return Err(JsonRpcError::internal_error(format!(
                            "fs: unsupported action {other}"
                        )))
                    }
                };
                if let Some(query) = input.query.clone() {
                    args.insert("query".to_string(), serde_json::Value::String(query));
                }
                if let Some(limit) = input.limit {
                    args.insert("limit".to_string(), serde_json::json!(limit));
                }
                let result = toolset
                    .execute(tool_name, &serde_json::Value::Object(args))
                    .unwrap_or_else(|| {
                        // `None` means the tool refused the target (directory,
                        // binary, oversized, sandbox escape). That is a
                        // host-visible tool failure, not an RPC failure: surface
                        // it as an in-band `is_error` result.
                        kimi_agent::turn_loop::types::ExecutableToolResult {
                            content: format!("fs: {tool_name} refused the path"),
                            is_error: true,
                            is_prediction: false,
                            stop_turn: false,
                            media: vec![],
                        }
                    });
                Ok(serde_json::json!({
                    "action": input.action,
                    "content": result.content,
                    "is_error": result.is_error,
                }))
            })
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kimi_protocol::rpc::JsonRpcRequest;

    #[tokio::test]
    async fn fs_read_missing_file_is_in_band_error() {
        let mut server = MessageProcessor::new();
        FsProcessor.register(&mut server);
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(1),
                method: "session/fs".into(),
                params: serde_json::json!({
                    "session_id": "x",
                    "action": "read",
                    "homedir": std::env::temp_dir().to_string_lossy(),
                    "path": "__kimi_fs_missing__",
                }),
            })
            .await;
        // Missing file -> tool refused -> in-band is_error (not an RPC error).
        assert!(body.get("error").is_none(), "fs should not RPC-error: {body}");
        assert_eq!(body["result"]["action"], "read");
        assert!(body["result"]["content"].is_string());
    }

    #[tokio::test]
    async fn fs_unsupported_action_is_rpc_error() {
        let mut server = MessageProcessor::new();
        FsProcessor.register(&mut server);
        let body = server
            .handle(JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: serde_json::json!(1),
                method: "session/fs".into(),
                params: serde_json::json!({
                    "session_id": "x",
                    "action": "bogus",
                    "homedir": std::env::temp_dir().to_string_lossy(),
                }),
            })
            .await;
        assert_eq!(body["error"]["message"], "fs: unsupported action bogus");
    }
}
