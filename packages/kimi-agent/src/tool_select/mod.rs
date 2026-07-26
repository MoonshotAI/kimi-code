/// `toolSelect` — progressive tool disclosure.
///
/// Faithful port of `packages/agent-core-v2/src/agent/toolSelect/`
/// (`toolSelectService.ts` + `dynamicTools.ts`; the pure history helpers this
/// builds on live in [`crate::context::dynamic_tools`]).
///
/// With disclosure on, MCP tool schemas stay out of the immutable top-level
/// `tools[]`; the model loads them on demand through the `select_tools` tool.
/// The loaded-tool ledger **is the history itself** — schema messages carry
/// the loaded definitions, so undo/compaction/resume all self-heal by
/// re-folding. The only extra state is `pending_loaded`: names whose schema
/// message has been issued this step but may not be observable in the caller's
/// history snapshot yet.
///
/// **Host boundary.** The registry, tool policy, model capabilities, and the
/// flag gate are host queries behind [`ToolSelectHost`]; this module owns the
/// shaping/loading state machine and every model-facing string.
use std::collections::HashSet;

use crate::context::dynamic_tools::{
    collect_loaded_dynamic_tool_names, render_loadable_tools_announcement,
    strip_dynamic_tool_context, DYNAMIC_TOOL_SCHEMA_VARIANT, LOADABLE_TOOLS_TRIGGER,
};
use crate::context::types::{ContextMessage, ContentPart, MessageOrigin, ToolDefinition};

pub const SELECT_TOOLS_TOOL_NAME: &str = "select_tools";

const MCP_NAME_PREFIX: &str = "mcp__";

/// Whether `name` is a fully-qualified MCP tool name (`mcp__<server>__<tool>`).
pub fn is_mcp_tool_name(name: &str) -> bool {
    let Some(tail) = name.strip_prefix(MCP_NAME_PREFIX) else {
        return false;
    };
    // A qualified name carries non-empty server and tool parts.
    match tail.find("__") {
        Some(separator) if separator > 0 => separator + 2 < tail.len(),
        _ => false,
    }
}

/// How a tool participates in disclosure (TS `ToolDisclosure`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolDisclosure {
    Immediate,
    Deferred,
}

/// Registry entry projection (TS `ToolInfo`).
#[derive(Debug, Clone)]
pub struct ToolSelectInfo {
    pub name: String,
    /// `"builtin"` / `"mcp"` / `"user"` — kept stringly to match the wire.
    pub source: String,
    pub disclosure: Option<ToolDisclosure>,
}

impl ToolSelectInfo {
    /// TS `isDynamicallyLoadable`: MCP tools and explicitly deferred tools.
    pub fn is_dynamically_loadable(&self) -> bool {
        self.source == "mcp" || self.disclosure == Some(ToolDisclosure::Deferred)
    }
}

/// A provider-visible tool entry after shaping.
#[derive(Debug, Clone)]
pub struct ShapedToolEntry {
    pub info: ToolSelectInfo,
    /// Marked on dynamically-loadable entries that made it into the view —
    /// the provider adapter renders these outside the immutable prefix.
    pub deferred: bool,
}

/// Outcome of a `select_tools` call.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LoadToolsResult {
    pub to_load: Vec<String>,
    pub already_available: Vec<String>,
    pub unknown: Vec<String>,
}

/// Host-side queries the service needs. All read-only.
pub trait ToolSelectHost: Send + Sync {
    fn list_tools(&self) -> Vec<ToolSelectInfo>;
    /// Full schema for a registered tool, if still resolvable.
    fn resolve_schema(&self, name: &str) -> Option<ToolDefinition>;
    fn is_tool_active(&self, name: &str, source: &str) -> bool;
    /// The wider gate that admits `select_tools` itself under disclosure.
    fn is_tool_active_for_disclosure(&self, name: &str, source: &str) -> bool {
        self.is_tool_active(name, source)
    }
    /// `capabilities.dynamically_loaded_tools === true && capabilities.tool_use`.
    fn model_supports_dynamic_tools(&self) -> bool;
    /// The `tool-select` experimental flag.
    fn flag_enabled(&self) -> bool;
}

pub struct ToolSelectService<H: ToolSelectHost> {
    host: H,
    /// Names issued in a schema message that may not yet be visible in the
    /// history snapshot the caller holds.
    pending_loaded: HashSet<String>,
}

impl<H: ToolSelectHost> ToolSelectService<H> {
    pub fn new(host: H) -> Self {
        Self { host, pending_loaded: HashSet::new() }
    }

    pub fn host(&self) -> &H {
        &self.host
    }

    /// Whether progressive disclosure is in force for this model.
    pub fn enabled(&self) -> bool {
        self.host.model_supports_dynamic_tools() && self.host.flag_enabled()
    }

    /// Shape the provider-visible tool list.
    ///
    /// Always filters to active tools (and hides `select_tools` when
    /// disclosure is off). With disclosure on, dynamically-loadable entries are
    /// dropped unless loaded, and loaded ones are marked `deferred`.
    pub fn shape_tools(
        &self,
        entries: &[ToolSelectInfo],
        history: &[ContextMessage],
    ) -> Vec<ShapedToolEntry> {
        let disclosure = self.enabled();
        let active = self.active_entries(entries, disclosure);
        if !disclosure {
            return active
                .into_iter()
                .map(|info| ShapedToolEntry { info, deferred: false })
                .collect();
        }
        let loaded = self.loaded_tool_names(history);
        let mut shaped = Vec::new();
        for info in active {
            if info.name == SELECT_TOOLS_TOOL_NAME || !info.is_dynamically_loadable() {
                shaped.push(ShapedToolEntry { info, deferred: false });
                continue;
            }
            if !loaded.contains(&info.name) {
                continue;
            }
            shaped.push(ShapedToolEntry { info, deferred: true });
        }
        shaped
    }

    /// Shape the provider-visible history.
    ///
    /// Disclosure on: keep schema messages but trim their `tools` to the still
    /// active loaded set, dropping messages left empty. Disclosure off: strip
    /// all protocol context.
    pub fn shape_history(&self, messages: &[ContextMessage]) -> Vec<ContextMessage> {
        if !self.enabled() {
            return strip_dynamic_tool_context(messages);
        }
        let mut shaped = Vec::with_capacity(messages.len());
        for message in messages {
            if let Some(next) = self.shape_active_message(message) {
                shaped.push(next);
            }
        }
        shaped
    }

    fn shape_active_message(&self, message: &ContextMessage) -> Option<ContextMessage> {
        let Some(tools) = message.tools.as_ref().filter(|t| !t.is_empty()) else {
            return Some(message.clone());
        };
        let kept: Vec<ToolDefinition> = tools
            .iter()
            .filter(|tool| self.is_loaded_tool_active(&tool.name))
            .cloned()
            .collect();
        if kept.len() == tools.len() {
            return Some(message.clone());
        }
        if !kept.is_empty() {
            let mut next = message.clone();
            next.tools = Some(kept);
            return Some(next);
        }
        let mut next = message.clone();
        next.tools = None;
        if next.content.is_empty() && next.tool_calls.is_empty() {
            return None;
        }
        Some(next)
    }

    /// Handle a `select_tools` call.
    ///
    /// Returns the classification plus the schema message to append to the
    /// history, if any names actually load. TS appends through the context
    /// service directly; the caller owns the history here, so the message is
    /// handed back instead — appending it is what commits the load.
    pub fn load(
        &mut self,
        names: &[String],
        history: &[ContextMessage],
    ) -> (LoadToolsResult, Option<ContextMessage>) {
        let loadable: HashSet<String> = self.loadable_tool_names().into_iter().collect();
        let loaded = self.active_loaded_tool_names(history);

        let mut result = LoadToolsResult::default();
        let mut seen = HashSet::new();
        for name in names {
            if !seen.insert(name.clone()) {
                continue;
            }
            if loaded.contains(name) {
                result.already_available.push(name.clone());
            } else if loadable.contains(name) {
                result.to_load.push(name.clone());
            } else {
                result.unknown.push(name.clone());
            }
        }

        if result.to_load.is_empty() {
            return (result, None);
        }
        result.to_load.sort();
        let tools: Vec<ToolDefinition> = result
            .to_load
            .iter()
            .filter_map(|name| self.host.resolve_schema(name))
            .collect();
        for name in &result.to_load {
            self.pending_loaded.insert(name.clone());
        }
        let message = ContextMessage {
            role: "system".to_string(),
            content: vec![],
            tool_calls: vec![],
            tools: Some(tools),
            origin: Some(MessageOrigin::Injection {
                variant: DYNAMIC_TOOL_SCHEMA_VARIANT.to_string(),
            }),
            ..Default::default()
        };
        (result, Some(message))
    }

    /// The `<tools_added>/<tools_removed>` delta announcement, if the loadable
    /// set drifted from what the history already announced.
    pub fn loadable_tools_announcement(&self, history: &[ContextMessage]) -> Option<String> {
        if !self.enabled() {
            return None;
        }
        let loadable = self.loadable_tool_names();
        let loadable_set: HashSet<&String> = loadable.iter().collect();
        let announced = fold_announced_tool_names(history);
        let added: Vec<String> =
            loadable.iter().filter(|name| !announced.contains(*name)).cloned().collect();
        let mut removed: Vec<String> = announced
            .iter()
            .filter(|name| !loadable_set.contains(name))
            .cloned()
            .collect();
        removed.sort();
        if added.is_empty() && removed.is_empty() {
            return None;
        }
        Some(render_loadable_tools_announcement(&added, &removed))
    }

    /// Interception text for a call to a tool the executor knows but will not
    /// run (TS `describeUnavailableTool`).
    pub fn describe_unavailable_tool(
        &self,
        name: &str,
        history: &[ContextMessage],
    ) -> Option<String> {
        if self.is_inactive_loaded_tool(name, history) {
            return Some(inactive_loaded_tool_output(name));
        }
        if !self.should_intercept(name, history) {
            return None;
        }
        Some(not_loaded_tool_output(name))
    }

    /// Interception text for a call to a tool no longer in the registry (TS
    /// `describeMissingTool`).
    pub fn describe_missing_tool(&self, name: &str, history: &[ContextMessage]) -> Option<String> {
        if !self.enabled() {
            return None;
        }
        if self.host.resolve_schema(name).is_some() {
            return None;
        }
        if !self.loaded_tool_names(history).contains(name) {
            return None;
        }
        if is_mcp_tool_name(name) {
            return Some(format!(
                "Tool \"{name}\" was loaded but its MCP server is currently disconnected. \
                 It may become available again when the server reconnects; do not retry immediately."
            ));
        }
        Some(format!(
            "Tool \"{name}\" was loaded but is no longer registered. \
             Do not retry it unless it becomes available again."
        ))
    }

    /// A compaction rewrote the whole history; schema messages that survived
    /// are visible again, so the pending overlay is stale in its entirety.
    pub fn on_compaction_completed(&mut self) {
        self.pending_loaded.clear();
    }

    /// A splice deleted messages. Drop pending names whose schema message no
    /// longer survives, so the model can re-select them.
    pub fn on_context_spliced(&mut self, delete_count: usize, history: &[ContextMessage]) {
        if delete_count == 0 || self.pending_loaded.is_empty() {
            return;
        }
        let landed: HashSet<String> =
            collect_loaded_dynamic_tool_names(history).into_iter().collect();
        self.pending_loaded.retain(|name| landed.contains(name));
    }

    pub fn pending_loaded(&self) -> &HashSet<String> {
        &self.pending_loaded
    }

    // ── Internal ──────────────────────────────────────────────────────────

    fn should_intercept(&self, name: &str, history: &[ContextMessage]) -> bool {
        if !self.enabled() {
            return false;
        }
        let tools = self.host.list_tools();
        let Some(info) = tools.iter().find(|info| info.name == name) else {
            return false;
        };
        if !info.is_dynamically_loadable() {
            return false;
        }
        if !self.loadable_tool_names().contains(&name.to_string()) {
            return false;
        }
        !self.active_loaded_tool_names(history).contains(name)
    }

    /// Loadable = dynamically loadable and active, sorted.
    fn loadable_tool_names(&self) -> Vec<String> {
        let mut names: Vec<String> = self
            .host
            .list_tools()
            .into_iter()
            .filter(|info| {
                info.is_dynamically_loadable()
                    && self.host.is_tool_active(&info.name, &info.source)
            })
            .map(|info| info.name)
            .collect();
        names.sort();
        names
    }

    /// Loaded = folded from history schema messages, plus the pending overlay.
    fn loaded_tool_names(&self, history: &[ContextMessage]) -> HashSet<String> {
        let mut names: HashSet<String> =
            collect_loaded_dynamic_tool_names(history).into_iter().collect();
        names.extend(self.pending_loaded.iter().cloned());
        names
    }

    fn active_loaded_tool_names(&self, history: &[ContextMessage]) -> HashSet<String> {
        self.loaded_tool_names(history)
            .into_iter()
            .filter(|name| self.is_loaded_tool_active(name))
            .collect()
    }

    fn is_inactive_loaded_tool(&self, name: &str, history: &[ContextMessage]) -> bool {
        if !self.enabled() {
            return false;
        }
        self.loaded_tool_names(history).contains(name) && !self.is_loaded_tool_active(name)
    }

    /// Whether a loaded tool is still loadable and policy-active. A tool gone
    /// from the registry falls back to an MCP policy check by name shape, so a
    /// temporarily disconnected server does not flip its tools to "inactive"
    /// (that is `describe_missing_tool`'s case, with different guidance).
    fn is_loaded_tool_active(&self, name: &str) -> bool {
        let tools = self.host.list_tools();
        if let Some(info) = tools.iter().find(|info| info.name == name) {
            return info.is_dynamically_loadable()
                && self.host.is_tool_active(&info.name, &info.source);
        }
        if is_mcp_tool_name(name) {
            return self.host.is_tool_active(name, "mcp");
        }
        false
    }

    /// Filter to policy-active entries. `select_tools` is special-cased twice:
    /// under disclosure it may enter through the wider disclosure gate; without
    /// disclosure it is hidden even when active.
    fn active_entries(
        &self,
        entries: &[ToolSelectInfo],
        disclosure: bool,
    ) -> Vec<ToolSelectInfo> {
        entries
            .iter()
            .filter(|entry| {
                let active = self.host.is_tool_active(&entry.name, &entry.source)
                    || (disclosure
                        && entry.name == SELECT_TOOLS_TOOL_NAME
                        && self.host.is_tool_active_for_disclosure(&entry.name, &entry.source));
                active && (disclosure || entry.name != SELECT_TOOLS_TOOL_NAME)
            })
            .cloned()
            .collect()
    }
}

/// Fold `<tools_added>` / `<tools_removed>` blocks across the history's
/// announcements into the currently-announced set.
///
/// Per message, removals are applied before additions, matching TS.
pub fn fold_announced_tool_names(history: &[ContextMessage]) -> HashSet<String> {
    let mut announced = HashSet::new();
    for message in history {
        if !crate::context::dynamic_tools::is_loadable_tools_announcement(message) {
            continue;
        }
        let text: String = message
            .content
            .iter()
            .filter_map(|part| match part {
                ContentPart::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        for name in match_tool_name_blocks(&text, "tools_removed") {
            announced.remove(&name);
        }
        for name in match_tool_name_blocks(&text, "tools_added") {
            announced.insert(name);
        }
    }
    announced
}

/// Extract trimmed, non-empty names from every `<tag>...</tag>` block.
///
/// TS uses the non-greedy `<tag>\n?([\s\S]*?)\n?<\/tag>`; a manual scan gives
/// the same non-greedy semantics without a per-call regex compile.
fn match_tool_name_blocks(text: &str, tag: &str) -> Vec<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut names = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find(&open) {
        let after_open = &rest[start + open.len()..];
        let Some(end) = after_open.find(&close) else {
            break;
        };
        for line in after_open[..end].lines() {
            let name = line.trim();
            if !name.is_empty() {
                names.push(name.to_string());
            }
        }
        rest = &after_open[end + close.len()..];
    }
    names
}

fn not_loaded_tool_output(name: &str) -> String {
    format!(
        "Tool \"{name}\" is available but not loaded. \
         Call select_tools with [\"{name}\"] first, then call the tool."
    )
}

fn inactive_loaded_tool_output(name: &str) -> String {
    format!(
        "Tool \"{name}\" was loaded but is no longer active. \
         Ask the user to enable it before calling it again."
    )
}

#[cfg(test)]
mod tests;
