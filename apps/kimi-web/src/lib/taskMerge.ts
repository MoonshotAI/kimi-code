import type { AppTask } from '../api/types';

/**
 * Append the live-only swarm subagents that a fresh REST `/tasks` list does not
 * contain.
 *
 * REST `/tasks` lists only the main agent's background-task store — it never
 * returns foreground swarm subagents (kind `'subagent'`), which arrive purely
 * through the WS event stream. Both the session-load task fetch and the 1s
 * output poll rebuild `tasksBySession` from that REST list, so a plain replace
 * would drop the subagents on every refresh and the next event would re-add
 * them, flickering the swarm/subagent cards (and their live "currently doing"
 * line) about once per second.
 *
 * Keep WS-owned subagent tasks that REST omits, so the REST refresh only governs
 * background tasks. REST stays authoritative for anything it does return.
 *
 * One exception: REST DOES return background subagents — keyed by their
 * background-task id, while the WS stream keys the same agent by agent id
 * (`backgroundTaskId` links the two, set from the `task.started`
 * registration). Fold the REST copy into the WS-owned row so one agent does
 * not surface as two rows; REST still corrects a terminal status the WS row
 * may have missed while disconnected.
 */
export function keepLiveSubagents(restBased: AppTask[], existing: AppTask[]): AppTask[] {
  const restIds = new Set(restBased.map((t) => t.id));
  const liveSubagents = existing.filter((t) => t.kind === 'subagent' && !restIds.has(t.id));
  if (liveSubagents.length === 0) return restBased;
  const restById = new Map(restBased.map((t) => [t.id, t] as const));
  const foldedRestIds = new Set<string>();
  const merged = liveSubagents.map((live) => {
    const rest =
      live.backgroundTaskId !== undefined ? restById.get(live.backgroundTaskId) : undefined;
    if (rest === undefined) return live;
    foldedRestIds.add(rest.id);
    // True when the fold — not the event stream — is what makes the row terminal.
    const restCompletesLiveRow = live.status === 'running' && rest.status !== 'running';
    return {
      ...live,
      // Terminal-stickiness: never let a lagging poll flip a finished row back
      // to running, but let REST complete a row whose finish event was missed.
      status: live.status === 'running' ? rest.status : live.status,
      // toAgentMember prefers subagentPhase over status, so sync it too —
      // otherwise the detail panel badge keeps showing a stale Working/Queued.
      // The phase enum has no 'cancelled'; the dock already styles cancelled
      // rows as failed.
      subagentPhase: restCompletesLiveRow
        ? rest.status === 'completed'
          ? 'completed'
          : 'failed'
        : live.subagentPhase,
      completedAt: live.completedAt ?? rest.completedAt,
      // REST output is authoritative once present: agent tasks persist their
      // result at completion, and a previously folded preview would otherwise
      // freeze the detail panel's Result.
      outputPreview: rest.outputPreview ?? live.outputPreview,
      outputBytes: rest.outputBytes ?? live.outputBytes,
    };
  });
  const rest = restBased.filter((t) => !foldedRestIds.has(t.id));
  return [...rest, ...merged];
}

/** True for a still-live foreground row that only the event stream/roster owns. */
export function isLiveForegroundSubagent(t: AppTask): boolean {
  return (
    t.kind === 'subagent' &&
    t.status === 'running' &&
    t.runInBackground !== true &&
    t.backgroundTaskId === undefined
  );
}

/**
 * Seed the task store from the snapshot's subagent roster. The roster is
 * authoritative for identity/status/phase; keep reducer-owned accumulated
 * output (outputLines/text) from any already-live task, and keep tasks the
 * roster does not own (background tasks from REST and terminal history).
 * Older servers omit the roster; only a present roster, including `[]`, may
 * remove a stale live foreground row. A side-channel agent id is also outside
 * roster ownership and survives an authoritative merge.
 */
export function mergeSnapshotSubagents(
  roster: AppTask[] | undefined,
  existing: AppTask[],
  sideChannelAgentId?: string,
): AppTask[] {
  if (roster === undefined) return existing;
  const existingById = new Map(existing.map((t) => [t.id, t] as const));
  const rosterIds = new Set(roster.map((t) => t.id));
  const merged = roster.map((task) => {
    const live = existingById.get(task.id);
    if (!live) return task;
    return { ...task, outputLines: live.outputLines, text: live.text };
  });
  const kept = existing.filter(
    (task) =>
      !rosterIds.has(task.id) &&
      (task.id === sideChannelAgentId || !isLiveForegroundSubagent(task)),
  );
  if (merged.length === 0 && kept.length === existing.length) return existing;
  return kept.length === 0 ? merged : [...merged, ...kept];
}
