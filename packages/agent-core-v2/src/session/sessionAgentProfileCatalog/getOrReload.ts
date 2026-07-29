/**
 * `sessionAgentProfileCatalog` domain (L3) — reload-on-miss profile lookup.
 *
 * The merged catalog is scanned once when the session materializes and is not
 * refreshed afterward, so a long-lived session (e.g. one hosted by `kimi web`)
 * never sees agent files written after it started. Dispatch consumers call
 * `getProfileOrReload` instead of `ready` + `get`: on a miss it rescans the
 * file sources once via `reload()` and retries, so a newly written agent file
 * becomes dispatchable in a live session without a restart. Concurrent misses
 * share one in-flight reload per catalog; a name that is still unknown after
 * the rescan returns `undefined` and the caller's original error path applies.
 */

import type { AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';

import type { ISessionAgentProfileCatalog } from './sessionAgentProfileCatalog';

const reloadInFlight = new WeakMap<ISessionAgentProfileCatalog, Promise<void>>();

export async function getProfileOrReload(
  catalog: ISessionAgentProfileCatalog,
  name: string,
): Promise<AgentProfile | undefined> {
  await catalog.ready;
  const hit = catalog.get(name);
  if (hit !== undefined) return hit;
  let reload = reloadInFlight.get(catalog);
  if (reload === undefined) {
    reload = catalog.reload().finally(() => {
      if (reloadInFlight.get(catalog) === reload) reloadInFlight.delete(catalog);
    });
    reloadInFlight.set(catalog, reload);
  }
  await reload;
  return catalog.get(name);
}
