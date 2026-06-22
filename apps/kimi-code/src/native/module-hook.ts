import { createRequire } from 'node:module';

import { loadNativePackage } from './native-require';

type ModuleLoad = (request: string, parent: unknown, isMain: boolean) => unknown;

interface ModuleWithLoad {
  _load?: ModuleLoad;
}

const nodeRequire = createRequire(import.meta.url);
const NATIVE_ASSET_PACKAGES = new Set(['koffi', '@napi-rs/keyring']);
let installed = false;
let loadingNativePackage = false;

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
    return originalLoad.call(this, request, parent, isMain);
  };
}
