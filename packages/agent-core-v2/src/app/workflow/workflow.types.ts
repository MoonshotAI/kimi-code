/**
 * `workflow` domain (L6) — shared constants with no single owning interface.
 *
 * `WORKFLOW_TOOL_NAME` is the model-facing name of the `Workflow` agent tool;
 * both the tool (registered under the `tools` domain) and the Agent-scope
 * review listener key on it, so it lives here in the owning domain to keep
 * the dependency direction `tools` (L7) → `workflow` (L6).
 */

export const WORKFLOW_TOOL_NAME = 'Workflow';
