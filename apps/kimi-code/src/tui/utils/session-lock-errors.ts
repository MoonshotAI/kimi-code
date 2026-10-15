import { ErrorCodes, isKimiError } from '@moonshot-ai/kimi-code-sdk';
import type { KimiHarness, Session } from '@moonshot-ai/kimi-code-sdk';

import { sessionClientLabel, sessionLockHolderFromDetails } from './session-client';

export function isSessionOccupiedError(error: unknown): boolean {
  return isKimiError(error) && error.code === ErrorCodes.SESSION_OCCUPIED;
}

export function isSessionStaleError(error: unknown): boolean {
  return isKimiError(error) && error.code === ErrorCodes.SESSION_STALE;
}

export function occupiedHolderLabel(error: unknown): string {
  const holder = isKimiError(error) ? sessionLockHolderFromDetails(error.details) : undefined;
  return sessionClientLabel(holder);
}

export function occupiedHolderClientId(error: unknown): string {
  if (!isKimiError(error)) return 'unknown';
  return sessionLockHolderFromDetails(error.details)?.clientIdentity ?? 'unknown';
}

interface StaleReloadHost {
  readonly harness: KimiHarness;
  switchToSession(session: Session, message: string): Promise<void>;
  showError(msg: string): void;
  track(event: string, props?: Record<string, unknown>): void;
}

export async function reloadSessionAfterStale(
  host: StaleReloadHost,
  sessionId: string,
  statusMessage: string,
): Promise<void> {
  host.track('session_stale_reload', {});
  try {
    const reloaded = await host.harness.reloadSession({
      id: sessionId,
      forcePluginSessionStartReminder: true,
    });
    await host.switchToSession(reloaded, statusMessage);
  } catch {
    host.showError('Failed to reload the session. Run /reload to retry.');
  }
}
