export interface TowerActivityEvent {
  readonly at: string;
  readonly actor: string;
  readonly kind: string;
  readonly fields: Readonly<Record<string, string>>;
}

export const TOWER_ACTIVITY_FEED_KINDS: ReadonlySet<string> = new Set([
  'init',
  'plan',
  'spawn',
  'died',
  'revived',
  'merge',
  'merge.advanced',
  'merge.blocked',
  'merge.noop',
  'mission.update',
  'mission.rework',
  'review.write',
  'finding.file',
  'rebase',
  'rebase.mission',
  'adopt',
  'release',
  'teardown',
]);

export function parseTowerActivityLine(line: string): TowerActivityEvent | undefined {
  const tokens = line.trim().split(/\s+/);
  const at = tokens[0];
  let kindIndex = -1;
  for (let index = 2; index < tokens.length; index += 1) {
    if (TOWER_ACTIVITY_FEED_KINDS.has(tokens[index]!)) kindIndex = index;
  }
  if (at === undefined || at.length === 0 || kindIndex < 0) return undefined;
  const actor = tokens.slice(1, kindIndex).join(' ');
  const kind = tokens[kindIndex]!;
  const fields: Record<string, string> = {};
  for (const token of tokens.slice(kindIndex + 1)) {
    const separator = token.indexOf('=');
    if (separator <= 0) continue;
    fields[token.slice(0, separator)] = token.slice(separator + 1);
  }
  return { at, actor, kind, fields };
}
