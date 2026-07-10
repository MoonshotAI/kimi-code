// apps/kimi-web/src/lib/swarmCardRows.ts
// Build the accordion row model for the AgentSwarm inline tool card. Pure
// function of live members (AppTask store, real-time phase) and the parsed
// `<agent_swarm_result>` payload (terminal result) — kept in plain TS so it can
// be unit-tested without mounting the component.

import type { AppSubagentPhase } from '../api/types';
import type { SwarmMember } from '../composables/swarmGroups';
import type { SwarmResult, SwarmResultSubagent } from './parseSwarmResult';

export interface SwarmCardRow {
  id: string;
  name: string;
  activity: string;
  phase: AppSubagentPhase;
  body: string;
}

function lastNonEmptyLine(text: string | undefined): string {
  if (!text) return '';
  return text.split('\n').map((l) => l.trimEnd()).filter(Boolean).at(-1) ?? '';
}

export function swarmMemberActivity(member: SwarmMember): string {
  // Prefer streamed subagent text so a still-composing agent shows its latest
  // line instead of an empty / last-summary row.
  return (
    member.suspendedReason ||
    lastNonEmptyLine(member.text) ||
    lastNonEmptyLine(member.outputLines?.join('\n')) ||
    member.summary ||
    ''
  );
}

function swarmMemberBody(member: SwarmMember): string {
  if (member.suspendedReason) return member.suspendedReason;
  if (member.text) return member.text;
  if (member.outputLines && member.outputLines.length > 0) return member.outputLines.join('\n');
  return member.summary ?? '';
}

function outcomeToPhase(outcome: string): AppSubagentPhase {
  if (outcome === 'completed') return 'completed';
  if (outcome === 'failed' || outcome === 'aborted') return 'failed';
  return 'working';
}

function resultRow(sub: SwarmResultSubagent, index: number): SwarmCardRow {
  return {
    id: sub.agentId ?? sub.item ?? `result-${index}`,
    name: sub.item ?? `subagent ${index + 1}`,
    activity: sub.body.split('\n')[0] ?? '',
    phase: outcomeToPhase(sub.outcome),
    body: sub.body,
  };
}

/**
 * Whether a live member already accounts for a result subagent. Members may
 * come from the projector (task id / description) while the result references
 * agent_id / item; the two ids don't always match, so also treat item ⊆
 * description as a match.
 */
function memberCoversResult(member: SwarmMember, sub: SwarmResultSubagent): boolean {
  if (sub.agentId && member.id === sub.agentId) return true;
  if (sub.item && member.name.includes(sub.item)) return true;
  return false;
}

/**
 * Merge the live members with the agent_swarm_result payload into one row list.
 *
 * - Members are authoritative while present (real-time phase + streamed text).
 * - When a parsed result is also present, append result rows that no member
 *   covers — e.g. interrupted swarms emit `state="not_started"` /
 *   `outcome="aborted"` entries for items that never spawned a task, which
 *   would otherwise be invisible until a refresh dropped the live tasks.
 * - When no members are present (post-refresh), fall back to result-only rows.
 */
export function buildSwarmCardRows(members: SwarmMember[], result: SwarmResult | null): SwarmCardRow[] {
  const memberRows = members.map((m) => ({
    id: m.id,
    name: m.name,
    activity: swarmMemberActivity(m),
    phase: m.phase,
    body: swarmMemberBody(m),
  }));
  if (!result) return memberRows;

  const resultOnly = result.subagents
    .filter(
      (sub) =>
        (sub.outcome === 'aborted' || sub.state === 'not_started') &&
        !members.some((m) => memberCoversResult(m, sub)),
    )
    .map((sub, i) => resultRow(sub, i));

  return memberRows.length > 0 ? [...memberRows, ...resultOnly] : result.subagents.map((s, i) => resultRow(s, i));
}
