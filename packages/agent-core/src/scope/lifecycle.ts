/**
 * Lifecycle scopes for the di-v3 scope mechanism.
 *
 * Normative source:
 * `.agents/skills/service-skill/explanation/scope-mechanism.md` (LifecycleScope
 * enum). Scopes nest `Core → Session → Agent → Turn → ToolCall`; DI resolution
 * walks from the child up the parent chain until it reaches Core.
 *
 * String-valued (not numeric) so a scope is self-describing in logs, warnings,
 * and serialized handles.
 */
export enum LifecycleScope {
  Core = 'core',
  Session = 'session',
  Agent = 'agent',
  Turn = 'turn',
  ToolCall = 'toolCall',
}
