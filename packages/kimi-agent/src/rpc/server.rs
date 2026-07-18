/// stdio JSON-RPC server for kimi-agent.
///
/// Synchronous implementation using std::io::BufReader on stdin.
/// Reads JSON-RPC 2.0 requests from stdin, dispatches them to registered
/// handlers, and writes responses to stdout.

use std::collections::HashMap;
use std::sync::Mutex;

use crate::rpc::types::*;

/// A handler for a specific RPC method.
type MethodHandler = Box<dyn Fn(serde_json::Value) -> Result<serde_json::Value, JsonRpcError> + Send>;

/// The JSON-RPC server that reads from stdin and writes to stdout.
pub struct RpcServer {
    methods: Mutex<HashMap<String, MethodHandler>>,
}

impl RpcServer {
    /// Create a new RPC server with no handlers registered.
    pub fn new() -> Self {
        Self {
            methods: Mutex::new(HashMap::new()),
        }
    }

    /// Register a handler for a method.
    pub fn register<F>(&self, method: &str, handler: F)
    where
        F: Fn(serde_json::Value) -> Result<serde_json::Value, JsonRpcError> + Send + 'static,
    {
        let mut methods = self.methods.lock().unwrap();
        methods.insert(method.to_string(), Box::new(handler));
    }

    /// Run the server loop: read JSON-RPC requests from stdin, handle them.
    pub fn run(&self) -> anyhow::Result<()> {
        use std::io::BufRead;

        let stdin = std::io::stdin();
        let reader = std::io::BufReader::new(stdin.lock());

        for line in reader.lines() {
            let line = line?.trim().to_string();
            if line.is_empty() {
                continue;
            }

            // Try to parse as a JSON-RPC request
            let parsed: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(e) => {
                    let err = JsonRpcErrorResponse::new(
                        serde_json::Value::Null,
                        -32700,
                        format!("Parse error: {e}"),
                    );
                    Self::write_response(&err);
                    continue;
                }
            };

            // Check if it's a notification (no `id` field)
            if parsed.get("id").is_none() {
                // Notifications are fire-and-forget, no response needed
                continue;
            }

            // Parse as a request
            let request: JsonRpcRequest = match serde_json::from_value(parsed) {
                Ok(req) => req,
                Err(e) => {
                    let err = JsonRpcErrorResponse::new(
                        serde_json::Value::Null,
                        -32600,
                        format!("Invalid Request: {e}"),
                    );
                    Self::write_response(&err);
                    continue;
                }
            };

            // Dispatch
            let response = self.handle_request(&request);
            Self::write_response(&response);
        }

        Ok(())
    }

    /// Handle a single JSON-RPC request.
    fn handle_request(&self, request: &JsonRpcRequest) -> serde_json::Value {
        let methods = self.methods.lock().unwrap();
        match methods.get(&request.method) {
            Some(handler) => match handler(request.params.clone()) {
                Ok(result) => {
                    let resp = JsonRpcResponse::ok(request.id.clone(), result);
                    serde_json::to_value(&resp).unwrap_or_default()
                }
                Err(err) => {
                    let resp = JsonRpcErrorResponse {
                        jsonrpc: "2.0".into(),
                        id: request.id.clone(),
                        error: err,
                    };
                    serde_json::to_value(&resp).unwrap_or_default()
                }
            },
            None => {
                let err = JsonRpcErrorResponse::new(
                    request.id.clone(),
                    -32601,
                    format!("Method not found: {}", request.method),
                );
                serde_json::to_value(&err).unwrap_or_default()
            }
        }
    }

    /// Write a JSON-RPC response/notification to stdout.
    fn write_response(response: &impl serde::Serialize) {
        let json = serde_json::to_string(response).unwrap_or_default();
        println!("{json}");
    }

    /// Send a notification to the host (JS side).
    pub fn notify(method: &str, params: &impl serde::Serialize) -> anyhow::Result<()> {
        let notification = serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        println!("{}", serde_json::to_string(&notification)?);
        Ok(())
    }

    /// Send a JSON-RPC request to the host (JS side) and wait for a response.
    ///
    /// This is used by the LLM proxy: the Rust loop needs to call the LLM,
    /// so it sends a `host/llm_chat` request to stdout and reads the response
    /// from stdin.
    ///
    /// This is a blocking call that reads stdin directly.
    pub fn call_host(
        method: &str,
        params: &impl serde::Serialize,
    ) -> Result<serde_json::Value, String> {
        use std::io::BufRead;

        let id: u32 = fastrand::u32(1..u32::MAX);
        let request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });

        // Write request to stdout
        println!("{}", serde_json::to_string(&request).map_err(|e| e.to_string())?);

        // Read response from stdin
        let stdin = std::io::stdin();
        let reader = std::io::BufReader::new(stdin.lock());

        for line in reader.lines() {
            let line = line.map_err(|e| e.to_string())?;
            let trimmed = line.trim().to_string();
            if trimmed.is_empty() {
                continue;
            }

            let parsed: serde_json::Value =
                serde_json::from_str(&trimmed).map_err(|e| format!("Parse error: {e}"))?;

            // Look for a response with matching id
            if let Some(resp_id) = parsed.get("id") {
                if resp_id == id {
                    if let Some(error) = parsed.get("error") {
                        return Err(error
                            .get("message")
                            .and_then(|m| m.as_str())
                            .unwrap_or("unknown error")
                            .to_string());
                    }
                    return Ok(parsed
                        .get("result")
                        .cloned()
                        .unwrap_or(serde_json::Value::Null));
                }
            }
        }

        Err("stdin closed".to_string())
    }
}