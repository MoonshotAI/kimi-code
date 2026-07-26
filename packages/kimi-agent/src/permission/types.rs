/// Core type definitions for the permission system.
///
/// Mirrors the TS types in `packages/agent-core/src/agent/permission/types.ts`.

use serde::{Deserialize, Serialize};

/// Permission rule decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PermissionRuleDecision {
    #[serde(rename = "allow")]
    Allow,
    #[serde(rename = "deny")]
    Deny,
    #[serde(rename = "ask")]
    Ask,
}

/// Rule provenance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PermissionRuleScope {
    #[serde(rename = "turn-override")]
    TurnOverride,
    #[serde(rename = "session-runtime")]
    SessionRuntime,
    #[serde(rename = "project")]
    Project,
    #[serde(rename = "user")]
    User,
}

/// Top-level permission mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PermissionMode {
    #[serde(rename = "manual")]
    Manual,
    #[serde(rename = "yolo")]
    Yolo,
    #[serde(rename = "auto")]
    Auto,
}

/// A single permission rule.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionRule {
    pub decision: PermissionRuleDecision,
    pub scope: PermissionRuleScope,
    pub pattern: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Permission data snapshot.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionData {
    pub mode: PermissionMode,
    pub rules: Vec<PermissionRule>,
}

/// Result of a policy evaluation.
pub enum PermissionPolicyResult {
    /// Tool execution is approved.
    Approve,
    /// Tool execution is denied.
    Deny {
        reason: String,
    },
    /// User must be asked for approval.
    Ask {
        /// Optional callback to resolve the ask.
        resolve: Option<Box<dyn FnOnce(ApprovalResponse) -> PermissionPolicyResult + Send>>,
    },
}

impl std::fmt::Debug for PermissionPolicyResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PermissionPolicyResult::Approve => write!(f, "Approve"),
            PermissionPolicyResult::Deny { reason } => f.debug_struct("Deny")
                .field("reason", reason)
                .finish(),
            PermissionPolicyResult::Ask { .. } => f.debug_struct("Ask")
                .field("resolve", &"<fn>")
                .finish(),
        }
    }
}

/// Approval response from the user.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalResponse {
    pub decision: ApprovalDecision,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<ApprovalScope>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feedback: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ApprovalDecision {
    #[serde(rename = "approved")]
    Approved,
    #[serde(rename = "rejected")]
    Rejected,
    #[serde(rename = "cancelled")]
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ApprovalScope {
    #[serde(rename = "session")]
    Session,
}

/// Context passed to permission policies.
#[derive(Debug, Clone)]
pub struct PermissionPolicyContext {
    pub tool_name: String,
    pub tool_call_id: String,
    pub args: serde_json::Value,
    pub mode: PermissionMode,
    pub r#type: Option<String>,
}

/// The PermissionPolicy trait — each policy implements this.
pub trait PermissionPolicy: Send + Sync {
    /// Human-readable policy name (e.g. "yolo-mode-approve").
    fn name(&self) -> &str;

    /// Evaluate the policy. Return `Some(result)` if this policy matches,
    /// or `None` to let the next policy decide.
    fn evaluate(&self, context: &PermissionPolicyContext) -> Option<PermissionPolicyResult>;
}

/// A parsed DSL pattern.
#[derive(Debug, Clone)]
pub struct ParsedPattern {
    pub tool_name: String,
    pub arg_pattern: Option<String>,
}

/// A rule match result.
#[derive(Debug, Clone)]
pub struct RuleMatch {
    pub rule: PermissionRule,
    pub strategy: RuleMatchStrategy,
    pub has_rule_args: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuleMatchStrategy {
    ToolNameOnly,
    MatchesRule,
}

/// A generic pattern for glob matching (wildcard tool names).
#[derive(Debug, Clone)]
pub struct GlobPattern {
    segments: Vec<GlobSegment>,
}

#[derive(Debug, Clone)]
enum GlobSegment {
    Exact(String),
    Wildcard,
}

impl GlobPattern {
    /// Parse a glob pattern where `*` matches any sequence of characters.
    pub fn new(pattern: &str) -> Self {
        let segments: Vec<GlobSegment> = pattern
            .split('*')
            .map(|s| {
                if s.is_empty() {
                    GlobSegment::Wildcard
                } else {
                    GlobSegment::Exact(s.to_string())
                }
            })
            .collect();
        // If the pattern ends with *, the last split produces an empty string
        if pattern.ends_with('*') {
            let mut segs = segments;
            segs.push(GlobSegment::Wildcard);
            GlobPattern { segments: segs }
        } else {
            GlobPattern { segments }
        }
    }

    /// Check if the given name matches this glob pattern.
    pub fn matches(&self, name: &str) -> bool {
        if self.segments.is_empty() {
            return name.is_empty();
        }
        // If the pattern doesn't start with *, the name must start with the first segment
        let mut pos = 0;
        let _name_bytes = name.as_bytes();

        for (i, segment) in self.segments.iter().enumerate() {
            match segment {
                GlobSegment::Exact(s) => {
                    if i == 0 && !self.is_wildcard_first() {
                        // Must match at start
                        if !name.starts_with(s) {
                            return false;
                        }
                        pos = s.len();
                    } else {
                        // Find the segment somewhere after pos
                        match name[pos..].find(s) {
                            Some(idx) => pos += idx + s.len(),
                            None => return false,
                        }
                    }
                }
                GlobSegment::Wildcard => {
                    // Wildcard matches anything, skip to next segment
                }
            }
        }

        // If the last segment is not a wildcard, the name must end exactly
        if !self.is_wildcard_last() {
            if let Some(GlobSegment::Exact(s)) = self.segments.last() {
                if !name.ends_with(s) {
                    return false;
                }
            }
        }

        true
    }

    fn is_wildcard_first(&self) -> bool {
        matches!(self.segments.first(), Some(GlobSegment::Wildcard))
    }

    fn is_wildcard_last(&self) -> bool {
        matches!(self.segments.last(), Some(GlobSegment::Wildcard))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_glob_pattern_exact() {
        let p = GlobPattern::new("Read");
        assert!(p.matches("Read"));
        assert!(!p.matches("Write"));
        assert!(!p.matches("ReadWrite"));
    }

    #[test]
    fn test_glob_pattern_wildcard_prefix() {
        let p = GlobPattern::new("*Read");
        assert!(p.matches("Read"));
        assert!(p.matches("MyRead"));
        assert!(!p.matches("ReadWrite"));
    }

    #[test]
    fn test_glob_pattern_wildcard_suffix() {
        let p = GlobPattern::new("mcp__*");
        assert!(p.matches("mcp__github__list"));
        assert!(p.matches("mcp__"));
        assert!(!p.matches("mcp"));
    }

    #[test]
    fn test_glob_pattern_wildcard_both() {
        let p = GlobPattern::new("*github*");
        assert!(p.matches("mcp__github__list"));
        assert!(p.matches("github"));
        assert!(!p.matches("gitlab"));
    }

    #[test]
    fn test_permission_mode() {
        assert_eq!(PermissionMode::Manual as u8, 0);
        assert_eq!(PermissionMode::Yolo as u8, 1);
        assert_eq!(PermissionMode::Auto as u8, 2);
    }

    #[test]
    fn test_permission_rule_serialize() {
        let rule = PermissionRule {
            decision: PermissionRuleDecision::Allow,
            scope: PermissionRuleScope::User,
            pattern: "Read(/etc/**)".into(),
            reason: Some("test".into()),
        };
        let json = serde_json::to_value(&rule).unwrap();
        assert_eq!(json["decision"], "allow");
        assert_eq!(json["scope"], "user");
        assert_eq!(json["pattern"], "Read(/etc/**)");
        assert_eq!(json["reason"], "test");
    }
}