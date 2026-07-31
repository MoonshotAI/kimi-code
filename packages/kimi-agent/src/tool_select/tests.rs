use std::collections::HashSet;
use std::sync::Mutex;

use super::*;
use crate::context::dynamic_tools::LOADABLE_TOOLS_TRIGGER;

// ── Fixtures ───────────────────────────────────────────────────────────────

/// Host with a configurable registry and per-tool activity.
struct FakeHost {
    tools: Vec<ToolSelectInfo>,
    inactive: Mutex<HashSet<String>>,
    disclosure_only_active: Mutex<HashSet<String>>,
    supports_dynamic: bool,
    flag: bool,
    /// Names the registry can no longer resolve (simulates a disconnect).
    unresolvable: Mutex<HashSet<String>>,
}

impl FakeHost {
    fn new(tools: Vec<ToolSelectInfo>) -> Self {
        Self {
            tools,
            inactive: Mutex::new(HashSet::new()),
            disclosure_only_active: Mutex::new(HashSet::new()),
            supports_dynamic: true,
            flag: true,
            unresolvable: Mutex::new(HashSet::new()),
        }
    }

    fn deactivate(&self, name: &str) {
        self.inactive.lock().unwrap().insert(name.to_string());
    }

    fn unresolve(&self, name: &str) {
        self.unresolvable.lock().unwrap().insert(name.to_string());
    }
}

impl ToolSelectHost for &FakeHost {
    fn list_tools(&self) -> Vec<ToolSelectInfo> {
        self.tools.clone()
    }
    fn resolve_schema(&self, name: &str) -> Option<ToolDefinition> {
        if self.unresolvable.lock().unwrap().contains(name) {
            return None;
        }
        self.tools.iter().find(|t| t.name == name).map(|t| ToolDefinition {
            name: t.name.clone(),
            description: format!("{} description", t.name),
            input_schema: Some(serde_json::json!({ "type": "object" })),
        })
    }
    fn is_tool_active(&self, name: &str, _source: &str) -> bool {
        !self.inactive.lock().unwrap().contains(name)
    }
    fn is_tool_active_for_disclosure(&self, name: &str, source: &str) -> bool {
        self.is_tool_active(name, source)
            || self.disclosure_only_active.lock().unwrap().contains(name)
    }
    fn model_supports_dynamic_tools(&self) -> bool {
        self.supports_dynamic
    }
    fn flag_enabled(&self) -> bool {
        self.flag
    }
}

fn builtin(name: &str) -> ToolSelectInfo {
    ToolSelectInfo { name: name.to_string(), source: "builtin".to_string(), disclosure: None }
}

fn mcp(name: &str) -> ToolSelectInfo {
    ToolSelectInfo { name: name.to_string(), source: "mcp".to_string(), disclosure: None }
}

fn deferred(name: &str) -> ToolSelectInfo {
    ToolSelectInfo {
        name: name.to_string(),
        source: "builtin".to_string(),
        disclosure: Some(ToolDisclosure::Deferred),
    }
}

fn registry() -> Vec<ToolSelectInfo> {
    vec![
        builtin("read"),
        builtin(SELECT_TOOLS_TOOL_NAME),
        mcp("mcp__srv__alpha"),
        mcp("mcp__srv__beta"),
        deferred("heavy_tool"),
    ]
}

fn schema_message(names: &[&str]) -> ContextMessage {
    ContextMessage {
        role: "system".to_string(),
        tools: Some(
            names
                .iter()
                .map(|name| ToolDefinition {
                    name: name.to_string(),
                    description: String::new(),
                    input_schema: None,
                })
                .collect(),
        ),
        origin: Some(MessageOrigin::Injection {
            variant: DYNAMIC_TOOL_SCHEMA_VARIANT.to_string(),
        }),
        ..Default::default()
    }
}

fn announcement(text: &str) -> ContextMessage {
    ContextMessage {
        role: "user".to_string(),
        content: vec![ContentPart::Text { text: text.to_string() }],
        origin: Some(MessageOrigin::SystemTrigger { name: LOADABLE_TOOLS_TRIGGER.to_string() }),
        ..Default::default()
    }
}

fn user(text: &str) -> ContextMessage {
    ContextMessage {
        role: "user".to_string(),
        content: vec![ContentPart::Text { text: text.to_string() }],
        origin: Some(MessageOrigin::User),
        ..Default::default()
    }
}

fn names(shaped: &[ShapedToolEntry]) -> Vec<&str> {
    shaped.iter().map(|entry| entry.info.name.as_str()).collect()
}

// ── is_mcp_tool_name ───────────────────────────────────────────────────────

#[test]
fn qualified_mcp_names_are_recognised() {
    assert!(is_mcp_tool_name("mcp__server__tool"));
    assert!(is_mcp_tool_name("mcp__s__t"));
}

#[test]
fn unqualified_or_malformed_names_are_rejected() {
    assert!(!is_mcp_tool_name("read"));
    assert!(!is_mcp_tool_name("mcp__"));
    assert!(!is_mcp_tool_name("mcp__server"));
    assert!(!is_mcp_tool_name("mcp__server__"), "empty tool part");
    assert!(!is_mcp_tool_name("mcp____tool"), "empty server part");
}

// ── enabled ────────────────────────────────────────────────────────────────

#[test]
fn disclosure_requires_both_the_capability_and_the_flag() {
    let mut host = FakeHost::new(registry());
    assert!(ToolSelectService::new(&host).enabled());
    host.flag = false;
    assert!(!ToolSelectService::new(&host).enabled());
    host.flag = true;
    host.supports_dynamic = false;
    assert!(!ToolSelectService::new(&host).enabled());
}

// ── shape_tools ────────────────────────────────────────────────────────────

#[test]
fn with_disclosure_off_select_tools_is_hidden_and_the_rest_pass() {
    let mut host = FakeHost::new(registry());
    host.flag = false;
    let service = ToolSelectService::new(&host);
    let shaped = service.shape_tools(&registry(), &[]);
    assert_eq!(names(&shaped), vec!["read", "mcp__srv__alpha", "mcp__srv__beta", "heavy_tool"]);
    assert!(shaped.iter().all(|entry| !entry.deferred));
}

#[test]
fn with_disclosure_on_unloaded_dynamic_tools_are_dropped() {
    let host = FakeHost::new(registry());
    let service = ToolSelectService::new(&host);
    let shaped = service.shape_tools(&registry(), &[]);
    assert_eq!(names(&shaped), vec!["read", SELECT_TOOLS_TOOL_NAME]);
}

#[test]
fn loaded_dynamic_tools_return_marked_deferred() {
    let host = FakeHost::new(registry());
    let service = ToolSelectService::new(&host);
    let history = vec![schema_message(&["mcp__srv__alpha"])];
    let shaped = service.shape_tools(&registry(), &history);
    assert_eq!(names(&shaped), vec!["read", SELECT_TOOLS_TOOL_NAME, "mcp__srv__alpha"]);
    let alpha = shaped.iter().find(|e| e.info.name == "mcp__srv__alpha").unwrap();
    assert!(alpha.deferred);
    let read = shaped.iter().find(|e| e.info.name == "read").unwrap();
    assert!(!read.deferred);
}

#[test]
fn inactive_tools_are_filtered_in_both_modes() {
    let host = FakeHost::new(registry());
    host.deactivate("read");
    let service = ToolSelectService::new(&host);
    let shaped = service.shape_tools(&registry(), &[]);
    assert!(!names(&shaped).contains(&"read"));
}

#[test]
fn select_tools_may_enter_through_the_disclosure_gate() {
    // Inactive by policy but admitted by the wider disclosure gate.
    let host = FakeHost::new(registry());
    host.deactivate(SELECT_TOOLS_TOOL_NAME);
    host.disclosure_only_active.lock().unwrap().insert(SELECT_TOOLS_TOOL_NAME.to_string());
    let service = ToolSelectService::new(&host);
    assert!(names(&service.shape_tools(&registry(), &[])).contains(&SELECT_TOOLS_TOOL_NAME));

    // Without disclosure the gate does not apply.
    let mut host_off = FakeHost::new(registry());
    host_off.flag = false;
    host_off.deactivate(SELECT_TOOLS_TOOL_NAME);
    host_off
        .disclosure_only_active
        .lock()
        .unwrap()
        .insert(SELECT_TOOLS_TOOL_NAME.to_string());
    let service_off = ToolSelectService::new(&host_off);
    assert!(!names(&service_off.shape_tools(&registry(), &[])).contains(&SELECT_TOOLS_TOOL_NAME));
}

#[test]
fn pending_loads_count_as_loaded_for_shaping() {
    let host = FakeHost::new(registry());
    let mut service = ToolSelectService::new(&host);
    let (_result, _message) = service.load(&["mcp__srv__alpha".to_string()], &[]);
    // The schema message has not been appended anywhere, yet shaping sees it.
    let shaped = service.shape_tools(&registry(), &[]);
    assert!(names(&shaped).contains(&"mcp__srv__alpha"));
}

// ── shape_history ──────────────────────────────────────────────────────────

#[test]
fn with_disclosure_off_all_protocol_context_is_stripped() {
    let mut host = FakeHost::new(registry());
    host.flag = false;
    let service = ToolSelectService::new(&host);
    let history = vec![
        user("hi"),
        schema_message(&["mcp__srv__alpha"]),
        announcement("<tools_added>\nmcp__srv__alpha\n</tools_added>"),
    ];
    let shaped = service.shape_history(&history);
    assert_eq!(shaped.len(), 1);
    assert_eq!(shaped[0].role, "user");
}

#[test]
fn with_disclosure_on_active_schemas_survive() {
    let host = FakeHost::new(registry());
    let service = ToolSelectService::new(&host);
    let history = vec![user("hi"), schema_message(&["mcp__srv__alpha"])];
    let shaped = service.shape_history(&history);
    assert_eq!(shaped.len(), 2);
    assert_eq!(shaped[1].tools.as_ref().unwrap().len(), 1);
}

#[test]
fn deactivated_schemas_are_trimmed_from_history() {
    let host = FakeHost::new(registry());
    host.deactivate("mcp__srv__beta");
    let service = ToolSelectService::new(&host);
    let history = vec![schema_message(&["mcp__srv__alpha", "mcp__srv__beta"])];
    let shaped = service.shape_history(&history);
    assert_eq!(shaped.len(), 1);
    let tools = shaped[0].tools.as_ref().unwrap();
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].name, "mcp__srv__alpha");
}

#[test]
fn a_schema_message_left_empty_is_dropped() {
    let host = FakeHost::new(registry());
    host.deactivate("mcp__srv__alpha");
    let service = ToolSelectService::new(&host);
    let history = vec![user("hi"), schema_message(&["mcp__srv__alpha"])];
    let shaped = service.shape_history(&history);
    assert_eq!(shaped.len(), 1, "the empty schema message must vanish");
}

#[test]
fn a_tool_gone_from_the_registry_keeps_its_schema_via_the_mcp_fallback() {
    // The server disconnected: the registry no longer lists the tool, but the
    // policy still admits MCP names, so the schema survives in history.
    let mut tools = registry();
    tools.retain(|t| t.name != "mcp__srv__alpha");
    let host = FakeHost::new(tools);
    let service = ToolSelectService::new(&host);
    let history = vec![schema_message(&["mcp__srv__alpha"])];
    let shaped = service.shape_history(&history);
    assert_eq!(shaped.len(), 1);
    assert!(shaped[0].tools.is_some());
}

// ── load ───────────────────────────────────────────────────────────────────

#[test]
fn load_classifies_names_and_emits_one_schema_message() {
    let host = FakeHost::new(registry());
    let mut service = ToolSelectService::new(&host);
    let (result, message) = service.load(
        &[
            "mcp__srv__beta".to_string(),
            "mcp__srv__alpha".to_string(),
            "read".to_string(),
            "nope".to_string(),
        ],
        &[],
    );
    // to_load is sorted; read is not dynamically loadable → unknown.
    assert_eq!(result.to_load, vec!["mcp__srv__alpha", "mcp__srv__beta"]);
    assert_eq!(result.unknown, vec!["read", "nope"]);
    assert!(result.already_available.is_empty());

    let message = message.expect("a schema message is emitted");
    assert_eq!(message.role, "system");
    assert!(matches!(
        &message.origin,
        Some(MessageOrigin::Injection { variant }) if variant == DYNAMIC_TOOL_SCHEMA_VARIANT
    ));
    let tools = message.tools.as_ref().unwrap();
    assert_eq!(tools.len(), 2);
    assert!(tools.iter().all(|t| !t.description.is_empty()), "full schemas resolved");
}

#[test]
fn load_dedupes_repeated_names() {
    let host = FakeHost::new(registry());
    let mut service = ToolSelectService::new(&host);
    let (result, _) = service.load(
        &["mcp__srv__alpha".to_string(), "mcp__srv__alpha".to_string()],
        &[],
    );
    assert_eq!(result.to_load, vec!["mcp__srv__alpha"]);
}

#[test]
fn already_loaded_names_are_reported_not_reloaded() {
    let host = FakeHost::new(registry());
    let mut service = ToolSelectService::new(&host);
    let history = vec![schema_message(&["mcp__srv__alpha"])];
    let (result, message) = service.load(&["mcp__srv__alpha".to_string()], &history);
    assert_eq!(result.already_available, vec!["mcp__srv__alpha"]);
    assert!(result.to_load.is_empty());
    assert!(message.is_none(), "nothing to append");
}

#[test]
fn an_inactive_loadable_name_is_unknown() {
    let host = FakeHost::new(registry());
    host.deactivate("mcp__srv__alpha");
    let mut service = ToolSelectService::new(&host);
    let (result, _) = service.load(&["mcp__srv__alpha".to_string()], &[]);
    assert_eq!(result.unknown, vec!["mcp__srv__alpha"]);
}

#[test]
fn an_unresolvable_schema_still_loads_but_is_absent_from_the_message() {
    // TS keeps the name in toLoad and pendingLoaded even when resolve fails;
    // only the schema list loses it.
    let host = FakeHost::new(registry());
    host.unresolve("mcp__srv__alpha");
    let mut service = ToolSelectService::new(&host);
    let (result, message) = service.load(&["mcp__srv__alpha".to_string()], &[]);
    assert_eq!(result.to_load, vec!["mcp__srv__alpha"]);
    assert!(service.pending_loaded().contains("mcp__srv__alpha"));
    assert_eq!(message.unwrap().tools.as_ref().unwrap().len(), 0);
}

// ── announcements ──────────────────────────────────────────────────────────

#[test]
fn the_first_announcement_lists_every_loadable_tool() {
    let host = FakeHost::new(registry());
    let service = ToolSelectService::new(&host);
    let text = service.loadable_tools_announcement(&[]).expect("announcement");
    assert!(text.contains("<tools_added>\nheavy_tool\nmcp__srv__alpha\nmcp__srv__beta\n</tools_added>"));
    assert!(!text.contains("<tools_removed>"));
    assert!(text.contains("select_tools"));
}

#[test]
fn a_fully_announced_set_produces_no_announcement() {
    let host = FakeHost::new(registry());
    let service = ToolSelectService::new(&host);
    let history = vec![announcement(
        "<tools_added>\nheavy_tool\nmcp__srv__alpha\nmcp__srv__beta\n</tools_added>",
    )];
    assert_eq!(service.loadable_tools_announcement(&history), None);
}

#[test]
fn a_tool_that_disappeared_is_announced_removed() {
    let host = FakeHost::new(registry());
    host.deactivate("mcp__srv__beta");
    let service = ToolSelectService::new(&host);
    let history = vec![announcement(
        "<tools_added>\nheavy_tool\nmcp__srv__alpha\nmcp__srv__beta\n</tools_added>",
    )];
    let text = service.loadable_tools_announcement(&history).expect("announcement");
    assert!(text.contains("<tools_removed>\nmcp__srv__beta\n</tools_removed>"));
    assert!(!text.contains("<tools_added>"));
}

#[test]
fn announcements_fold_in_order_across_the_history() {
    let host = FakeHost::new(registry());
    let service = ToolSelectService::new(&host);
    let history = vec![
        announcement("<tools_added>\nheavy_tool\nmcp__srv__alpha\nmcp__srv__beta\n</tools_added>"),
        announcement("<tools_removed>\nmcp__srv__beta\n</tools_removed>"),
    ];
    // beta was announced-removed but is loadable again → re-announced as added.
    let text = service.loadable_tools_announcement(&history).expect("announcement");
    assert!(text.contains("<tools_added>\nmcp__srv__beta\n</tools_added>"));
}

#[test]
fn no_announcement_when_disclosure_is_off() {
    let mut host = FakeHost::new(registry());
    host.flag = false;
    let service = ToolSelectService::new(&host);
    assert_eq!(service.loadable_tools_announcement(&[]), None);
}

// ── fold_announced_tool_names ──────────────────────────────────────────────

#[test]
fn folding_applies_removals_before_additions_within_a_message() {
    // A single message that removes and re-adds the same name must end with it
    // present, because removals fold first.
    let history = vec![announcement(
        "<tools_removed>\nalpha\n</tools_removed>\n\n<tools_added>\nalpha\n</tools_added>",
    )];
    let folded = fold_announced_tool_names(&history);
    assert!(folded.contains("alpha"));
}

#[test]
fn folding_ignores_non_announcement_messages() {
    let history = vec![user("<tools_added>\nfake\n</tools_added>")];
    assert!(fold_announced_tool_names(&history).is_empty());
}

#[test]
fn folding_handles_multiple_blocks_and_blank_lines() {
    let history = vec![announcement(
        "<tools_added>\nalpha\n\n beta \n</tools_added>\ntext\n<tools_added>\ngamma\n</tools_added>",
    )];
    let folded = fold_announced_tool_names(&history);
    assert_eq!(folded.len(), 3);
    assert!(folded.contains("alpha") && folded.contains("beta") && folded.contains("gamma"));
}

#[test]
fn folding_an_unclosed_block_yields_nothing() {
    let history = vec![announcement("<tools_added>\nalpha")];
    assert!(fold_announced_tool_names(&history).is_empty());
}

// ── interception ───────────────────────────────────────────────────────────

#[test]
fn calling_an_unloaded_loadable_tool_is_intercepted_with_guidance() {
    let host = FakeHost::new(registry());
    let service = ToolSelectService::new(&host);
    let text = service.describe_unavailable_tool("mcp__srv__alpha", &[]).expect("intercepted");
    assert_eq!(
        text,
        "Tool \"mcp__srv__alpha\" is available but not loaded. \
         Call select_tools with [\"mcp__srv__alpha\"] first, then call the tool."
    );
}

#[test]
fn a_loaded_tool_is_not_intercepted() {
    let host = FakeHost::new(registry());
    let service = ToolSelectService::new(&host);
    let history = vec![schema_message(&["mcp__srv__alpha"])];
    assert_eq!(service.describe_unavailable_tool("mcp__srv__alpha", &history), None);
}

#[test]
fn a_loaded_then_deactivated_tool_reports_inactive() {
    let host = FakeHost::new(registry());
    host.deactivate("mcp__srv__alpha");
    let service = ToolSelectService::new(&host);
    let history = vec![schema_message(&["mcp__srv__alpha"])];
    let text = service.describe_unavailable_tool("mcp__srv__alpha", &history).expect("described");
    assert!(text.contains("no longer active"));
}

#[test]
fn non_loadable_tools_are_never_intercepted() {
    let host = FakeHost::new(registry());
    let service = ToolSelectService::new(&host);
    assert_eq!(service.describe_unavailable_tool("read", &[]), None);
}

#[test]
fn interception_is_off_without_disclosure() {
    let mut host = FakeHost::new(registry());
    host.flag = false;
    let service = ToolSelectService::new(&host);
    assert_eq!(service.describe_unavailable_tool("mcp__srv__alpha", &[]), None);
}

#[test]
fn a_loaded_mcp_tool_whose_server_vanished_reports_disconnected() {
    let mut tools = registry();
    tools.retain(|t| t.name != "mcp__srv__alpha");
    let host = FakeHost::new(tools);
    let service = ToolSelectService::new(&host);
    let history = vec![schema_message(&["mcp__srv__alpha"])];
    let text = service.describe_missing_tool("mcp__srv__alpha", &history).expect("described");
    assert!(text.contains("MCP server is currently disconnected"));
    assert!(text.contains("do not retry immediately"));
}

#[test]
fn a_loaded_non_mcp_tool_that_unregistered_reports_gone() {
    let mut tools = registry();
    tools.retain(|t| t.name != "heavy_tool");
    let host = FakeHost::new(tools);
    let service = ToolSelectService::new(&host);
    let history = vec![schema_message(&["heavy_tool"])];
    let text = service.describe_missing_tool("heavy_tool", &history).expect("described");
    assert!(text.contains("no longer registered"));
}

#[test]
fn missing_tool_description_requires_the_tool_to_have_been_loaded() {
    let mut tools = registry();
    tools.retain(|t| t.name != "mcp__srv__alpha");
    let host = FakeHost::new(tools);
    let service = ToolSelectService::new(&host);
    assert_eq!(service.describe_missing_tool("mcp__srv__alpha", &[]), None);
}

#[test]
fn a_still_registered_tool_is_not_missing() {
    let host = FakeHost::new(registry());
    let service = ToolSelectService::new(&host);
    let history = vec![schema_message(&["mcp__srv__alpha"])];
    assert_eq!(service.describe_missing_tool("mcp__srv__alpha", &history), None);
}

// ── ledger reconciliation ──────────────────────────────────────────────────

#[test]
fn compaction_clears_the_pending_overlay() {
    let host = FakeHost::new(registry());
    let mut service = ToolSelectService::new(&host);
    service.load(&["mcp__srv__alpha".to_string()], &[]);
    assert!(!service.pending_loaded().is_empty());
    service.on_compaction_completed();
    assert!(service.pending_loaded().is_empty());
}

#[test]
fn a_splice_drops_pending_names_whose_schema_did_not_survive() {
    let host = FakeHost::new(registry());
    let mut service = ToolSelectService::new(&host);
    service.load(&["mcp__srv__alpha".to_string(), "mcp__srv__beta".to_string()], &[]);
    // After an undo, only alpha's schema message survived.
    let surviving = vec![schema_message(&["mcp__srv__alpha"])];
    service.on_context_spliced(3, &surviving);
    assert!(service.pending_loaded().contains("mcp__srv__alpha"));
    assert!(!service.pending_loaded().contains("mcp__srv__beta"));
}

#[test]
fn an_insert_only_splice_leaves_the_overlay_alone() {
    let host = FakeHost::new(registry());
    let mut service = ToolSelectService::new(&host);
    service.load(&["mcp__srv__alpha".to_string()], &[]);
    service.on_context_spliced(0, &[]);
    assert!(service.pending_loaded().contains("mcp__srv__alpha"));
}

// ── end to end ─────────────────────────────────────────────────────────────

#[test]
fn the_full_disclosure_cycle_round_trips() {
    let host = FakeHost::new(registry());
    let mut service = ToolSelectService::new(&host);
    let mut history: Vec<ContextMessage> = vec![user("call alpha please")];

    // Initially alpha is hidden from the tool view.
    assert!(!names(&service.shape_tools(&registry(), &history)).contains(&"mcp__srv__alpha"));
    // The model tries anyway and is redirected.
    assert!(service.describe_unavailable_tool("mcp__srv__alpha", &history).is_some());
    // It selects the tool; the schema message lands in history.
    let (result, message) = service.load(&["mcp__srv__alpha".to_string()], &history);
    assert_eq!(result.to_load, vec!["mcp__srv__alpha"]);
    history.push(message.unwrap());
    // Now the tool is visible, deferred, and no longer intercepted.
    let shaped = service.shape_tools(&registry(), &history);
    let alpha = shaped.iter().find(|e| e.info.name == "mcp__srv__alpha").unwrap();
    assert!(alpha.deferred);
    assert_eq!(service.describe_unavailable_tool("mcp__srv__alpha", &history), None);
    // A second load reports it as already available.
    let (again, message) = service.load(&["mcp__srv__alpha".to_string()], &history);
    assert_eq!(again.already_available, vec!["mcp__srv__alpha"]);
    assert!(message.is_none());
}
