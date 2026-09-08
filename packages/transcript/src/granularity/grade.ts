export type TranscriptGrade = 'off' | 'turn' | 'block' | 'delta';

export const GRADE_RANK: Readonly<Record<TranscriptGrade, number>> = {
  off: 0,
  turn: 1,
  block: 2,
  delta: 3,
};

export type TranscriptGradeSpec = Readonly<Record<string, TranscriptGrade | undefined>>;

export function gradeFor(spec: TranscriptGradeSpec | undefined, agentId: string): TranscriptGrade {
  if (!spec) return 'off';
  return spec[agentId] ?? spec['*'] ?? 'off';
}

export function needsResetOnTransition(prev: TranscriptGrade, next: TranscriptGrade): boolean {
  return GRADE_RANK[next] > GRADE_RANK[prev];
}

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
