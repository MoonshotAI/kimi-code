import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { getNativePackageRoot } from './native-assets';

type ModuleLoad = (request: string, parent: unknown, isMain: boolean) => unknown;

interface ModuleWithLoad {
  _load?: ModuleLoad;
}

const nodeRequire = createRequire(import.meta.url);
let installed = false;

const PI_TUI_NATIVE_PATTERN = /native[\\/](?:win32|darwin|linux)[\\/]prebuilds[\\/].+\.node$/;

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
