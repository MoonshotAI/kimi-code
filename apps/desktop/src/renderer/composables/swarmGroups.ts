import type { AppSubagentPhase, AppTask } from '../api/types';

export interface SwarmMember {
  id: string;
  name: string;
  subagentType?: string;
  phase: AppSubagentPhase;
  summary?: string;
  outputLines?: string[];
  /** Accumulated streaming text (text-kind taskProgress) — preferred over
   *  outputLines/summary when rendering the live swarm row activity/body. */
  text?: string;
  suspendedReason?: string;
  swarmIndex: number;
}

export interface SwarmGroup {
  id: string;
  members: SwarmMember[];
  counts: Record<AppSubagentPhase, number>;
}

const PHASES: readonly AppSubagentPhase[] = ['queued', 'working', 'suspended', 'completed', 'failed'];

export function phaseForTask(task: AppTask): AppSubagentPhase {
  // Terminal statuses are authoritative over a possibly-stale subagentPhase: a
  // cancelled task keeps whatever phase it last had (e.g. 'working'), which
  // would otherwise keep it "live" and suppress the finished swarm card forever.
  if (task.status === 'completed') return 'completed';
  if (task.status === 'failed' || task.status === 'cancelled') return 'failed';
  if (task.subagentPhase) return task.subagentPhase;
  return 'working';
}

function emptyCounts(): Record<AppSubagentPhase, number> {
  return {
    queued: 0,
    working: 0,
    suspended: 0,
    completed: 0,
    failed: 0,
  };
}

export function buildSwarmGroups(tasks: AppTask[]): SwarmGroup[] {
  const buckets = new Map<string, SwarmMember[]>();

  for (const task of tasks) {
    if (task.kind !== 'subagent' || task.swarmIndex === undefined) continue;
    const key = task.parentToolCallId ?? 'swarm';
    const list = buckets.get(key) ?? [];
    list.push({
      id: task.id,
      name: task.description,
      subagentType: task.subagentType,
      phase: phaseForTask(task),
      summary: task.outputPreview,
      outputLines: task.outputLines,
      text: task.text,
      suspendedReason: task.suspendedReason,
      swarmIndex: task.swarmIndex,
    });
    buckets.set(key, list);
  }

  return [...buckets.entries()]
    .map(([id, members]) => {
      const sorted = members.toSorted((a, b) => a.swarmIndex - b.swarmIndex || a.id.localeCompare(b.id));
      const counts = emptyCounts();
      for (const member of sorted) counts[member.phase]++;
      return { id, members: sorted, counts };
    })
    .filter((group) => group.members.length > 1)
    .toSorted((a, b) => {
      const ai = a.members.at(0)?.swarmIndex ?? 0;
      const bi = b.members.at(0)?.swarmIndex ?? 0;
      if (ai !== bi) return ai - bi;
      return a.id.localeCompare(b.id);
    });
}

export function countSwarmMembers(groups: SwarmGroup[]): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const group of groups) {
    total += group.members.length;
    for (const phase of PHASES) {
      if (phase === 'completed' || phase === 'failed') done += group.counts[phase];
    }
  }
  return { done, total };
}

/**
 * Bucket foreground/background subagent tasks by their spawning tool call and
 * return one member list per AgentSwarm call. Unlike buildSwarmGroups this keeps
 * single-member "swarms" (e.g. AgentSwarm used with one resume_agent_ids entry),
 * so the inline card can show a resumed subagent's live progress before the
 * structured result arrives. Also includes subagents without a swarmIndex so a
 * late-synced task still appears (sorted last).
 */
export function swarmMembersByToolCall(tasks: AppTask[]): Map<string, SwarmMember[]> {
  const buckets = new Map<string, SwarmMember[]>();
  for (const task of tasks) {
    if (task.kind !== 'subagent' || !task.parentToolCallId) continue;
    const list = buckets.get(task.parentToolCallId) ?? [];
    list.push({
      id: task.id,
      name: task.description,
      subagentType: task.subagentType,
      phase: phaseForTask(task),
      summary: task.outputPreview,
      outputLines: task.outputLines,
      text: task.text,
      suspendedReason: task.suspendedReason,
      swarmIndex: task.swarmIndex ?? Number.MAX_SAFE_INTEGER,
    });
    buckets.set(task.parentToolCallId, list);
  }
  for (const [key, members] of buckets) {
    buckets.set(
      key,
      members.toSorted((a, b) => a.swarmIndex - b.swarmIndex || a.id.localeCompare(b.id)),
    );
  }
  return buckets;
}
