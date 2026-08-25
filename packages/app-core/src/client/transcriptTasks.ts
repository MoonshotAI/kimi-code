// packages/app-core/src/client/transcriptTasks.ts
// TranscriptTask entities → the dock's AppTask rows. The daemon's transcript
// projector already resolved the identity/rekeying concerns the legacy
// reducer handled client-side (backgroundTaskId aliasing, terminal-status
// guards), so this is a straight field mapping plus one derivation: a
// subagent's parentToolCallId comes from the spawning tool frame's agentRefs.

import type { AgentTranscriptSnapshot, TranscriptTask } from '../transcript';
import type { AppSubagentPhase, AppTask, AppTaskStatus } from '../api/types';

function toAppTaskStatus(state: TranscriptTask['state']): AppTaskStatus {
  switch (state) {
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'killed':
      return 'cancelled';
    default:
      return 'failed';
  }
}

function toSubagentPhase(task: TranscriptTask, status: AppTaskStatus): AppSubagentPhase {
  if (status === 'running') return task.stateReason !== undefined ? 'suspended' : 'working';
  return status;
}

function toAppTaskKind(kind: TranscriptTask['kind']): AppTask['kind'] {
  if (kind === 'subagent') return 'subagent';
  if (kind === 'shell') return 'bash';
  return 'tool';
}

/** toolCallId of the frame that spawned each agent, from the tool frames'
 *  agentRefs — the inverse index of AgentRef[]. The ref's position inside its
 *  frame is the member's swarm index (an AgentSwarm call lists its members in
 *  order). */
export function spawnedParentByAgentId(snapshot: AgentTranscriptSnapshot): Map<string, string> {
  return spawnedIndex(snapshot).parents;
}

export interface SpawnedIndex {
  parents: Map<string, string>;
  swarmIndexes: Map<string, number>;
}

function spawnedIndex(snapshot: AgentTranscriptSnapshot): SpawnedIndex {
  const parents = new Map<string, string>();
  const swarmIndexes = new Map<string, number>();
  for (const item of snapshot.items) {
    if (item.kind !== 'turn') continue;
    for (const step of item.steps) {
      for (const frame of step.frames) {
        if (frame.kind !== 'tool' || frame.agentRefs === undefined) continue;
        frame.agentRefs.forEach((ref, refIndex) => {
          // A resume spawn re-links the agent to its LATEST spawning call.
          parents.set(ref.agentId, frame.toolCallId);
          swarmIndexes.set(ref.agentId, refIndex);
        });
      }
    }
  }
  return { parents, swarmIndexes };
}

export function transcriptTasksToAppTasks(
  snapshot: AgentTranscriptSnapshot,
  sessionId: string,
  spawnedCache?: SpawnedIndex,
): AppTask[] {
  const current = spawnedIndex(snapshot);
  // Merge the window's findings into the persistent cache (current wins — a
  // resume re-links to the LATEST spawning call), then resolve from it: a
  // subagent spawned BEFORE the paged window still finds its parent call and
  // swarm index. Without the cache the window is the whole world and such
  // tasks render parentless (dropped from swarm groups).
  let parents = current.parents;
  let swarmIndexes = current.swarmIndexes;
  if (spawnedCache !== undefined) {
    for (const [agentId, toolCallId] of current.parents) {
      spawnedCache.parents.set(agentId, toolCallId);
    }
    for (const [agentId, index] of current.swarmIndexes) {
      spawnedCache.swarmIndexes.set(agentId, index);
    }
    parents = spawnedCache.parents;
    swarmIndexes = spawnedCache.swarmIndexes;
  }
  const rows: AppTask[] = snapshot.tasks.map((task) => {
    const status = toAppTaskStatus(task.state);
    return {
      id: task.taskId,
      agentId: task.agentId,
      sessionId,
      kind: toAppTaskKind(task.kind),
      description: task.description ?? '',
      status,
      createdAt: task.startedAt ?? '',
      startedAt: task.startedAt,
      completedAt: task.endedAt,
      outputPreview: task.outputTail.length > 0 ? task.outputTail : undefined,
      text: task.resultSummary,
      subagentPhase: task.kind === 'subagent' ? toSubagentPhase(task, status) : undefined,
      // The pause reason rides only a RUNNING task (approval waits); a
      // terminal state's reason is the failure cause, not a suspension.
      suspendedReason: status === 'running' ? task.stateReason : undefined,
      model: task.model,
      thinkingEffort: task.thinkingEffort,
      runInBackground: task.detached,
      parentToolCallId:
        task.agentId !== undefined ? parents.get(task.agentId) : undefined,
      swarmIndex: task.agentId !== undefined ? swarmIndexes.get(task.agentId) : undefined,
    };
  });
  // A background subagent arrives as TWO entities: the agent run (taskId ===
  // agentId, live events link here) and its background-task row (task-store
  // id — the id REST /tasks reports the model under). Fold them into one dock
  // row keyed by the agent id, keeping the task-store id as the alias.
  const primaryByAgentId = new Map<string, number>();
  rows.forEach((row, index) => {
    if (row.agentId !== undefined && row.id === row.agentId) primaryByAgentId.set(row.agentId, index);
  });
  const absorbed = new Set<number>();
  rows.forEach((row, index) => {
    if (row.agentId === undefined || row.id === row.agentId) return;
    const primaryIndex = primaryByAgentId.get(row.agentId);
    if (primaryIndex === undefined) return;
    const primary = rows[primaryIndex]!;
    // The task-store row is authoritative once terminal: the agent run's own
    // end can go missing (its projection isn't backfilled on a cold rebuild),
    // and dropping the secondary's status/output here would show the subagent
    // running forever — the same settle the REST fold does downstream. But a
    // RESUMED agent re-uses the same agentId: a terminal secondary left over
    // from a previous background run belongs to an older generation and must
    // not settle the new primary — only accept a stamp from this generation
    // (completed after the primary's current start; missing stamps can't be
    // proven current and are left to the REST fold). Status settling still
    // requires the running→terminal transition, but CONTENT merges on the
    // same-generation fact alone: a primary already terminal via the agent
    // side may carry no output of its own.
    const sameGeneration =
      row.completedAt !== undefined &&
      primary.startedAt !== undefined &&
      row.completedAt >= primary.startedAt;
    const secondaryCompletes =
      primary.status === 'running' && row.status !== 'running' && sameGeneration;
    rows[primaryIndex] = {
      ...primary,
      // The alias rides only a CURRENT secondary: a still-running one (this
      // generation's own task-store row) or a terminal one proven
      // same-generation. An old generation's id must not bind here —
      // cancelTask would aim at the FINISHED previous run.
      backgroundTaskId: row.status === 'running' || sameGeneration ? row.id : undefined,
      status: secondaryCompletes ? row.status : primary.status,
      subagentPhase: secondaryCompletes
        ? row.status === 'completed'
          ? 'completed'
          : // A user-initiated cancel is not a failure — the phase must agree
            // with the row's own status.
            row.status === 'cancelled'
            ? 'cancelled'
            : 'failed'
        : primary.subagentPhase,
      description: primary.description.length > 0 ? primary.description : row.description,
      model: primary.model ?? row.model,
      thinkingEffort: primary.thinkingEffort ?? row.thinkingEffort,
      // Terminal CONTENT fields ride the same generation guard: an old
      // secondary's stamp/result belongs to the previous run and must not
      // leak onto the resumed row either.
      completedAt: sameGeneration ? row.completedAt ?? primary.completedAt : primary.completedAt,
      outputPreview: sameGeneration
        ? primary.outputPreview ?? row.outputPreview
        : primary.outputPreview,
      text: sameGeneration ? primary.text ?? row.text : primary.text,
    };
    absorbed.add(index);
  });
  return rows.filter((_, index) => !absorbed.has(index));
}
