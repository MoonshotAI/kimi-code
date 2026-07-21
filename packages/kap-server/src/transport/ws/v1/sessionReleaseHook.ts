/**
 * Shared registration for the `onWillReleaseSession` lifecycle hook used by the
 * v1 WS transport pieces ({@link SessionEventBroadcaster}, {@link FsWatchBridge},
 * {@link SkillCatalogBridge}): each drops its own per-session state for the
 * released session, then lets the release chain proceed.
 */

import {
  type IDisposable,
  ISessionLifecycleService,
  type Scope,
} from '@moonshot-ai/agent-core-v2';

/** Register `release(sessionId)` to run (before `next()`) when a session scope is released. */
export function registerSessionReleaseHook(
  core: Scope,
  name: string,
  release: (sessionId: string) => void | Promise<void>,
): IDisposable {
  return core.accessor
    .get(ISessionLifecycleService)
    .hooks.onWillReleaseSession.register(name, async ({ sessionId }, next) => {
      await release(sessionId);
      await next();
    });
}
