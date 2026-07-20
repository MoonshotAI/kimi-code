import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Single source for the kimi-code core (CLI) version injected into the main
// bundle (tsdown.config.ts) and its tests (vitest.config.ts) as
// `__KIMI_CORE_VERSION__`. See tsdown.config.ts for why the embedded server
// must report this explicitly. The submodule must be checked out for the main
// bundle to build at all, so a missing file here is a hard error.
//
// Path resolution tries this module's own location first (plain node /
// tsdown), then falls back to the process cwd — vitest bundles its config
// (and this helper) into a `.vite-temp` dir, which breaks import.meta.url-
// relative reads; cwd is the package dir there.
const CANDIDATES = [
  fileURLToPath(new URL('../../kimi-code/apps/kimi-code/package.json', import.meta.url)),
  join(process.cwd(), 'kimi-code/apps/kimi-code/package.json'),
  join(process.cwd(), '../../kimi-code/apps/kimi-code/package.json'),
];

const pkgPath = CANDIDATES.find((candidate) => existsSync(candidate));
if (pkgPath === undefined) {
  throw new Error(`kimi-code CLI package.json not found; tried:\n${CANDIDATES.join('\n')}`);
}

export const KIMI_CORE_VERSION = JSON.parse(readFileSync(pkgPath, 'utf-8')).version;
