/**
 * Bundled wiring-plugin resolution for built-in capabilities.
 *
 * The `kimi-cu` / `kimi-webbridge` wiring plugins ship INSIDE the client
 * release (npm package / desktop resources / native SEA blob) instead of the
 * marketplace catalog, so their visibility is bound to the client version —
 * older clients simply never see them. This module locates the bundled copy
 * of a plugin at runtime, in priority order:
 *
 *   1. `KIMI_CODE_BUNDLED_PLUGINS_DIR` — explicit override naming the
 *      directory that holds one subdirectory per plugin id. The desktop app
 *      points this at its `extraResources` copy; the native (SEA) CLI sets it
 *      after extracting the embedded asset tree into its cache; tests use it
 *      for fixtures.
 *   2. A walk up from this module probing `<dir>/bundled-plugins/<id>`
 *      (installed npm package layout — the build copies the plugins next to
 *      `dist/`) and `<dir>/plugins/official/<id>` (source checkout, i.e. dev).
 *
 * A probe candidate only counts when `<candidate>/kimi.plugin.json` exists,
 * so a partial or unrelated directory never resolves.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const BUNDLED_PLUGINS_DIR_ENV = 'KIMI_CODE_BUNDLED_PLUGINS_DIR';

const MANIFEST_FILE = 'kimi.plugin.json';
/** Layouts probed at every ancestor, most specific first. */
const LAYOUTS = ['bundled-plugins', join('plugins', 'official')] as const;
const MAX_WALK_UP = 8;

const MODULE_DIR = import.meta.dirname;

/**
 * Resolve the directory of the bundled copy of `pluginId`, or undefined when
 * no copy is available (e.g. a build that does not ship the plugins). Every
 * candidate — including the explicit `rootOverride` (from
 * `CapabilityEntryContext.bundledPluginsRoot`) — must carry a
 * `kimi.plugin.json` marker, so a missing or partial bundle resolves to
 * undefined and surfaces as the clear `requireBundledPluginDir` error instead
 * of an opaque plugin-manager failure on a bad path.
 */
export function resolveBundledPluginDir(
  pluginId: string,
  rootOverride?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (rootOverride !== undefined) return withManifest(join(rootOverride, pluginId));
  const envRoot = env[BUNDLED_PLUGINS_DIR_ENV];
  if (envRoot !== undefined && envRoot.trim().length > 0) {
    return withManifest(join(envRoot, pluginId));
  }
  return probeUpwards(MODULE_DIR, pluginId);
}

/** Walk up from `startDir` probing each layout; exported for tests. */
function probeUpwards(startDir: string, pluginId: string): string | undefined {
  let dir = startDir;
  for (let i = 0; i < MAX_WALK_UP; i += 1) {
    for (const layout of LAYOUTS) {
      const resolved = withManifest(resolve(dir, layout, pluginId));
      if (resolved !== undefined) return resolved;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export const __bundledPluginsInternals = { probeUpwards };

function withManifest(candidate: string): string | undefined {
  return existsSync(join(candidate, MANIFEST_FILE)) ? candidate : undefined;
}

/**
 * `resolveBundledPluginDir` for capability install paths: a missing bundle
 * is a hard error with actionable wording instead of an opaque plugin-manager
 * failure on a nonexistent path.
 */
export function requireBundledPluginDir(
  pluginId: string,
  rootOverride?: string,
  env?: NodeJS.ProcessEnv,
): string {
  const dir = resolveBundledPluginDir(pluginId, rootOverride, env);
  if (dir === undefined) {
    throw new Error(
      `The bundled "${pluginId}" plugin is missing from this installation — ` +
        `reinstall or upgrade the client, then try again.`,
    );
  }
  return dir;
}
