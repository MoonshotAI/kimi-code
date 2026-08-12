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
      // The wire phase enum has no 'cancelled'; the UI still renders 已取消
      // from the terminal status (it wins over the phase in toAgentMember).
      subagentPhase: restCompletesLiveRow
        ? rest.status === 'completed'
          ? 'completed'
          : 'failed'
        : live.subagentPhase,
      // REST's daemon-stamped time beats a locally estimated one (and
      // clears the marker); the live stamp is the fallback only.
      completedAt: rest.completedAt ?? live.completedAt,
      completedAtEstimated: rest.completedAt !== undefined ? undefined : live.completedAtEstimated,
      // REST output is authoritative once present: agent tasks persist their
      // result at completion, and a previously folded preview would otherwise
      // freeze the detail panel's Result.
      outputPreview: rest.outputPreview ?? live.outputPreview,
      outputBytes: rest.outputBytes ?? live.outputBytes,
      // Display metadata: the live row wins when it has it (the event stream
      // is fresher); a skeleton live row picks it up from the REST record.
      model: live.model ?? rest.model,
      thinkingEffort: live.thinkingEffort ?? rest.thinkingEffort,
    };
  });
  const rest = restBased.filter((t) => !foldedRestIds.has(t.id));
  return [...rest, ...merged];
}

/**
 * Seed the task store from the snapshot's subagent roster. The roster is
 * authoritative for identity/status/phase; keep reducer-owned accumulated
 * output (outputLines/text) and the locally observed completion stamp from
 * any already-live task (an old daemon's roster omits completed_at, and
 * dropping it re-sorts a just-finished row back by createdAt), and keep
 * tasks the roster does not know about (background bash tasks from REST).
 * Display metadata merges the same way, in case either side lacks it.
 */
export function mergeSnapshotSubagents(roster: AppTask[], existing: AppTask[]): AppTask[] {
  if (roster.length === 0) return existing;
  const existingById = new Map(existing.map((t) => [t.id, t] as const));
  const rosterIds = new Set(roster.map((t) => t.id));
  const merged = roster.map((task) => {
    const live = existingById.get(task.id);
    if (!live) return task;
    const estimated =
      task.completedAt === undefined &&
      live.completedAt === undefined &&
      live.status === 'running' &&
      task.status !== 'running';
    return {
      ...task,
      outputLines: live.outputLines,
      text: live.text,
      // Same transition stamping as the REST poll path: a snapshot that first
      // turns a locally running row terminal (old daemons omit completed_at)
      // records when the finish was observed, or the row falls back to its
      // much older createdAt in the recency sort and drops out of the
      // default view.
      completedAt:
        task.completedAt ?? live.completedAt ?? (estimated ? new Date().toISOString() : undefined),
      // The marker follows whichever stamp won: a real stamp clears it.
      completedAtEstimated:
        task.completedAt !== undefined
          ? undefined
          : live.completedAt !== undefined
            ? live.completedAtEstimated
            : estimated
              ? true
              : undefined,
      model: task.model ?? live.model,
      thinkingEffort: task.thinkingEffort ?? live.thinkingEffort,
    };
  });
  const kept = existing.filter((t) => !rosterIds.has(t.id));
  return kept.length === 0 ? merged : [...merged, ...kept];
}
