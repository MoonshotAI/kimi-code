import { ErrorCodes, isKimiError } from '@moonshot-ai/kimi-code-sdk';

export function isSessionOccupiedError(error: unknown): boolean {
  return isKimiError(error) && error.code === ErrorCodes.SESSION_OCCUPIED;
}

export function isSessionStaleError(error: unknown): boolean {
  return isKimiError(error) && error.code === ErrorCodes.SESSION_STALE;
}

interface OccupiedHolder {
  readonly clientIdentity?: string;
  readonly pid?: number;
  readonly hostname?: string;
}

function occupiedHolder(error: unknown): OccupiedHolder | undefined {
  if (!isKimiError(error)) return undefined;
  const details = error.details as { holder?: OccupiedHolder } | null | undefined;
  return details?.holder;
}

export function occupiedHolderClientId(error: unknown): string {
  return occupiedHolder(error)?.clientIdentity ?? 'unknown';
}

export function occupiedHolderSummary(error: unknown): string | undefined {
  const holder = occupiedHolder(error);
  if (holder?.pid === undefined || holder.pid <= 0) return undefined;
  if (holder.hostname === undefined || holder.hostname === '') return undefined;
  return `Process ${holder.pid} on ${holder.hostname} still has this session open.`;
}
