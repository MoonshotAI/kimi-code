/// Async stdio JSON-RPC server for kimi-agent.
///
/// Reads JSON-RPC 2.0 requests from stdin, dispatches them to registered
/// handlers, and writes responses to stdout. Supports concurrent request
/// processing: multiple `call_host` requests can be in-flight simultaneously,
/// with responses matched by request ID.
///
/// Uses tokio for async I/O:
///   - `incoming_loop` (spawned): reads stdin, routes to pending or handler
///   - `call_host`: sends request to stdout, registers oneshot, awaits reply
///   - handlers run in spawned tasks so stdin reading is never blocked

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use tokio::io::AsyncBufReadExt;
use tokio::sync::oneshot;

use crate::rpc::types::*;

type AsyncMethodHandler = Arc<dyn Fn(serde_json::Value) -> crate::rpc::types::BoxFuture<'static, Result<serde_json::Value, JsonRpcError>> + Send + Sync>;

/// The async JSON-RPC server.
pub struct RpcServer {
    methods: Mutex<HashMap<String, AsyncMethodHandler>>,
    pending: Arc<Mutex<HashMap<u32, oneshot::Sender<Result<serde_json::Value, String>>>>>,
    next_id: AtomicU32,
}

impl RpcServer {
    /// Create a new RPC server with no handlers registered.
    pub fn new() -> Self {
        Self {
            methods: Mutex::new(HashMap::new()),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU32::new(1),
        }
    }

    /// Register an async handler for a method.
    pub fn register<F, Fut>(&mut self, method: &str, handler: F)
    where
        F: Fn(serde_json::Value) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = Result<serde_json::Value, JsonRpcError>> + Send + 'static,
    {
        self.methods
            .lock()
            .unwrap()
            .insert(
                method.to_string(),
                Arc::new(move |params| Box::pin(handler(params))),
            );
    }

    /// Register an async handler on an Arc-wrapped server.
    pub fn register_arc<F, Fut>(server: &Arc<Self>, method: &str, handler: F)
    where
        F: Fn(serde_json::Value) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = Result<serde_json::Value, JsonRpcError>> + Send + 'static,
    {
        server
            .methods
            .lock()
            .unwrap()
            .insert(
                method.to_string(),
                Arc::new(move |params| Box::pin(handler(params))),
            );
    }

    /// Send a JSON-RPC request to the host (JS side) and wait for a response.
    ///
    /// Unlike the synchronous version, this does NOT block the thread. It
    /// registers a oneshot channel, writes the request to stdout, and returns
    /// a Future that resolves when the matching response arrives from stdin.
    ///
    /// Multiple concurrent `call_host` calls are supported — responses are
    /// matched by their unique request ID.
    pub async fn call_host(
        &self,
        method: &str,
        params: &impl serde::Serialize,
    ) -> Result<serde_json::Value, String> {
        let params = serde_json::to_value(params).map_err(|e| e.to_string())?;
        self.call_host_value(method, params).await
    }

    /// Directly invoke a locally-registered handler by method name.
    /// Returns `method_not_found` if no handler is registered.
    pub async fn direct_call(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, JsonRpcError> {
        let handler = {
            self.methods
                .lock()
                .map_err(|e| JsonRpcError::internal_error(format!("lock error: {e}")))?
                .get(method)
                .cloned()
        };
        match handler {
            Some(h) => h(params).await,
            None => Err(JsonRpcError::method_not_found(method)),
        }
    }

    /// Send a JSON-RPC request to the host using an already-serialized params value.
    /// This is the lower-level building block behind `call_host`.
    async fn call_host_value(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();

        self.pending
            .lock()
            .map_err(|e| format!("lock error: {e}"))?
            .insert(id, tx);

        let request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });

        println!(
            "{}",
            serde_json::to_string(&request).map_err(|e| e.to_string())?
        );

        rx.await.map_err(|_| "response channel closed".to_string())?
    }

    /// Invoke a method, preferring a locally-registered handler and falling
    /// back to a host call over stdio when no local handler exists.
    ///
    /// This unifies the two execution paths:
    ///   - In tests, handlers are registered via `register_arc`; `invoke`
    ///     dispatches directly to them without needing a running stdio loop.
    ///   - In production, no local handler is registered for `host/*` methods,
    ///     so `invoke` transparently falls back to `call_host` (stdio round-trip).
    pub async fn invoke(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, JsonRpcError> {
        let handler = {
            self.methods
                .lock()
                .map_err(|e| JsonRpcError::internal_error(format!("lock error: {e}")))?
                .get(method)
                .cloned()
        };
        if let Some(h) = handler {
            return h(params).await;
        }
        // Fall back to host call over stdio.
        self.call_host_value(method, params)
            .await
            .map_err(JsonRpcError::internal_error)
    }

    /// Run the server: spawns the stdin reader loop and runs forever.
    ///
    /// Each incoming line is dispatched to the appropriate handler in a
    /// spawned tokio task, so the stdin reader is never blocked.
    pub async fn run(self: Arc<Self>) -> anyhow::Result<()> {
        let server = self;
        let mut reader = tokio::io::BufReader::new(tokio::io::stdin());
        let mut line = String::new();

        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) => {
                    // EOF (stdin closed)
                    break;
                }
                Ok(_) => {
                    let trimmed = line.trim().to_string();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let s = server.clone();
                    tokio::spawn(async move {
                        Self::handle_incoming(s, trimmed).await;
                    });
                }
                Err(e) => {
                    eprintln!("stdin read error: {e}");
                    break;
                }
            }
        }

        Ok(())
    }

    /// Handle one incoming line from stdin.
    ///
    /// Two cases:
    ///   1. Response to a pending `call_host` — matched by `id`, wakes the waiter.
    ///   2. Request from the host — dispatched to the registered handler.
    async fn handle_incoming(server: Arc<Self>, line: String) {
        // Parse the JSON value
        let parsed: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                let err = JsonRpcErrorResponse::new(
                    serde_json::Value::Null,
                    -32700,
                    format!("Parse error: {e}"),
                );
                Self::write_line(&serde_json::to_string(&err).unwrap_or_default());
                return;
            }
        };

        // Discriminate on `method` first (see `is_response_message`) so a host
        // request whose numeric id collides with a pending `call_host` id is
        // not mis-consumed as that call's response.
        if Self::is_response_message(&parsed) {
            // Case 1: Response to a pending call_host
            if let Some(id_val) = parsed.get("id") {
                if let Some(id) = id_val.as_u64() {
                    let mut pending = match server.pending.lock() {
                        Ok(p) => p,
                        Err(_) => return,
                    };
                    if let Some(tx) = pending.remove(&(id as u32)) {
                        if let Some(error) = parsed.get("error") {
                            let msg = error
                                .get("message")
                                .and_then(|m| m.as_str())
                                .unwrap_or("unknown error");
                            let _ = tx.send(Err(msg.to_string()));
                        } else {
                            let _ = tx.send(Ok(parsed
                                .get("result")
                                .cloned()
                                .unwrap_or(serde_json::Value::Null)));
                        }
                    }
                }
            }
            return;
        }

        // Case 2: Request from the host
        let request: JsonRpcRequest = match serde_json::from_value(parsed) {
            Ok(req) => req,
            Err(e) => {
                let err = JsonRpcErrorResponse::new(
                    serde_json::Value::Null,
                    -32600,
                    format!("Invalid Request: {e}"),
                );
                Self::write_line(&serde_json::to_string(&err).unwrap_or_default());
                return;
            }
        };

        // Check for notification (no `id` field)
        if request.id.is_null() {
            return; // Notifications are fire-and-forget
        }

        let response = {
            let handler = server.methods.lock().unwrap().get(&request.method).cloned();
            match handler {
                Some(handler) => {
                    match handler(request.params.clone()).await {
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
                    }
                }
                None => {
                    let err = JsonRpcErrorResponse::new(
                        request.id.clone(),
                        -32601,
                        format!("Method not found: {}", request.method),
                    );
                    serde_json::to_value(&err).unwrap_or_default()
                }
            }
        };

        Self::write_line(&serde_json::to_string(&response).unwrap_or_default());
    }

    /// Write a single line to stdout.
    fn write_line(line: &str) {
        println!("{line}");
    }

    /// A JSON-RPC response carries no `method` field; a request always does.
    /// Used to route an incoming line before matching ids, so a host request
    /// whose numeric id collides with a pending `call_host` id is not
    /// mis-consumed as that call's response.
    fn is_response_message(parsed: &serde_json::Value) -> bool {
        parsed.get("method").is_none()
    }

    /// Send a notification to the host (JS side) — fire-and-forget.
    pub async fn notify(method: &str, params: &impl serde::Serialize) -> anyhow::Result<()> {
        let notification = serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        println!("{}", serde_json::to_string(&notification)?);
        Ok(())
    }

    /// Synchronous variant of [`notify`] for non-async call sites
    /// (e.g. `HostCallbacks::emit_event`). Serialization failures are
    /// swallowed — a lost notification must never break the turn loop.
    pub fn notify_now(method: &str, params: &impl serde::Serialize) {
        let notification = serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        if let Ok(line) = serde_json::to_string(&notification) {
            println!("{line}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use serde_json::json;

    #[tokio::test]
    async fn test_register_and_call_handler() {
        let mut server = RpcServer::new();
        server.register("test/echo", |params| {
            Box::pin(async move { Ok(params) })
        });

        let server = Arc::new(server);
        let params = json!({"key": "value"});

        // Simulate what handle_incoming does: find handler, call it
        let handler = {
            server.methods.lock().unwrap().get("test/echo").cloned()
        };
        assert!(handler.is_some());

        let result = handler.unwrap()(params.clone()).await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), params);
    }

    #[tokio::test]
    async fn test_handler_not_found() {
        let mut server = RpcServer::new();
        server.register("test/echo", |params| {
            Box::pin(async move { Ok(params) })
        });

        let server = Arc::new(server);
        let handler = {
            server.methods.lock().unwrap().get("test/nonexistent").cloned()
        };
        assert!(handler.is_none());
    }

    #[tokio::test]
    async fn test_handler_error() {
        let mut server = RpcServer::new();
        server.register("test/error", |_| {
            Box::pin(async move {
                Err(JsonRpcError::internal_error("test error".to_string()))
            })
        });

        let server = Arc::new(server);
        let handler = {
            server.methods.lock().unwrap().get("test/error").cloned()
        };
        assert!(handler.is_some());

        let result = handler.unwrap()(json!({})).await;
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().message, "test error");
    }

    #[test]
    fn test_pending_map_insert_and_remove() {
        let pending: Arc<Mutex<HashMap<u32, oneshot::Sender<Result<serde_json::Value, String>>>>> = 
            Arc::new(Mutex::new(HashMap::new()));
        
        let (tx, _rx) = oneshot::channel();
        pending.lock().unwrap().insert(42u32, tx);
        assert!(pending.lock().unwrap().contains_key(&42));
        
        let removed = pending.lock().unwrap().remove(&42);
        assert!(removed.is_some());
        assert!(!pending.lock().unwrap().contains_key(&42));
    }

    #[test]
    fn test_next_id_monotonic() {
        let server = RpcServer::new();
        let id1 = server.next_id.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let id2 = server.next_id.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        assert!(id2 > id1);
    }

    #[tokio::test]
    async fn test_concurrent_handlers() {
        let mut server = RpcServer::new();
        server.register("test/slow", |params| {
            Box::pin(async move {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                Ok(params)
            })
        });
        server.register("test/fast", |params| {
            Box::pin(async move {
                Ok(params)
            })
        });

        let server = Arc::new(server);
        let h1 = {
            let params = json!({"id": 1});
            server.methods.lock().unwrap().get("test/slow").cloned().unwrap()(params)
        };
        let h2 = {
            let params = json!({"id": 2});
            server.methods.lock().unwrap().get("test/fast").cloned().unwrap()(params)
        };

        let (r1, r2) = tokio::join!(h1, h2);
        assert!(r1.is_ok());
        assert!(r2.is_ok());
        assert_eq!(r1.unwrap().get("id").unwrap(), 1);
        assert_eq!(r2.unwrap().get("id").unwrap(), 2);
    }

    #[tokio::test]
    async fn test_register_arc_works() {
        let server = Arc::new(RpcServer::new());
        
        RpcServer::register_arc(&server, "test/arc", |params| {
            Box::pin(async move { Ok(params) })
        });

        let handler = {
            server.methods.lock().unwrap().get("test/arc").cloned()
        };
        assert!(handler.is_some());

        let result = handler.unwrap()(json!({"ok": true})).await;
        assert!(result.is_ok());
    }

    #[test]
    fn test_is_response_message_discriminates_on_method() {
        // A message carrying `method` is a request even when it also has an id
        // that could collide with a pending call_host id.
        assert!(!RpcServer::is_response_message(
            &json!({"jsonrpc": "2.0", "id": 1, "method": "host/execute_tool", "params": {}})
        ));
        // A message with an id and no `method` is a response.
        assert!(RpcServer::is_response_message(
            &json!({"jsonrpc": "2.0", "id": 1, "result": {}})
        ));
        // An error response (no method) is a response too.
        assert!(RpcServer::is_response_message(
            &json!({"jsonrpc": "2.0", "id": 1, "error": {"code": -1, "message": "x"}})
        ));
    }

    #[tokio::test]
    async fn test_run_turn_registration_retains_self_reference() {
        // Reproduce main.rs's RUN_TURN registration: the handler captures a
        // clone of the server Arc (to spawn tool/LLM callbacks), which makes the
        // server self-referential. `Arc::into_inner` would therefore return
        // None — that is why `run` takes `Arc<Self>` instead of owning `self`.
        let server = Arc::new(RpcServer::new());
        let captured = server.clone();
        RpcServer::register_arc(&server, "agent/run_turn", move |params| {
            let _server = captured.clone();
            Box::pin(async move { Ok(params) })
        });
        assert!(Arc::strong_count(&server) >= 2);
        assert!(Arc::into_inner(server).is_none());
    }

    #[test]
    fn test_error_codes() {
        let parse_err = JsonRpcError::parse_error();
        assert_eq!(parse_err.code, -32700);
        assert_eq!(parse_err.message, "Parse error");

        let invalid = JsonRpcError::invalid_request();
        assert_eq!(invalid.code, -32600);
        assert_eq!(invalid.message, "Invalid Request");

        let not_found = JsonRpcError::method_not_found("test");
        assert_eq!(not_found.code, -32601);
        assert!(not_found.message.contains("test"));

        let internal = JsonRpcError::internal_error("oops".to_string());
        assert_eq!(internal.code, -32603);
        assert_eq!(internal.message, "oops");
    }

    #[test]
    fn test_response_ok() {
        let resp = JsonRpcResponse::ok(json!(1), json!({"result": "ok"}));
        assert_eq!(resp.jsonrpc, "2.0");
        assert_eq!(resp.id, json!(1));
        assert_eq!(resp.result, json!({"result": "ok"}));
    }

    #[test]
    fn test_error_response() {
        let err = JsonRpcErrorResponse::new(json!(null), -32700, "parse error".to_string());
        assert_eq!(err.jsonrpc, "2.0");
        assert_eq!(err.error.code, -32700);
        assert_eq!(err.error.message, "parse error");
    }
}