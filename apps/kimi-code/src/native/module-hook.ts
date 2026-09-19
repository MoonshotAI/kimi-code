import { existsSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { getNativePackageRoot } from './native-assets';

type ModuleLoad = (request: string, parent: unknown, isMain: boolean) => unknown;

interface ModuleWithLoad {
  _load?: ModuleLoad;
}

const nodeRequire = createRequire(import.meta.url);
let installed = false;

// pi-tui loads its platform-specific native helpers via an absolute-path
// require() computed from import.meta.url / process.execPath
// (see pi-tui dist/native-platform.js and dist/native-module-path.js). In a
// SEA binary those .node files live in the native-asset cache, so redirect
// any absolute require of a pi-tui native helper to the cached copy.
//
// Path shape: native/<darwin|linux|win32>/prebuilds/<arch>/<file>.node — note
// the two path segments after "prebuilds", so ".+" (not "[^/]+") is required.
const PI_TUI_NATIVE_PATTERN = /native[\\/](?:win32|darwin|linux)[\\/]prebuilds[\\/].+\.node$/;

// node-pty is externalized from the SEA bundle: its own JS locates the .node
// binding through a runtime-concatenated require that cannot survive bundling,
// so the whole package ships as native assets instead. Both call sites
// (remote-exec's processManager, agent-core-v2's hostTerminalService) reach it
// through a native `import('node-pty')`, which the CJS Module._load patch
// above cannot see — redirect the ESM resolution itself to the extracted
// package entry. Outside a SEA the lookup misses and resolution falls through
// to the default loader.
let nodePtyEntryUrl: string | null | undefined;

function resolveNodePtyEntryUrl(): string | null {
  if (nodePtyEntryUrl !== undefined) return nodePtyEntryUrl;
  const pkgRoot = getNativePackageRoot('node-pty');
  if (pkgRoot === null) {
    nodePtyEntryUrl = null;
    return null;
  }
  const entry = createRequire(join(pkgRoot, 'package.json')).resolve(pkgRoot);
  nodePtyEntryUrl = pathToFileURL(entry).href;
  return nodePtyEntryUrl;
}

export function installNativeModuleHook(): void {
  if (installed) return;
  installed = true;

  const moduleBuiltin = nodeRequire('node:module') as ModuleWithLoad;
  const originalLoad = moduleBuiltin._load;
  if (originalLoad !== undefined) {
    moduleBuiltin._load = function loadWithNativeAssets(
      this: unknown,
      request: string,
      parent: unknown,
      isMain: boolean,
    ): unknown {
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

  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'node-pty') {
        const url = resolveNodePtyEntryUrl();
        if (url !== null) {
          return { url, format: 'commonjs', shortCircuit: true };
        }
      }
      return nextResolve(specifier, context);
    },
  });
}
