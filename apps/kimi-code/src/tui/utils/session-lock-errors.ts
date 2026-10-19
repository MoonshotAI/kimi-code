import { ErrorCodes, isKimiError } from '@moonshot-ai/kimi-code-sdk';
import type { KimiHarness, Session } from '@moonshot-ai/kimi-code-sdk';

import { formatErrorMessage } from './event-payload';

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

interface StaleReloadHost {
  readonly harness: KimiHarness;
  reloadCurrentSessionView(
    session: Session,
    message: string,
    options?: { readonly replayHistory?: boolean },
  ): Promise<void>;
  showError(msg: string): void;
  track(event: string, props?: Record<string, unknown>): void;
}

export async function reloadSessionAfterStale(
  host: StaleReloadHost,
  sessionId: string,
  statusMessage: string,
): Promise<boolean> {
  try {
    const reloaded = await host.harness.reloadSession({
      id: sessionId,
      forcePluginSessionStartReminder: true,
    });
    await host.reloadCurrentSessionView(reloaded, statusMessage, { replayHistory: true });
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
