/**
 * Static inspection of agent-file tool patterns.
 *
 * Three entry shapes are dead on arrival under the tool manager's matching
 * semantics, so they surface as warnings instead of silently shrinking the
 * active tool set: `wildcard-not-mcp` (non-MCP entries match builtin/user
 * tools by exact name only, so a wildcard outside an `mcp__…` pattern can
 * never match — a bare `*` in a denylist is a no-op), `incomplete-mcp-name`
 * (an `mcp__…` literal without glob magic must be a full
 * `mcp__<server>__<tool>` name; `mcp__github__*` is the working form for a
 * whole server), and `unknown-tool` (a literal naming no registered or
 * built-in tool, almost always a typo such as `read` instead of `Read`).
 *
 * Ported from the v2 engine (`findInactiveToolPatterns` in
 * `packages/agent-core-v2/src/agent/toolPolicy/evaluate.ts`) — keep the two
 * in sync: warning kinds and matching rules must land in both engines.
 */

import { isMcpToolName } from '../../mcp/tool-naming';

export type InactiveToolPatternKind = 'wildcard-not-mcp' | 'incomplete-mcp-name' | 'unknown-tool';

export interface InactiveToolPattern {
  readonly pattern: string;
  readonly kind: InactiveToolPatternKind;
}

const GLOB_MAGIC = /[*?[\]{}]/;

export function findInactiveToolPatterns(
  patterns: readonly string[],
  isKnownToolName?: (name: string) => boolean,
): InactiveToolPattern[] {
  const issues: InactiveToolPattern[] = [];
  for (const pattern of patterns) {
    if (isMcpToolName(pattern)) {
      if (!GLOB_MAGIC.test(pattern) && !pattern.slice('mcp__'.length).includes('__')) {
        issues.push({ pattern, kind: 'incomplete-mcp-name' });
      }
      continue;
    }
    if (GLOB_MAGIC.test(pattern)) {
      issues.push({ pattern, kind: 'wildcard-not-mcp' });
      continue;
    }
    if (isKnownToolName !== undefined && !isKnownToolName(pattern)) {
      issues.push({ pattern, kind: 'unknown-tool' });
    }
  }
  return issues;
}

export function describeInactiveToolPattern(issue: InactiveToolPattern): string {
  switch (issue.kind) {
    case 'wildcard-not-mcp':
      return `"${issue.pattern}" never matches: wildcards only work inside mcp__… patterns (a bare * disables nothing)`;
    case 'incomplete-mcp-name':
      return `"${issue.pattern}" never matches: an mcp__ literal must be a full mcp__<server>__<tool> name, or use a glob like mcp__github__* for a whole server`;
    case 'unknown-tool':
      return `"${issue.pattern}" matches no registered or built-in tool (a typo?)`;
  }
}
