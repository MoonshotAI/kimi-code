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

export interface GlobalToolsPolicy {
  readonly enabled?: readonly string[];
  readonly disabled?: readonly string[];
}

export interface ToolPolicyLayers {
  readonly workspaceDisabledTools?: readonly string[];
  readonly profile: ToolActivationPolicy;
  readonly global?: GlobalToolsPolicy;
  readonly sessionDisabledTools?: readonly string[];
}

export function isToolActiveComposed(
  layers: ToolPolicyLayers,
  name: string,
  source: ToolSource = 'builtin',
): boolean {
  return (
    isToolActive({ disallowedTools: layers.workspaceDisabledTools }, name, source) &&
    isToolActive(layers.profile, name, source) &&
    isToolActive(
      {
        tools: layers.global?.enabled?.length ? layers.global.enabled : undefined,
        disallowedTools: layers.global?.disabled,
      },
      name,
      source,
    ) &&
    isToolActive({ disallowedTools: layers.sessionDisabledTools }, name, source)
  );
}

export function resolveActiveToolNames(
  policy: ToolActivationPolicy,
): readonly string[] | undefined {
  if (policy.tools === undefined) return undefined;
  return policy.tools.filter((name) =>
    isToolActive(policy, name, isMcpToolName(name) ? 'mcp' : 'builtin'),
  );
}

export type InactiveToolPatternKind = 'wildcard-not-mcp' | 'incomplete-mcp-name' | 'unknown-tool';

export interface InactiveToolPattern {
  readonly pattern: string;
  readonly kind: InactiveToolPatternKind;
}

const GLOB_MAGIC = /[*?[\]{}]/;

export function literalToolNames(patterns: readonly string[]): string[] {
  return patterns.filter((pattern) => !isMcpToolName(pattern) && !GLOB_MAGIC.test(pattern));
}

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
