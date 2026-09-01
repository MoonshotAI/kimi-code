import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { getNativePackageRoot } from './native-assets';
import { loadNativePackage } from './native-require';

type ModuleLoad = (request: string, parent: unknown, isMain: boolean) => unknown;

interface ModuleWithLoad {
  _load?: ModuleLoad;
}

const nodeRequire = createRequire(import.meta.url);

// Bare-specifier native packages that ship as SEA native assets. In a SEA
// binary there is no node_modules next to the executable, so redirect the
// require to the extracted native-asset cache; loadNativePackage returns null
// outside SEA and the normal resolution below takes over. The reentrancy
// guard lets the cache-root require inside loadNativePackage fall through to
// the original loader.
const NATIVE_ASSET_PACKAGES = new Set(['@napi-rs/keyring']);

let installed = false;
let loadingNativePackage = false;

// pi-tui loads its platform-specific native helpers via an absolute-path
// require() computed from import.meta.url / process.execPath
// (see pi-tui dist/terminal.js and dist/native-modifiers.js). In a SEA binary
// those .node files live in the native-asset cache, so redirect any absolute
// require of a pi-tui native helper to the cached copy.
//
// Path shape: native/<darwin|win32>/prebuilds/<arch>/<file>.node — note the
// two path segments after "prebuilds", so ".+" (not "[^/]+") is required.
const PI_TUI_NATIVE_PATTERN = /native[\\/](?:win32|darwin)[\\/]prebuilds[\\/].+\.node$/;

export function installNativeModuleHook(): void {
  if (installed) return;
  installed = true;

  const moduleBuiltin = nodeRequire('node:module') as ModuleWithLoad;
  const originalLoad = moduleBuiltin._load;
  if (originalLoad === undefined) return;

  moduleBuiltin._load = function loadWithNativeAssets(
    this: unknown,
    request: string,
    parent: unknown,
    isMain: boolean,
  ): unknown {
    if (NATIVE_ASSET_PACKAGES.has(request) && !loadingNativePackage) {
      loadingNativePackage = true;
      try {
        const pkg = loadNativePackage<unknown>(request);
        if (pkg !== null) return pkg;
      } finally {
        loadingNativePackage = false;
      }
    }
    if (
      typeof request === 'string' &&
      PI_TUI_NATIVE_PATTERN.test(request) &&
      !existsSync(request)
    ) {
      const pkgRoot = getNativePackageRoot('@moonshot-ai/pi-tui');
      if (pkgRoot !== null) {
        const match = request.match(PI_TUI_NATIVE_PATTERN);
        if (match !== null) {
          const redirected = join(pkgRoot, match[0]);
          return originalLoad.call(this, redirected, parent, isMain);
        }
      }
    }
    return originalLoad.call(this, request, parent, isMain);
  };
}
