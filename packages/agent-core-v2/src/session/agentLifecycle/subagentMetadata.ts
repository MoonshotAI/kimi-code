/**
 * `agentLifecycle` domain (L6) — persisted subagent relationship labels.
 *
 * Provides the label helpers used by caller-owned agent-run wrappers (`Agent`
 * and `AgentSwarm`) to record and read the requester → subagent relationship
 * without making the flat lifecycle registry interpret parentage itself.
 */

import type { AgentMeta } from '#/session/sessionMetadata/sessionMetadata';

export function subagentLabels(
  parentAgentId: string,
  options: { readonly swarmItem?: string } = {},
): Readonly<Record<string, string>> {
  const labels: Record<string, string> = { parentAgentId };
  if (options.swarmItem !== undefined) {
    labels['swarmItem'] = options.swarmItem;
  }
  return labels;
}

export function labelsFromAgentMeta(
  meta: AgentMeta,
): Readonly<Record<string, string>> | undefined {
  const labels: Record<string, string> = { ...meta.labels };
  const parentAgentId = subagentParentAgentId(meta);
  if (parentAgentId !== undefined) {
    labels['parentAgentId'] = parentAgentId;
  }
  const swarmItem = subagentSwarmItem(meta);
  if (swarmItem !== undefined) {
    labels['swarmItem'] = swarmItem;
  }
  return Object.keys(labels).length > 0 ? labels : undefined;
}

export function isSubagentMeta(meta: AgentMeta | undefined): boolean {
  if (meta === undefined) return false;
  if (subagentParentAgentId(meta) !== undefined) return true;
  return meta.type === 'sub';
}

export function subagentParentAgentId(meta: AgentMeta | undefined): string | undefined {
  if (meta === undefined) return undefined;
  return firstNonEmpty(meta.labels?.['parentAgentId'], meta.parentAgentId ?? undefined);
}

export function subagentSwarmItem(meta: AgentMeta | undefined): string | undefined {
  if (meta === undefined) return undefined;
  return firstNonEmpty(meta.labels?.['swarmItem'], meta.swarmItem);
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string | undefined {
  return values.find((value) => value !== undefined && value.length > 0);
}
