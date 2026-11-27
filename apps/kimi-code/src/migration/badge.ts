const IMPORTED_BADGE = '[imported]';
const IMPORTED_FLAG_KEY = 'imported_from_kimi_cli';
const SOURCE_BADGES: Readonly<Record<string, string>> = {
  'claude-code': '[Claude Code]',
  codex: '[Codex]',
};

export interface SessionLabelInput {
  readonly title: string;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

export function isImportedSession(
  metadata: Readonly<Record<string, unknown>> | undefined,
): boolean {
  if (metadata === undefined) return false;
  return metadata[IMPORTED_FLAG_KEY] === true;
}

export function formatSessionLabel(input: SessionLabelInput): string {
  const source = input.metadata?.['imported_from'];
  const badge = isImportedSession(input.metadata)
    ? IMPORTED_BADGE
    : typeof source === 'string'
      ? SOURCE_BADGES[source]
      : undefined;
  return badge === undefined ? input.title : `${badge} ${input.title}`;
}
