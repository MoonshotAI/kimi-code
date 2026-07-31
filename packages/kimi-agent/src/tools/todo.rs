//! TodoList tool — structured TODO list management.
//!
//! The LLM uses this tool to maintain a visible plan of sub-tasks during
//! plan-mode workflows and multi-step operations. A single tool serves
//! both reads and writes:
//!
//! - `{ todos: [...] }` — replace the full list
//! - `{ todos: [] }` — clear the list
//! - `{}` — query current list (no mutation)
//!
//! Mirrors `packages/agent-core/src/tools/builtin/state/todo-list.ts`.
//!
//! NativeToolset is created per-session, so a single Vec stores the
//! current session's todos without needing a session_id key.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::turn_loop::types::ExecutableToolResult;

// ── Constants ───────────────────────────────────────────────────────────

pub const TODO_LIST_TOOL_NAME: &str = "TodoList";
const TODO_LIST_WRITE_REMINDER: &str =
 "Ensure that you continue to use the todo list to track progress. \
 Mark tasks done immediately after finishing them, and keep exactly one \
 task in_progress when work is underway.";

// ── Types ───────────────────────────────────────────────────────────────

/// Status of a todo item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum TodoStatus {
 #[serde(rename = "pending")]
 Pending,
 #[serde(rename = "in_progress")]
 InProgress,
 #[serde(rename = "done")]
 Done,
}

impl TodoStatus {
 fn marker(&self) -> &'static str {
 match self {
 TodoStatus::Pending => "[pending]",
 TodoStatus::InProgress => "[in_progress]",
 TodoStatus::Done => "[done]",
 }
 }
}

/// A single todo item.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoItem {
 pub title: String,
 pub status: TodoStatus,
}

// ── TodoList store ──────────────────────────────────────────────────────

/// Per-session TODO list store (single list, since NativeToolset is
/// created per-session). Uses `Mutex` for thread-safe interior mutability
/// so `NativeToolset` remains `Clone + Send + Sync`.
#[derive(Debug, Clone)]
pub struct TodoList {
 items: std::sync::Arc<Mutex<Vec<TodoItem>>>,
}

impl TodoList {
 /// Create a new empty TodoList store.
 pub fn new() -> Self {
 Self {
 items: std::sync::Arc::new(Mutex::new(Vec::new())),
 }
 }

 /// Get the current todos.
 pub fn get_todos(&self) -> Vec<TodoItem> {
 // Poisoning-tolerant: recover the inner data instead of propagating
 // a panic from a previous lock holder (crate panic-hygiene rule).
 self.items.lock().unwrap_or_else(|e| e.into_inner()).clone()
 }

 /// Replace the entire todo list.
 pub fn set_todos(&self, todos: Vec<TodoItem>) {
 *self.items.lock().unwrap_or_else(|e| e.into_inner()) = todos;
 }
}

impl Default for TodoList {
 fn default() -> Self {
 Self::new()
 }
}

// ── Tool execution ──────────────────────────────────────────────────────

/// Render a TODO list to a display string.
pub fn render_todo_list(todos: &[TodoItem]) -> String {
 if todos.is_empty() {
 return "Todo list is empty.".to_string();
 }
 let mut lines = vec!["Current todo list:".to_string()];
 for todo in todos {
 lines.push(format!(" {} {}", todo.status.marker(), todo.title));
 }
 lines.join("\n")
}

/// Execute a TodoList tool call.
///
/// - `args` with `"todos"`: replace the full list or clear it.
/// - `args` without `"todos"`: query current list.
/// - Returns rendered output.
pub fn execute_todo_list(
 todo_list: &TodoList,
 args: &Value,
) -> ExecutableToolResult {
 match args.get("todos") {
 // Query mode — return current list without mutation.
 None => {
 let current = todo_list.get_todos();
 ExecutableToolResult {
 content: render_todo_list(&current),
 is_error: false,
 is_prediction: false,
		stop_turn: false, media: Vec::new() }
 }
 Some(todos_value) => {
 // Write mode — replace or clear.
 let new_todos: Vec<TodoItem> = match serde_json::from_value(todos_value.clone()) {
 Ok(t) => t,
 Err(e) => {
 return ExecutableToolResult {
 content: format!("Error parsing todos: {e}"), media: Vec::new(),
 is_error: true,
 is_prediction: false,
		stop_turn: false, };
 }
 };
 todo_list.set_todos(new_todos);
 let stored = todo_list.get_todos();
 let content = if stored.is_empty() {
 "Todo list cleared.".to_string()
 } else {
 format!(
 "Todo list updated.\n{}\n\n{TODO_LIST_WRITE_REMINDER}",
 render_todo_list(&stored),
 )
 };
 ExecutableToolResult {
 content,
 is_error: false,
 is_prediction: false,
		stop_turn: false, media: Vec::new() }
 }
 }
}

/// Return the JSON input schema for the TodoList tool.
pub fn input_schema() -> serde_json::Value {
 serde_json::json!({
 "type": "object",
 "properties": {
 "todos": {
 "type": "array",
 "items": {
 "type": "object",
 "properties": {
 "title": {
 "type": "string",
 "description": "Short, actionable title for the todo."
 },
 "status": {
 "type": "string",
 "enum": ["pending", "in_progress", "done"],
 "description": "Current status of the todo."
 }
 },
 "required": ["title", "status"]
 },
 "description": "The updated todo list. Omit to read the current list without making changes. Pass an empty array to clear the list."
 }
 }
 })
}

// ── Tool definition for NativeToolset registration ──────────────────────

/// The tool name that NativeToolset registers.
pub const TODO_TOOL_NAME: &str = "TodoList";

/// The tool description sent to the LLM.
pub fn description() -> &'static str {
 "Use this tool to maintain a structured TODO list as you work through a multi-step task. \
 Use it proactively and often when progress tracking helps the current work."
}

#[cfg(test)]
mod tests {
 use super::*;
 use serde_json::json;

 #[test]
 fn test_empty_list() {
 let todo_list = TodoList::new();
 let result = execute_todo_list(&todo_list, &json!({}));
 assert!(!result.is_error);
 assert_eq!(result.content, "Todo list is empty.");
 }

 #[test]
 fn test_set_and_read() {
 let todo_list = TodoList::new();
 let todos = json!([
 {"title": "Task 1", "status": "in_progress"},
 {"title": "Task 2", "status": "pending"},
 ]);
 let result = execute_todo_list(&todo_list, &json!({"todos": todos}));
 assert!(!result.is_error);
 assert!(result.content.contains("Task 1"));
 assert!(result.content.contains("Task 2"));

 // Read back
 let result2 = execute_todo_list(&todo_list, &json!({}));
 assert!(!result2.is_error);
 assert!(result2.content.contains("Task 1"));
 }

 #[test]
 fn test_clear_list() {
 let todo_list = TodoList::new();
 // Set some todos
 let todos = json!([
 {"title": "Task 1", "status": "pending"},
 ]);
 execute_todo_list(&todo_list, &json!({"todos": todos}));

 // Clear
 let result = execute_todo_list(&todo_list, &json!({"todos": []}));
 assert!(!result.is_error);
 assert_eq!(result.content, "Todo list cleared.");

 // Verify empty
 let result2 = execute_todo_list(&todo_list, &json!({}));
 assert_eq!(result2.content, "Todo list is empty.");
 }

 #[test]
 fn test_invalid_todo_input() {
 let todo_list = TodoList::new();
 let result = execute_todo_list(
 &todo_list,
 &json!({"todos": [{"title": "Missing status"}]}),
 );
 assert!(result.is_error);
 assert!(result.content.contains("Error"));
 }

 #[test]
 fn test_status_markers() {
 assert_eq!(TodoStatus::Pending.marker(), "[pending]");
 assert_eq!(TodoStatus::InProgress.marker(), "[in_progress]");
 assert_eq!(TodoStatus::Done.marker(), "[done]");
 }

 #[test]
 fn test_render_empty() {
 assert_eq!(render_todo_list(&[]), "Todo list is empty.");
 }

 #[test]
 fn test_render_with_items() {
 let todos = vec![
 TodoItem {
 title: "Alpha".into(),
 status: TodoStatus::InProgress,
 },
 TodoItem {
 title: "Beta".into(),
 status: TodoStatus::Pending,
 },
 ];
 let rendered = render_todo_list(&todos);
 assert!(rendered.contains("Alpha"));
 assert!(rendered.contains("Beta"));
 assert!(rendered.contains("[in_progress]"));
 assert!(rendered.contains("[pending]"));
 }
}