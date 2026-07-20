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

/**
 * True for a client-side subagent row that only the live event stream can
 * own: bound to the main turn and still `running`.
 * Suspended members keep status `running` (phase `suspended`), so this
 * covers them too — suspension is non-terminal, but it still belongs to the
 * current main turn's foreground execution. Background rows can outlive a
 * main turn; their owner may be the main agent's REST task store or a nested
 * agent represented by the snapshot roster.
 */
function isLiveMainTurnBoundSubagentRow(t: AppTask): boolean {
  return (
    t.kind === 'subagent' &&
    t.status === 'running' &&
    t.mainTurnIndependent !== true &&
    t.runInBackground !== true &&
    t.backgroundTaskId === undefined
  );
}

/**
 * Seed the task store from the snapshot's subagent roster. The roster is
 * authoritative for identity/status/phase; keep reducer-owned accumulated
 * output (outputLines/text) from any already-live task, and keep tasks the
 * roster does not know about (background bash tasks from REST).
 *
 * When the snapshot reports the main turn as INACTIVE (`mainTurnActive:
 * false`), still-live foreground rows the roster does NOT know are dropped
 * (issue #1963): their absence from the roster only proves the client-side
 * row is stale, not what the real terminal state was — the subagent may
 * have completed, failed, or detached while this client was disconnected,
 * and the roster forgets it once the next main turn starts. Removing the
 * row stops the ever-growing timer without fabricating a failure, and lets
 * the persisted transcript's Agent tool result drive the completed/error
 * display. The roster is authoritative when present: rows it owns are removed
 * when absent, including nested background work whose terminal event was
 * missed. Main-owned background entries remain REST `/tasks`-owned.
 */
export function mergeSnapshotSubagents(
  roster: AppTask[] | undefined,
  existing: AppTask[],
  opts?: { mainTurnActive?: boolean },
): AppTask[] {
  if (roster === undefined) {
    if (opts?.mainTurnActive !== false) return existing;
    const kept = existing.filter((task) => !isLiveMainTurnBoundSubagentRow(task));
    return kept.length === existing.length ? existing : kept;
  }
  const existingById = new Map(existing.map((t) => [t.id, t] as const));
  const rosterIds = new Set(roster.map((t) => t.id));
  const merged = roster.map((task) => {
    const live = existingById.get(task.id);
    if (!live) return task;
    return { ...task, outputLines: live.outputLines, text: live.text };
  });
  const kept = existing.filter(
    (t) =>
      !rosterIds.has(t.id) &&
      t.rosterOwned !== true &&
      (opts?.mainTurnActive !== false || !isLiveMainTurnBoundSubagentRow(t)),
  );
  if (merged.length === 0 && kept.length === existing.length) return existing;
  return kept.length === 0 ? merged : [...merged, ...kept];
}

/**
 * Reconcile still-live foreground rows at a main-turn boundary. They cannot
 * survive a completed main turn: drop them rather than fabricating a failed
 * terminal state when their terminal event was missed. An interrupted main
 * turn is the failure fallback for rows that the engine did not settle.
 */
export function settleStaleForegroundSubagents(
  tasks: AppTask[],
  outcome:
    | { readonly kind: 'completed' }
    | { readonly kind: 'interrupted'; readonly reason: string },
): AppTask[] {
  if (outcome.kind === 'completed') {
    return tasks.filter((t) => !isLiveMainTurnBoundSubagentRow(t));
  }
  return tasks.map((t) =>
    isLiveMainTurnBoundSubagentRow(t)
      ? {
          ...t,
          status: 'failed' as const,
          subagentPhase: 'failed' as const,
          completedAt: t.completedAt ?? new Date().toISOString(),
          outputPreview: t.outputPreview ?? outcome.reason,
        }
      : t,
  );
}
