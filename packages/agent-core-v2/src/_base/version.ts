/**
 * agent-core-v2 version helper — exposes the package version to integrations
 * (currently: the MCP client version).
 *
 * Resolves by walking up from this module to the nearest `package.json` named
 * `@moonshot-ai/agent-core-v2` — works in source/workspace layouts and
 * externalized installs (CLI, kap-server). Hosts that inline this source into
 * their own bundle get 'unknown'; the value is informational only.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = '@moonshot-ai/agent-core-v2';
const UNKNOWN_VERSION = 'unknown';
const MAX_WALK_UP = 8;

let cachedCoreVersion: string | undefined;

export function getCoreVersion(): string {
  cachedCoreVersion ??= walkForPackageVersion();
  return cachedCoreVersion;
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
