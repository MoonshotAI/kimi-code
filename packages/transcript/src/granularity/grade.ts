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

/**
 * Apply an agent-grained detach to a grade spec: each listed agent drops to
 * an explicit 'off' (deleting the key would fall back to a non-off `'*'`
 * default and keep streaming); a listed `'*'` deletes the wildcard entry
 * instead. A spec with no remaining non-'off' entry collapses to `undefined`
 * — the pure-legacy state. `undefined` in, `undefined` out (idempotent).
 */
export function detachGrades(
  spec: TranscriptGradeSpec | undefined,
  agentIds: readonly string[],
): TranscriptGradeSpec | undefined {
  if (spec === undefined) return undefined;
  const next: Record<string, TranscriptGrade | undefined> = { ...spec };
  for (const agentId of agentIds) {
    if (agentId === '*') delete next['*'];
    else next[agentId] = 'off';
  }
  return Object.values(next).some((grade) => grade !== undefined && grade !== 'off')
    ? next
    : undefined;
}
