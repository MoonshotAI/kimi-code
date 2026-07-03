'use strict';

// electron-builder `beforePack` hook.
//
// Each electron-builder run targets one (platform, arch). We stage the matching
// prebuilt Kimi SEA backend into `resources-stage/bin/<target>/` so that the
// `extraResources` rule copies exactly that one binary into the packaged app's
// resources. sea-path.ts resolves `<resources>/bin/<target>/kimi[.exe]` at
// runtime, where <target> is `${process.platform}-${process.arch}`.

const { existsSync, rmSync, mkdirSync, cpSync } = require('node:fs');
const { join, resolve } = require('node:path');

// electron-builder Arch enum -> Node `process.arch` name.
const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };

exports.default = async function beforePack(context) {
  const platform = context.electronPlatformName; // 'darwin' | 'win32' | 'linux'
  const archName = ARCH_NAMES[context.arch];
  if (archName === undefined) {
    throw new Error(`Unsupported arch for packaging: ${String(context.arch)}`);
  }
  const target = `${platform}-${archName}`;
  const exe = platform === 'win32' ? 'kimi.exe' : 'kimi';

  const desktopRoot = resolve(__dirname, '..');
  const seaDir = resolve(desktopRoot, '..', 'kimi-code', 'dist-native', 'bin', target);
  const seaExe = join(seaDir, exe);
  if (!existsSync(seaExe)) {
    throw new Error(
      `Bundled Kimi server not found for ${target} at ${seaExe}. ` +
        `Build it for this platform first: \`pnpm -C apps/kimi-code build:native:sea\` ` +
        `(CI builds the SEA on each platform runner before packaging).`,
    );
  }

  const stageDir = resolve(desktopRoot, 'resources-stage', 'bin', target);
  rmSync(resolve(desktopRoot, 'resources-stage'), { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  cpSync(seaDir, stageDir, { recursive: true });
  console.log(`[before-pack] staged Kimi server (${target}) -> ${stageDir}`);
};
