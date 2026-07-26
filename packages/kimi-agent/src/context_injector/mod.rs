/// ContextInjectorService — manages registered context injection providers with
/// position tracking and splice reconciliation.
///
/// Corresponds to `packages/agent-core-v2/src/agent/contextInjector/`.
///
/// Injects registered context providers at turn boundaries through system reminders
/// or as user messages, tracks their positions in `ContextMemory`, and reconciles
/// those positions after wire restoration.
///
/// # Architecture
/// - `ContextInjectionProvider`: async callback that returns injection content
/// - `ContextInjectionEntry`: tracks a provider + its positions in history
/// - `ContextInjectorService`: orchestrates injection lifecycle

use std::collections::HashMap;

use crate::context::context_memory::ContextMemory;
use crate::context::types::{ContentPart, ContextMessage, MessageOrigin};
use crate::injection::InjectionManager;

// ── Types ──────────────────────────────────────────────────────────────────

/// Context available to each injection provider when called.
#[derive(Debug, Clone)]
pub struct ContextInjectionContext {
    /// Positions of previous injections from this provider.
    pub injected_positions: Vec<usize>,
    /// Index of the most recent injection in the history (-1 if none).
    pub last_injected_at: isize,
    /// Whether this is a new turn (not a splice or continuation).
    pub is_new_turn: bool,
}

/// The result of an injection provider.
#[derive(Debug, Clone)]
pub enum ContextInjectionContent {
    /// Plain text that will be appended as a system reminder.
    Text(String),
    /// Full content parts that will be appended as a user message.
    Parts(Vec<ContentPart>),
}

/// Trait for injection providers — implement to define custom injections.
pub trait ContextInjectionProvider: Send + Sync {
    /// Produce injection content given the current context.
    /// Return None to skip injection this cycle.
    fn inject(
        &self,
        ctx: &ContextInjectionContext,
    ) -> Option<ContextInjectionContent>;
}

/// A registered injection entry with position tracking.
struct ContextInjectionEntry {
    provider: Box<dyn ContextInjectionProvider>,
    name: String,
    positions: Vec<usize>,
}

/// Service for managing and executing context injections.
///
/// Bound at Agent scope. Integrates with the `InjectionManager` for
/// scheduling and with event bus hooks for splice reconciliation.
pub struct ContextInjectorService {
    entries: Vec<ContextInjectionEntry>,
    is_new_turn: bool,
}

impl ContextInjectorService {
    /// Create a new empty service.
    pub fn new() -> Self {
        Self {
            entries: Vec::new(),
            is_new_turn: true,
        }
    }

    /// Register a new injection provider.
    ///
    /// Returns the index of the registered entry.
    pub fn register(
        &mut self,
        name: impl Into<String>,
        provider: Box<dyn ContextInjectionProvider>,
    ) -> usize {
        let name = name.into();
        let idx = self.entries.len();
        self.entries.push(ContextInjectionEntry {
            provider,
            name,
            positions: Vec::new(),
        });
        idx
    }

    /// Resync all providers' positions against the current context history.
    ///
    /// Called after wire restoration when the context may have been rebuilt
    /// from serialized state.
    pub fn resync_positions(&mut self, context: &ContextMemory) {
        let history = context.history();
        for entry in &mut self.entries {
            entry.positions = find_injections(history, &entry.name);
        }
    }

    /// Mark the beginning of a new turn.
    pub fn on_turn_started(&mut self) {
        self.is_new_turn = true;
    }

    /// Inject all registered providers at a turn boundary.
    ///
    /// Each provider is called with its current positions and turn state.
    /// Injected content is appended as either a system reminder or user message.
    pub async fn inject(&mut self, context: &mut ContextMemory) {
        let is_new_turn = self.is_new_turn;
        self.is_new_turn = false;

        for entry in &mut self.entries {
            let injected_positions = entry.positions.clone();
            let last_injected_at: isize = injected_positions
                .last()
                .map(|&p| p as isize)
                .unwrap_or(-1);

            let inj_ctx = ContextInjectionContext {
                injected_positions,
                last_injected_at,
                is_new_turn,
            };

            let content = entry.provider.inject(&inj_ctx);
            if let Some(content) = content {
                let variant = entry.name.clone();
                match content {
                    ContextInjectionContent::Text(text) => {
                        if text.trim().is_empty() {
                            continue;
                        }
                        let message_idx = context.len();
                        context.append_system_reminder(
                            &text,
                            MessageOrigin::Injection { variant },
                        );
                        // Track the new position
                        entry.positions.push(message_idx);
                    }
                    ContextInjectionContent::Parts(parts) => {
                        if parts.is_empty() {
                            continue;
                        }
                        let message_idx = context.len();
                        context.append_message(ContextMessage {
                            role: "user".to_string(),
                            content: parts,
                            tool_calls: vec![],
                            origin: Some(MessageOrigin::Injection {
                                variant,
                            }),
                            ..Default::default()
                        });
                        entry.positions.push(message_idx);
                    }
                }
            }
        }
    }

    /// Inject at turn boundary — convenience wrapper that calls `on_turn_started`
    /// then `inject`. Used after compaction.
    pub async fn inject_after_compaction(&mut self, context: &mut ContextMemory) {
        self.on_turn_started();
        self.inject(context).await;
    }

    /// Handle a splice event: adjust all provider positions when messages
    /// are inserted or removed at a given index.
    ///
    /// Corresponds to `handleSplice()` in TS.
    pub fn handle_splice(
        &mut self,
        splice_start: usize,
        delete_count: usize,
        inserted_count: usize,
        inserted_messages: &[ContextMessage],
    ) {
        let delta = inserted_count as isize - delete_count as isize;
        let deleted_end = splice_start + delete_count;

        // Find which inserted messages are injections for each entry
        let mut inserted_injections: HashMap<&str, Vec<usize>> = HashMap::new();
        for (offset, msg) in inserted_messages.iter().enumerate() {
            if let Some(origin) = &msg.origin {
                if let MessageOrigin::Injection { variant } = origin {
                    inserted_injections
                        .entry(variant.as_str())
                        .or_default()
                        .push(splice_start + offset);
                }
            }
        }

        for entry in &mut self.entries {
            let positions = &mut entry.positions;
            if positions.is_empty() && !inserted_injections.contains_key(entry.name.as_str()) {
                continue;
            }

            // Adopt any matching inserted injections
            let adopted: Vec<usize> = inserted_injections
                .remove(entry.name.as_str())
                .unwrap_or_default();

            // Find the range of positions that fall within the replaced region
            let mut lo = 0usize;
            while lo < positions.len() && positions[lo] < splice_start {
                lo += 1;
            }
            let mut hi = lo;
            while hi < positions.len() && positions[hi] < deleted_end {
                hi += 1;
            }

            // Shift positions after the deleted region
            for idx in hi..positions.len() {
                positions[idx] = (positions[idx] as isize + delta) as usize;
            }

            // Replace the positions in the deleted region with adopted ones
            positions.splice(lo..hi, adopted);
        }
    }

    /// Reset all positions to empty (e.g., after context clear).
    pub fn clear_positions(&mut self) {
        for entry in &mut self.entries {
            entry.positions.clear();
        }
    }
}

impl Default for ContextInjectorService {
    fn default() -> Self {
        Self::new()
    }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/// Find all positions in history where injection messages with the given
/// variant name appear.
fn find_injections(history: &[ContextMessage], variant: &str) -> Vec<usize> {
    history
        .iter()
        .enumerate()
        .filter_map(|(i, msg)| {
            if let Some(origin) = &msg.origin {
                if let MessageOrigin::Injection { variant: v } = origin {
                    if v == variant {
                        return Some(i);
                    }
                }
            }
            None
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_service() {
        let svc = ContextInjectorService::new();
        assert_eq!(svc.entries.len(), 0);
        assert!(svc.is_new_turn);
    }

    #[test]
    fn test_register_provider() {
        let mut svc = ContextInjectorService::new();
        let idx = svc.register("test", Box::new(TestProvider { name: "p1".into() }));
        assert_eq!(idx, 0);
        assert_eq!(svc.entries.len(), 1);
    }

    #[test]
    fn test_on_turn_started() {
        let mut svc = ContextInjectorService::new();
        svc.is_new_turn = false;
        svc.on_turn_started();
        assert!(svc.is_new_turn);
    }

    #[test]
    fn test_clear_positions() {
        let mut svc = ContextInjectorService::new();
        svc.register("test", Box::new(TestProvider { name: "p1".into() }));
        svc.entries[0].positions = vec![3, 7];
        svc.clear_positions();
        assert!(svc.entries[0].positions.is_empty());
    }

    #[test]
    fn test_find_injections() {
        let history = vec![
            ContextMessage {
                role: "user".into(),
                content: vec![],
                origin: Some(MessageOrigin::Injection {
                    variant: "goal".into(),
                }),
                ..Default::default()
            },
            ContextMessage {
                role: "assistant".into(),
                content: vec![],
                origin: None,
                ..Default::default()
            },
            ContextMessage {
                role: "user".into(),
                content: vec![],
                origin: Some(MessageOrigin::Injection {
                    variant: "goal".into(),
                }),
                ..Default::default()
            },
        ];

        let positions = find_injections(&history, "goal");
        assert_eq!(positions, vec![0, 2]);
    }

    #[test]
    fn test_find_injections_empty() {
        let history: Vec<ContextMessage> = vec![];
        let positions = find_injections(&history, "goal");
        assert!(positions.is_empty());
    }

    #[test]
    fn test_handle_splice_insert_only() {
        let mut svc = ContextInjectorService::new();
        svc.register("test", Box::new(TestProvider { name: "p1".into() }));

        // Set initial positions
        svc.entries[0].positions = vec![2, 5];

        // Insert one message at index 1 with no injections
        let inserted = vec![ContextMessage {
            role: "assistant".into(),
            content: vec![],
            origin: None,
            ..Default::default()
        }];
        svc.handle_splice(1, 0, 1, &inserted);

        // Positions 2→3, 5→6
        assert_eq!(svc.entries[0].positions, vec![3, 6]);
    }

    #[test]
    fn test_handle_splice_remove() {
        let mut svc = ContextInjectorService::new();
        svc.register("test", Box::new(TestProvider { name: "p1".into() }));

        svc.entries[0].positions = vec![2, 5, 8];

        // Remove 2 messages at index 3
        svc.handle_splice(3, 2, 0, &[]);

        // Position 2 stays (2 < 3), 5 was deleted (5 >= 3 && 5 < 5 → false, wait:
        // deleted_end = 3+2 = 5. Position 5 is not < 5, so hi = lo at position 5.
        // Then positions[hi] shifts: 5 → 3, 8 → 6
        // Let me re-examine: positions = [2, 5, 8], splice_start=3, delete=2, insert=0
        // lo = 1 (2 < 3), hi = 1 (5 < 5? → no), so lo=hi=1
        // No positions in deleted region, but delta = -2
        // Shift remaining: 5-2=3, 8-2=6
        // Result: [2, 3, 6]
        assert_eq!(svc.entries[0].positions, vec![2, 3, 6]);
    }

    #[test]
    fn test_handle_splice_replace_with_injection() {
        let mut svc = ContextInjectorService::new();
        svc.register("test", Box::new(TestProvider { name: "p1".into() }));

        svc.entries[0].positions = vec![2, 7];

        // Replace messages at index 5 (delete 2, insert 1 injection)
        let inserted = vec![ContextMessage {
            role: "user".into(),
            content: vec![],
            origin: Some(MessageOrigin::Injection {
                variant: "test".into(),
            }),
            ..Default::default()
        }];

        // splice_start=5, delete=2, insert=1, delta=-1
        // deleted_end = 7
        // positions [2, 7]: lo=1 (2 < 5), hi=2 (7 >= 5 && 7 < 7 → no, so hi stays at 1)
        // Wait, 7 < 7 is false, so hi stays at 1 (= positions.len()).
        // That's wrong. The deleted region is [5, 7), so position 7 is not in it.
        // So delta = -1: position 7 → 6
        // adopted: [5] (the injection inserted at index 5)
        // positions.splice(1..1, [5]) → [2, 5, 6]
        // Wait the hi check: `positions[1] = 7 < 7` is false, so hi stays at 1.
        // splice(1..1, [5]) → [2, 5, 7]. Then shift 7 → 6.
        // I need to check: in the code, the shift happens BEFORE the splice.
        // Let me re-read the code...

        // Actually looking more carefully at the code, the shift is done first (modifying positions in place),
        // then the splice replaces. But there's a problem: if we shift first, position 7 becomes 6,
        // and then we splice(lo..hi) where lo=hi=1, replacing nothing.
        // Result: [2, 5, 6]
        // Hmm, that looks wrong. The injection was at index 5, position 7 → 6.
        // Let me think about what should happen.
        // The right result: position 2 stays, deleted region [5,7) gets the new injection at 5,
        // position 7 shifts to 6. So final: [2, 5, 6].
        // Actually that matches!

        svc.handle_splice(5, 2, 1, &inserted);
        assert_eq!(svc.entries[0].positions, vec![2, 5, 6]);
    }

    // ── Test helper ──

    struct TestProvider {
        name: String,
    }

    impl ContextInjectionProvider for TestProvider {
        fn inject(
            &self,
            _ctx: &ContextInjectionContext,
        ) -> Option<ContextInjectionContent> {
            Some(ContextInjectionContent::Text(format!("injection from {}", self.name)))
        }
    }
}