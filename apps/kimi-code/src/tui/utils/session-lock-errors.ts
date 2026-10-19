import { ErrorCodes, isKimiError } from '@moonshot-ai/kimi-code-sdk';
import type { KimiHarness, Session } from '@moonshot-ai/kimi-code-sdk';

import { formatErrorMessage } from './event-payload';
import { sessionLockHolderFromDetails } from './session-client';

export function isSessionOccupiedError(error: unknown): boolean {
  return isKimiError(error) && error.code === ErrorCodes.SESSION_OCCUPIED;
}

export function isSessionStaleError(error: unknown): boolean {
  return isKimiError(error) && error.code === ErrorCodes.SESSION_STALE;
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
  beforeSwitch?: () => () => void,
): Promise<boolean> {
  try {
    const reloaded = await host.harness.reloadSession({
      id: sessionId,
      forcePluginSessionStartReminder: true,
    });
    const unpark = beforeSwitch?.();
    try {
      await host.switchToSession(reloaded, statusMessage);
    } finally {
      unpark?.();
    }
    host.track('session_stale_reload', { outcome: 'reloaded' });
    return true;
  } catch (error) {
    host.track('session_stale_reload', { outcome: 'failed' });
    host.showError(
      `Failed to reload the session: ${formatErrorMessage(error)} Run /reload to retry.`,
    );
    return false;
  }
}
