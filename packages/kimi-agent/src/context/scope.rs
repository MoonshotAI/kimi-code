/// ScopeContext — manages a stack of named scopes.
///
/// Corresponds to `packages/agent-core-v2/src/agent/scopeContext/`.

use std::collections::VecDeque;

const MAX_SCOPE_DEPTH: usize = 64;

/// Tracks a stack of active scopes.
pub struct ScopeContext {
    scopes: VecDeque<String>,
}

impl ScopeContext {
    pub fn new() -> Self {
        Self { scopes: VecDeque::new() }
    }

    /// Enter a named scope. Returns false if depth limit reached.
    pub fn enter(&mut self, scope: String) -> bool {
        if self.scopes.len() >= MAX_SCOPE_DEPTH {
            return false;
        }
        self.scopes.push_back(scope);
        true
    }

    /// Exit the current scope. Returns the exited scope name, or None.
    pub fn exit(&mut self) -> Option<String> {
        self.scopes.pop_back()
    }

    /// Peek at the current (innermost) scope.
    pub fn current(&self) -> Option<&str> {
        self.scopes.back().map(|s| s.as_str())
    }

    /// Check if any scope is active.
    pub fn is_active(&self) -> bool {
        !self.scopes.is_empty()
    }

    /// Current depth.
    pub fn depth(&self) -> usize {
        self.scopes.len()
    }

    /// Clear all scopes.
    pub fn clear(&mut self) {
        self.scopes.clear();
    }
}

impl Default for ScopeContext {
    fn default() -> Self { Self::new() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_no_scope() { let sc = ScopeContext::new(); assert!(!sc.is_active()); assert!(sc.current().is_none()); }
    #[test]
    fn test_enter_exit() {
        let mut sc = ScopeContext::new();
        assert!(sc.enter("turn".into()));
        assert!(sc.is_active());
        assert_eq!(sc.current(), Some("turn"));
        assert_eq!(sc.exit(), Some("turn".into()));
        assert!(!sc.is_active());
    }
    #[test]
    fn test_nested_scopes() {
        let mut sc = ScopeContext::new();
        sc.enter("outer".into()); sc.enter("inner".into());
        assert_eq!(sc.current(), Some("inner"));
        assert_eq!(sc.depth(), 2);
        assert_eq!(sc.exit(), Some("inner".into()));
        assert_eq!(sc.current(), Some("outer"));
    }
    #[test]
    fn test_clear() {
        let mut sc = ScopeContext::new();
        sc.enter("a".into()); sc.enter("b".into());
        sc.clear();
        assert!(!sc.is_active());
    }
}
