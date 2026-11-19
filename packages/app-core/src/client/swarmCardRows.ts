
import type { AppSubagentPhase } from '../api/types';
import type { SwarmMember } from './swarmGroups';
import type { SwarmResult, SwarmResultSubagent } from '../lib/parseSwarmResult';

export interface SwarmCardRow {
  id: string;
  agentId?: string;
  taskId?: string;
  name: string;
  activity: string;
  detail: string;
  phase: AppSubagentPhase;
  suspendedReason?: string;
}

function lastNonEmptyLine(text: string | undefined): string {
  if (!text) return '';
  return text.split('\n').map((l) => l.trimEnd()).filter(Boolean).at(-1) ?? '';
}

export function swarmMemberActivity(member: SwarmMember): string {
  return (
    member.suspendedReason ||
    lastNonEmptyLine(member.text) ||
    lastNonEmptyLine(member.outputLines?.join('\n')) ||
    ''
  );
}

export function swarmMemberDetail(member: SwarmMember): string {
  return (member.text || member.outputLines?.join('\n') || '').trim();
}

function stripAgentType(name: string, subagentType: string | undefined): string {
  if (subagentType === undefined) return name;
  const suffix = ` (${subagentType})`;
  return name.endsWith(suffix) ? name.slice(0, name.length - suffix.length) : name;
}

function outcomeToPhase(outcome: string): AppSubagentPhase {
  if (outcome === 'completed') return 'completed';
  if (outcome === 'failed') return 'failed';
  if (outcome === 'aborted') return 'cancelled';
  return 'working';
}

function resultRow(sub: SwarmResultSubagent, index: number): SwarmCardRow {
  return {
    id: sub.agentId ?? sub.item ?? `result-${index}`,
    agentId: sub.agentId,
    name: sub.item ?? `subagent ${index + 1}`,
    activity: sub.body.split('\n')[0] ?? '',
    detail: sub.body,
    phase: outcomeToPhase(sub.outcome),
  };
}

function memberCoversResult(member: SwarmMember, sub: SwarmResultSubagent): boolean {
  if (sub.agentId && member.agentId === sub.agentId) return true;
  if (sub.item && member.name.includes(sub.item)) return true;
  return false;
}

export function buildSwarmCardRows(members: SwarmMember[], result: SwarmResult | null): SwarmCardRow[] {
  const sharedType =
    members.length > 0 && members.every((m) => m.subagentType !== undefined && m.subagentType === members[0]?.subagentType)
      ? members[0]?.subagentType
      : undefined;
  const memberRows = members.map((m) => ({
    id: m.id,
    agentId: m.agentId,
    taskId: m.id,
    name: sharedType ? stripAgentType(m.name, sharedType) : m.name,
    activity: swarmMemberActivity(m),
    detail: swarmMemberDetail(m),
    phase: m.phase,
    suspendedReason: m.suspendedReason,
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
