const KNOWN_CLIENT_LABELS: Readonly<Record<string, string>> = {
  kimi_code_cli: 'CLI',
  kimi_code_desktop: 'Desktop',
  kimi_code_web: 'Web',
  kimi_code_vscode: 'VS Code',
};

export interface SessionLockHolderLike {
  readonly clientIdentity?: string;
  readonly pid?: number;
  readonly hostname?: string;
}

export function sessionLockHolderFromDetails(details: unknown): SessionLockHolderLike | undefined {
  if (details === null || typeof details !== 'object') return undefined;
  const holder = (details as { holder?: unknown }).holder;
  if (holder === null || typeof holder !== 'object') return undefined;
  return holder as SessionLockHolderLike;
}

export function sessionClientLabel(holder: SessionLockHolderLike | undefined): string {
  const identity = holder?.clientIdentity;
  if (identity === undefined || identity === '' || identity === 'unknown') return 'another client';
  return KNOWN_CLIENT_LABELS[identity] ?? identity;
}
