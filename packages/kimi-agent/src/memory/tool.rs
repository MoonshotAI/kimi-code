//! Native `Memory` tool — persistent memory search and management.
//!
//! Port of `agent-core-v2/src/app/memory/tools/memoryTool.ts`: the model can
//! search, read, write, list, and delete memory entries that persist across
//! sessions. Memory files are markdown documents organized by scope (global,
//! project, session).

use std::sync::Arc;

use crate::callbacks::HostCallbacks;
use crate::memory::paths::{
    MemoryEntry, MemoryScope, build_rel_path, extract_title, project_id_from_cwd,
    sanitize_file_name,
};
use crate::memory::store::MemoryStore;
use crate::rpc::types::{
    BoxFuture, ToolExecuteRequest, ToolExecuteResponse,
};

/// Run one Memory action against the store. Pure — no host callbacks.
fn run_memory_action(
    store: &MemoryStore,
    session_id: Option<&str>,
    cwd: Option<&str>,
    args: &serde_json::Value,
) -> ToolExecuteResponse {
    let action = args.get("action").and_then(|v| v.as_str()).unwrap_or("search");
    match action {
        "search" => handle_search(store, args),
        "read" => handle_read(store, args),
        "write" => handle_write(store, session_id, cwd, args),
        "list" => handle_list(store, session_id, cwd, args),
        "delete" => handle_delete(store, args),
        other => error_response(format!("Unknown Memory action: {other}")),
    }
}

fn ok_response(content: String) -> ToolExecuteResponse {
    ToolExecuteResponse {
        content,
        is_error: false,
        is_prediction: false,
        stop_turn: false,
        media: Vec::new(),
    }
}

fn error_response(content: String) -> ToolExecuteResponse {
    ToolExecuteResponse {
        content,
        is_error: true,
        is_prediction: false,
        stop_turn: false,
        media: Vec::new(),
    }
}

fn scope_from_args(args: &serde_json::Value) -> MemoryScope {
    match args.get("scope").and_then(|v| v.as_str()).unwrap_or("project") {
        "global" => MemoryScope::Global,
        "session" => MemoryScope::Session,
        _ => MemoryScope::Project,
    }
}

fn scope_id_for(scope: MemoryScope, session_id: Option<&str>, cwd: Option<&str>) -> String {
    match scope {
        MemoryScope::Global => String::new(),
        MemoryScope::Project => project_id_from_cwd(cwd.unwrap_or("")),
        MemoryScope::Session => session_id.unwrap_or_default().to_string(),
    }
}

fn scope_label(scope: MemoryScope, scope_id: &str) -> String {
    if scope_id.is_empty() {
        scope.as_str().to_string()
    } else {
        format!("{} ({scope_id})", scope.as_str())
    }
}

fn handle_search(store: &MemoryStore, args: &serde_json::Value) -> ToolExecuteResponse {
    let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
    if query.trim().is_empty() {
        return error_response("Memory search requires a `query`.".into());
    }
    let results = store.search(query, 10);
    if results.is_empty() {
        return ok_response(format!("No memory entries found for query \"{query}\"."));
    }
    let plural = if results.len() == 1 { "y" } else { "ies" };
    let mut lines = vec![format!("Found {} entr{plural}:\n", results.len())];
    for r in &results {
        lines.push(format!("## {}", r.title));
        lines.push(format!("  path: {}", r.path));
        lines.push(format!("  scope: {}", scope_label(r.scope, &r.scope_id)));
        lines.push(format!("  type: {}", r.r#type));
        lines.push(format!("  score: {:.3}", r.score));
        lines.push(format!("  snippet: {}", r.snippet));
        lines.push(String::new());
    }
    ok_response(lines.join("\n"))
}

fn handle_read(store: &MemoryStore, args: &serde_json::Value) -> ToolExecuteResponse {
    let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
    if path.trim().is_empty() {
        return error_response("Memory read requires a `path`.".into());
    }
    match store.get(path) {
        Some(entry) => {
            let lines = vec![
                format!("# {}", entry.title),
                format!("path: {}", entry.path),
                format!("scope: {}", scope_label(entry.scope, &entry.scope_id)),
                format!("type: {}", entry.r#type),
                format!("updated: {}", entry.updated_at),
                String::new(),
                entry.body,
            ];
            ok_response(lines.join("\n"))
        }
        None => ok_response(format!("Memory entry not found: {path}")),
    }
}

fn handle_write(
    store: &MemoryStore,
    session_id: Option<&str>,
    cwd: Option<&str>,
    args: &serde_json::Value,
) -> ToolExecuteResponse {
    let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
    let content = args.get("content").and_then(|v| v.as_str()).unwrap_or("");
    if path.trim().is_empty() {
        return error_response("Memory write requires a `path`.".into());
    }
    if content.trim().is_empty() {
        return error_response("Memory write requires `content`.".into());
    }
    let scope = scope_from_args(args);
    let Some(file_name) = sanitize_file_name(path) else {
        return error_response(format!("Invalid memory filename: {path}"));
    };
    let scope_id = scope_id_for(scope, session_id, cwd);
    let rel_path = build_rel_path(scope, &scope_id, &file_name);
    let entry = MemoryEntry {
        path: rel_path.clone(),
        scope,
        scope_id,
        r#type: crate::memory::paths::detect_type(content),
        title: extract_title(content, &file_name),
        body: content.to_string(),
        fingerprint: String::new(),
        updated_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
    };
    match store.put(&entry) {
        Ok(()) => ok_response(format!(
            "Wrote memory entry: path={rel_path}, title={}, type={}",
            entry.title, entry.r#type
        )),
        Err(e) => error_response(format!("Failed to write memory: {e}")),
    }
}

fn handle_list(
    store: &MemoryStore,
    session_id: Option<&str>,
    cwd: Option<&str>,
    args: &serde_json::Value,
) -> ToolExecuteResponse {
    let scope = scope_from_args(args);
    let scope_id = scope_id_for(scope, session_id, cwd);
    let prefix = match scope {
        MemoryScope::Global => "global/".to_string(),
        MemoryScope::Project => format!("projects/{scope_id}/"),
        MemoryScope::Session => format!("sessions/{scope_id}/"),
    };
    let paths: Vec<String> = store
        .list()
        .into_iter()
        .filter(|p| p.starts_with(&prefix))
        .collect();
    if paths.is_empty() {
        return ok_response(format!(
            "No memory entries in scope {}.",
            scope.as_str()
        ));
    }
    ok_response(format!(
        "Memory entries in scope {} ({}):\n{}",
        scope.as_str(),
        paths.len(),
        paths.join("\n")
    ))
}

fn handle_delete(store: &MemoryStore, args: &serde_json::Value) -> ToolExecuteResponse {
    let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
    if path.trim().is_empty() {
        return error_response("Memory delete requires a `path`.".into());
    }
    match store.delete(path) {
        Ok(true) => ok_response(format!("Deleted memory entry: {path}")),
        Ok(false) => ok_response(format!("Memory entry not found: {path}")),
        Err(e) => error_response(format!("Failed to delete memory: {e}")),
    }
}

/// Intercepts the `Memory` tool and runs it natively.
pub(crate) struct MemoryToolInterceptor {
    pub inner: Arc<dyn HostCallbacks>,
    pub store: MemoryStore,
    pub session_id: Option<String>,
}

impl HostCallbacks for MemoryToolInterceptor {
    fn supports_tool_lifecycle(&self) -> bool {
        self.inner.supports_tool_lifecycle()
    }
    fn llm_chat(
        &self,
        r: crate::rpc::types::LlmChatRequest,
    ) -> BoxFuture<'static, Result<crate::rpc::types::LlmChatResponse, String>> {
        self.inner.llm_chat(r)
    }
    fn execute_tool(
        &self,
        req: ToolExecuteRequest,
    ) -> BoxFuture<'static, Result<ToolExecuteResponse, String>> {
        if !req.tool_name.eq_ignore_ascii_case("Memory") {
            return self.inner.execute_tool(req);
        }
        let store = self.store.clone();
        let session_id = self.session_id.clone();
        let args = req.arguments.clone();
        Box::pin(async move {
            let cwd = args
                .get("cwd")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            Ok(run_memory_action(&store, session_id.as_deref(), cwd.as_deref(), &args))
        })
    }
    fn emit_event(&self, e: serde_json::Value) {
        self.inner.emit_event(e);
    }
    fn prepare_tool_execution(
        &self,
        r: crate::rpc::types::PrepareToolRequest,
    ) -> BoxFuture<'static, Result<Option<crate::rpc::types::PrepareToolResponse>, String>> {
        self.inner.prepare_tool_execution(r)
    }
    fn authorize_tool_execution(
        &self,
        r: crate::rpc::types::AuthorizeToolRequest,
    ) -> BoxFuture<'static, Result<Option<crate::rpc::types::AuthorizeToolResponse>, String>> {
        self.inner.authorize_tool_execution(r)
    }
    fn finalize_tool_result(
        &self,
        r: crate::rpc::types::FinalizeToolRequest,
    ) -> BoxFuture<'static, Result<crate::rpc::types::FinalizeToolResponse, String>> {
        self.inner.finalize_tool_result(r)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_store() -> (tempfile::TempDir, MemoryStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = MemoryStore::new(dir.path().to_str().unwrap());
        (dir, store)
    }

    #[test]
    fn write_then_read_roundtrip() {
        let (_dir, store) = test_store();
        let resp = run_memory_action(
            &store,
            None,
            Some("D:\\repo"),
            &serde_json::json!({
                "action": "write",
                "path": "idea",
                "scope": "global",
                "content": "# Idea\nUse Rust everywhere.\n"
            }),
        );
        assert!(!resp.is_error, "write failed: {}", resp.content);
        assert!(resp.content.contains("global/idea.md"));

        let read = run_memory_action(
            &store,
            None,
            None,
            &serde_json::json!({ "action": "read", "path": "global/idea.md" }),
        );
        assert!(!read.is_error);
        assert!(read.content.contains("Use Rust everywhere."));
    }

    #[test]
    fn search_returns_results() {
        let (_dir, store) = test_store();
        run_memory_action(
            &store,
            None,
            None,
            &serde_json::json!({
                "action": "write",
                "path": "token",
                "scope": "global",
                "content": "# Token rotation\nRotate the API token weekly.\n"
            }),
        );
        let search = run_memory_action(
            &store,
            None,
            None,
            &serde_json::json!({ "action": "search", "query": "rotate" }),
        );
        assert!(!search.is_error);
        assert!(search.content.contains("Token rotation"));
    }

    #[test]
    fn list_filters_by_scope() {
        let (_dir, store) = test_store();
        run_memory_action(
            &store,
            Some("s-42"),
            Some("D:\\repo"),
            &serde_json::json!({
                "action": "write",
                "path": "a.md",
                "scope": "project",
                "content": "# A\nbody"
            }),
        );
        let list = run_memory_action(
            &store,
            Some("s-42"),
            Some("D:\\repo"),
            &serde_json::json!({ "action": "list", "scope": "project" }),
        );
        assert!(list.content.contains("a.md"));
        assert!(list.content.contains("a.md"));
    }

    #[test]
    fn delete_removes_entry() {
        let (_dir, store) = test_store();
        run_memory_action(
            &store,
            None,
            None,
            &serde_json::json!({
                "action": "write",
                "path": "x.md",
                "scope": "global",
                "content": "# X\nbody"
            }),
        );
        let del = run_memory_action(
            &store,
            None,
            None,
            &serde_json::json!({ "action": "delete", "path": "global/x.md" }),
        );
        assert!(del.content.contains("Deleted"));
        let read = run_memory_action(
            &store,
            None,
            None,
            &serde_json::json!({ "action": "read", "path": "global/x.md" }),
        );
        assert!(read.content.contains("not found"));
    }

    #[test]
    fn validation_errors() {
        let (_dir, store) = test_store();
        let resp = run_memory_action(
            &store,
            None,
            None,
            &serde_json::json!({ "action": "search" }),
        );
        assert!(resp.is_error);
        let resp = run_memory_action(
            &store,
            None,
            None,
            &serde_json::json!({ "action": "write", "path": "../evil", "content": "x" }),
        );
        assert!(resp.is_error);
    }
}
