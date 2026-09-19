/**
 * Native dependency registry.
 *
 * Each entry describes one native-bearing npm package: how to resolve its
 * install root, what to collect (JS only / native binary only / both), and
 * which other registered dep it nests under (for `pnpm`-style nested resolves).
 *
 * Adding a new native package = appending one object here. No edits to
 * NATIVE_TARGETS table or resolvePackageRoot if/else chain.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const SUPPORTED_TARGETS = Object.freeze([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-arm64',
  'win32-x64',
]);

const clipboardSubpackageByTarget = Object.freeze({
  'darwin-arm64': '@mariozechner/clipboard-darwin-arm64',
  'darwin-x64': '@mariozechner/clipboard-darwin-x64',
  'linux-arm64': '@mariozechner/clipboard-linux-arm64-gnu',
  'linux-x64': '@mariozechner/clipboard-linux-x64-gnu',
  'win32-arm64': '@mariozechner/clipboard-win32-arm64-msvc',
  'win32-x64': '@mariozechner/clipboard-win32-x64-msvc',
});

// pi-tui ships platform-specific native helpers:
// - darwin: clipboard + Shift-modifier detection for Terminal.app Shift+Enter
// - linux: X11 clipboard
// - win32: clipboard + enable ENABLE_VIRTUAL_TERMINAL_INPUT so Shift+Tab is distinguishable
const piTuiNativeFileByTarget = Object.freeze({
  'darwin-arm64': ['native/darwin/prebuilds/darwin-arm64/darwin-platform.node'],
  'darwin-x64': ['native/darwin/prebuilds/darwin-x64/darwin-platform.node'],
  'linux-arm64': ['native/linux/prebuilds/linux-arm64/linux-platform-x11.node'],
  'linux-x64': ['native/linux/prebuilds/linux-x64/linux-platform-x11.node'],
  'win32-arm64': ['native/win32/prebuilds/win32-arm64/win32-platform.node'],
  'win32-x64': ['native/win32/prebuilds/win32-x64/win32-platform.node'],
});

// node-pty ships prebuilds for darwin/win32 only; on Linux the binding is
// source-built into build/Release at install time (each linux target builds
// on its native CI runner, so the arch always matches the target). The
// spawn-helper executable is a macOS-only gyp target — Linux forks the pty
// directly. The two win32 lib/*.js entries are spawned by path (child fork /
// Worker), so the static require-follower cannot see them.
function nodePtyNativeFileByTarget(target) {
  if (target === 'linux-arm64' || target === 'linux-x64') {
    return ['build/Release/pty.node'];
  }
  if (target === 'darwin-arm64' || target === 'darwin-x64') {
    return [`prebuilds/${target}/pty.node`, `prebuilds/${target}/spawn-helper`];
  }
  return [
    `prebuilds/${target}/pty.node`,
    `prebuilds/${target}/conpty.node`,
    `prebuilds/${target}/conpty_console_list.node`,
    `prebuilds/${target}/winpty.dll`,
    `prebuilds/${target}/winpty-agent.exe`,
    `prebuilds/${target}/conpty/conpty.dll`,
    `prebuilds/${target}/conpty/OpenConsole.exe`,
    'lib/conpty_console_list_agent.js',
    'lib/worker/conoutSocketWorker.js',
  ];
}

async function ensureNodePtyNativeBuild({ packageRoot, target }) {
  if (!target.startsWith('linux-')) return;
  const bindingPath = join(packageRoot, 'build', 'Release', 'pty.node');
  if (existsSync(bindingPath)) return;
  const host = `${process.platform}-${process.arch}`;
  if (host !== target) {
    throw new Error(
      `node-pty ships no Linux prebuilds and ${bindingPath} is missing; the ${target} binding ` +
        `cannot be source-built on ${host}. Run this build on a native ${target} runner.`,
    );
  }
  console.log(`node-pty: source-building the Linux binding at ${packageRoot} (node-gyp rebuild)...`);
  try {
    await execFileAsync('npm', ['run', 'install', '--prefix', packageRoot], {
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const detail = [error.stdout?.trim(), error.stderr?.trim(), error.message]
      .filter(Boolean)
      .join('\n');
    throw new Error(`node-pty source build failed at ${packageRoot}:\n${detail}`);
  }
  if (!existsSync(bindingPath)) {
    throw new Error(`node-pty install script did not produce ${bindingPath}`);
  }
}

export function isSupportedTarget(target) {
  return SUPPORTED_TARGETS.includes(target);
}

/**
 * @typedef {Object} NativeDepDescriptor
 * @property {string} id                — stable internal id used for parent refs
 * @property {(target: string) => string} name
 *           — npm package name (may depend on target)
 * @property {'js-only'|'native-files'|'js-and-native-file'|'native-file-only'|'virtual'} collect
 * @property {string|null} parent
 *           — id of another registered dep this nests under (for pnpm),
 *           or null for top-level (resolvable from app root)
 * @property {(target: string) => string[]} [nativeFileRelatives]
 *           — explicit list of files relative to package root that the static
 *           require-follower cannot see (native binaries, helper executables,
 *           scripts spawned by path). Used by 'js-and-native-file' and
 *           'native-file-only'; native-files mode auto-scans *.node.
 *           'native-file-only' collects package.json + these files but skips
 *           the package entry JS.
 * @property {(ctx: { packageRoot: string, target: string }) => Promise<void>} [ensureNativeBuild]
 *           — optional hook run after the package root resolves and before
 *           files are collected, for packages whose binding must be
 *           source-built on the build host (no prebuilt artifacts).
 */

/** @type {readonly NativeDepDescriptor[]} */
export const nativeDeps = Object.freeze([
  {
    id: 'clipboard-host',
    name: () => '@mariozechner/clipboard',
    collect: 'js-only',
    parent: null,
  },
  {
    id: 'clipboard-target',
    name: (target) => clipboardSubpackageByTarget[target],
    collect: 'native-files',
    parent: 'clipboard-host',
  },
  {
    id: 'pi-tui',
    name: () => '@moonshot-ai/pi-tui',
    // pi-tui's JS is bundled into main.cjs, so only the platform-specific
    // native helper (.node under native/) ships alongside the binary — its
    // dist/ JS is intentionally NOT collected (it stays in the bundle). This
    // keeps the SEA native-asset payload small.
    collect: 'native-file-only',
    parent: null,
    nativeFileRelatives: (target) => piTuiNativeFileByTarget[target] ?? [],
  },
  {
    id: 'node-pty',
    name: () => 'node-pty',
    // The whole package ships: its JS does a runtime-concatenated require of
    // the .node binding (unbundleable), so the SEA externalizes it and loads
    // the extracted copy through the native-module hook.
    collect: 'js-and-native-file',
    parent: null,
    nativeFileRelatives: (target) => nodePtyNativeFileByTarget(target),
    ensureNativeBuild: ensureNodePtyNativeBuild,
  },
]);

/**
 * Resolve which deps need collecting for a given build target, with concrete names.
 */
export function resolveTargetDeps(target) {
  if (!isSupportedTarget(target)) {
    throw new Error(`Unsupported native asset target: ${target}`);
  }
  return nativeDeps
    .filter((d) => d.collect !== 'virtual')
    .map((d) => ({
      ...d,
      resolvedName: d.name(target),
      nativeFileRelatives: d.nativeFileRelatives?.(target) ?? [],
      parentName: d.parent ? nativeDeps.find((p) => p.id === d.parent)?.name(target) ?? null : null,
    }));
}
