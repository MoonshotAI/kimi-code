/**
 * Subscription granularity, attached per (connection × agent) at L3.
 *
 *  - 'off'   — nothing flows.
 *  - 'turn'  — turn headers and global state only (markers, taskrefs, tasks,
 *              meta, removals). Sessions can watch agents at this grade to
 *              get "turn completed" style notifications without content.
 *  - 'block' — adds step headers and full-state frame upserts at flush
 *              points; no `append` chunks.
 *  - 'delta' — the full stream, including `append` chunks.
 *
 * Convergence rules:
 *  - downgrade: simply drops in-flight content ops; the next flush upsert
 *    (emitted by the producer at frame/step/turn completion, always carrying
 *    whole L1 state) reconverges the client.
 *  - upgrade: the server re-sends a `reset` snapshot built from L1; the
 *    filter itself never invents a second projection path.
 */

export type TranscriptGrade = 'off' | 'turn' | 'block' | 'delta';

export const GRADE_RANK: Readonly<Record<TranscriptGrade, number>> = {
  off: 0,
  turn: 1,
  block: 2,
  delta: 3,
};

/**
 * Per-session subscription spec. Key `'*'` sets the default for all agents;
 * explicit agent ids override it. Absent spec === everything 'off'.
 */
export type TranscriptGradeSpec = Readonly<Record<string, TranscriptGrade | undefined>>;

export function gradeFor(spec: TranscriptGradeSpec | undefined, agentId: string): TranscriptGrade {
  if (!spec) return 'off';
  return spec[agentId] ?? spec['*'] ?? 'off';
}

/** Whether the transition needs the server to rebuild via reset snapshot. */
export function needsResetOnTransition(prev: TranscriptGrade, next: TranscriptGrade): boolean {
  return GRADE_RANK[next] > GRADE_RANK[prev];
}
