import type { ArtexTaskConstraint } from '#/features/artex/protocol/index';

export function renderConstraintBlock(
  constraints: readonly Pick<ArtexTaskConstraint, 'kind' | 'text'>[] | undefined,
): string {
  if (constraints === undefined || constraints.length === 0) return '';
  const allow: string[] = [];
  const deny: string[] = [];
  for (const constraint of constraints) {
    const text = constraint.text.trim();
    if (text === '') continue;
    if (constraint.kind === 'allow') {
      allow.push(`- ${text}`);
    } else {
      deny.push(`- ${text}`);
    }
  }
  if (allow.length === 0 && deny.length === 0) return '';
  const lines: string[] = [
    '[Operation constraints (highest priority, above every exploration/expansion heuristic below; before generating any intent or executing any action you must first self-check for violations — if it violates a constraint, do not proceed)]:',
  ];
  if (allow.length > 0) {
    lines.push('Allowed operations:', ...allow);
  }
  if (deny.length > 0) {
    lines.push('Forbidden operations:', ...deny);
  }
  lines.push(
    '(Discovering a new target/port/host outside the constraints does not grant authorization: unless it falls within the allowed range above, record it as an out-of-scope fact and skip it — do not spawn intents or execute actions for it.)',
  );
  return lines.join('\n');
}
