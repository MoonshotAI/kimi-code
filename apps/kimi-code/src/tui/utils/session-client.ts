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
