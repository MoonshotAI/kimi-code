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

const piTuiExecutableFilesByTarget = Object.freeze({
  'darwin-arm64': ['native/darwin/prebuilds/darwin-arm64/darwin-modifiers.node'],
  'darwin-x64': ['native/darwin/prebuilds/darwin-x64/darwin-modifiers.node'],
  'win32-arm64': ['native/win32/prebuilds/win32-arm64/win32-console-mode.node'],
  'win32-x64': ['native/win32/prebuilds/win32-x64/win32-console-mode.node'],
});

export function isSupportedTarget(target) {
  return SUPPORTED_TARGETS.includes(target);
}

/**
 * @typedef {Object} NativeDepDescriptor
 * @property {string} id                — stable internal id used for parent refs
 * @property {(target: string) => string} name
 *           — npm package name (may depend on target)
 * @property {'js-only'|'native-files'|'js-and-native-file'|'virtual'} collect
 * @property {string|null} parent
 *           — id of another registered dep this nests under (for pnpm),
 *           or null for top-level (resolvable from app root)
 * @property {(target: string) => string[]} [nativeFileRelatives]
 *           — explicit list of .node files relative to package root
 *           (used by 'js-and-native-file'; native-files mode auto-scans *.node)
 * @property {(target: string) => string[]} [executableFileRelatives]
 *           — files copied next to the native executable, preserving the
 *           package-relative path
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
    name: () => '@earendil-works/pi-tui',
    // pi-tui is bundled into main.cjs. Its native helpers are loaded from
    // native/... beside the executable instead of from the native asset cache.
    collect: 'virtual',
    parent: null,
    executableFileRelatives: (target) => piTuiExecutableFilesByTarget[target] ?? [],
  },
]);

export function resolveExecutableFileRelatives(target) {
  if (!isSupportedTarget(target)) {
    throw new Error(`Unsupported native executable target: ${target}`);
  }
  return nativeDeps.flatMap((d) => d.executableFileRelatives?.(target) ?? []);
}

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
