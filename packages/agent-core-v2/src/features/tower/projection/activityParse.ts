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
  const [at, actor, kind] = tokens;
  if (at === undefined || actor === undefined || kind === undefined) return undefined;
  if (!TOWER_ACTIVITY_FEED_KINDS.has(kind)) return undefined;
  const fields: Record<string, string> = {};
  for (const token of tokens.slice(3)) {
    const separator = token.indexOf('=');
    if (separator <= 0) continue;
    fields[token.slice(0, separator)] = token.slice(separator + 1);
  }
  return { at, actor, kind, fields };
}
