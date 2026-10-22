import { ErrorCodes, isKimiError } from '@moonshot-ai/kimi-code-sdk';

export function isSessionOccupiedError(error: unknown): boolean {
  return isKimiError(error) && error.code === ErrorCodes.SESSION_OCCUPIED;
}

export function isSessionStaleError(error: unknown): boolean {
  return isKimiError(error) && error.code === ErrorCodes.SESSION_STALE;
}

export function occupiedHolderClientId(error: unknown): string {
  if (!isKimiError(error)) return 'unknown';
  const details = error.details as { holder?: { clientIdentity?: string } } | null | undefined;
  return details?.holder?.clientIdentity ?? 'unknown';
}
