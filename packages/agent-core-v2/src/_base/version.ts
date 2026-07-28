/**
 * agent-core-v2 version helper — the single owner of the engine version
 * exposed to integrations (telemetry `core_version`, MCP client version).
 *
 * Resolution order:
 *  1. `__KIMI_CORE_V2_VERSION__`, a bundler define for hosts that inline this
 *     source into their own artifact (e.g. an Electron main bundle), where
 *     the package layout below no longer exists;
 *  2. a walk up from this module to the nearest `package.json` named
 *     `@moonshot-ai/agent-core-v2` — works in source/workspace layouts and
 *     externalized installs (CLI, kap-server);
 *  3. `'unknown'` when neither yields a version.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

declare const __KIMI_CORE_V2_VERSION__: string | undefined;

const PACKAGE_NAME = '@moonshot-ai/agent-core-v2';
const UNKNOWN_VERSION = 'unknown';
const MAX_WALK_UP = 8;

let cachedCoreVersion: string | undefined;

export function getCoreVersion(): string {
  cachedCoreVersion ??= injectedVersion() ?? walkForPackageVersion();
  return cachedCoreVersion;
}

function injectedVersion(): string | undefined {
  return typeof __KIMI_CORE_V2_VERSION__ === 'string' && __KIMI_CORE_V2_VERSION__.length > 0
    ? __KIMI_CORE_V2_VERSION__
    : undefined;
}

function walkForPackageVersion(): string {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < MAX_WALK_UP; i++) {
      const candidate = resolve(dir, 'package.json');
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, 'utf-8')) as {
          name?: string;
          version?: string;
        };
        if (pkg.name === PACKAGE_NAME && typeof pkg.version === 'string') {
          return pkg.version;
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
  }
  return UNKNOWN_VERSION;
}
