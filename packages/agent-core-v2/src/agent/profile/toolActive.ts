/**
 * `profile` domain (L3) — shared active-tool policy evaluation.
 *
 * Applies a profile's allowlist and denylist with the same builtin/MCP matching
 * semantics for runtime execution and capability descriptions. Pure data
 * helper with no scoped state.
 */

import picomatch from 'picomatch';

import { isMcpToolName, type ToolSource } from '#/tool/toolContract';

export interface ToolActivationPolicy {
  readonly tools?: readonly string[];
  readonly disallowedTools?: readonly string[];
}

export function isToolActive(
  policy: ToolActivationPolicy,
  name: string,
  source: ToolSource = 'builtin',
): boolean {
  if (policy.tools !== undefined) {
    const allowed =
      source !== 'mcp'
        ? policy.tools.includes(name)
        : policy.tools
            .filter((pattern) => isMcpToolName(pattern))
            .some((pattern) => picomatch.isMatch(name, pattern));
    if (!allowed) return false;
  }
  if (policy.disallowedTools === undefined) return true;
  if (source !== 'mcp') return !policy.disallowedTools.includes(name);
  return !policy.disallowedTools
    .filter((pattern) => isMcpToolName(pattern))
    .some((pattern) => picomatch.isMatch(name, pattern));
}

export function resolveActiveToolNames(
  policy: ToolActivationPolicy,
): readonly string[] | undefined {
  if (policy.tools === undefined) return undefined;
  return policy.tools.filter((name) =>
    isToolActive(policy, name, isMcpToolName(name) ? 'mcp' : 'builtin'),
  );
}
