/**
 * Shared fakes for the WS v1 session-event tests (`sessionEventBroadcaster`,
 * `sessionEventJournal`, `skillCatalogBridge`).
 */
import { type SessionLifecycleHooks } from '@moonshot-ai/agent-core-v2';
import { createHooks } from '@moonshot-ai/agent-core-v2/hooks';

/** The lifecycle hook set the fake cores expose at `ISessionLifecycleService.hooks`. */
export function createSessionLifecycleHooks() {
  return createHooks<SessionLifecycleHooks, keyof SessionLifecycleHooks>([
    'onDidCreateSession',
    'onWillCloseSession',
    'onWillReleaseSession',
  ]);
}

/**
 * Build the write failure the `node:fs/promises` mocks inject into journal
 * flushes: a plain `EACCES` errno error — the ordinary storage failure the
 * journal's retry-then-sticky durability tests drive.
 */
export function injectWriteFailure(): Error {
  const error = new Error('injected journal write failure') as NodeJS.ErrnoException;
  error.code = 'EACCES';
  return error;
}
