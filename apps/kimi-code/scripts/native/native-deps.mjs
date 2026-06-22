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

const keyringSubpackageByTarget = Object.freeze({
  'darwin-arm64': '@napi-rs/keyring-darwin-arm64',
  'darwin-x64': '@napi-rs/keyring-darwin-x64',
  'linux-arm64': '@napi-rs/keyring-linux-arm64-gnu',
  'linux-x64': '@napi-rs/keyring-linux-x64-gnu',
  'win32-arm64': '@napi-rs/keyring-win32-arm64-msvc',
  'win32-x64': '@napi-rs/keyring-win32-x64-msvc',
});

const koffiTripletByTarget = Object.freeze({
  'darwin-arm64': 'darwin_arm64',
  'darwin-x64': 'darwin_x64',
  'linux-arm64': 'linux_arm64',
  'linux-x64': 'linux_x64',
  'win32-arm64': 'win32_arm64',
  'win32-x64': 'win32_x64',
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
    id: 'keyring-host',
    name: () => '@napi-rs/keyring',
    collect: 'js-only',
    parent: null,
  },
  {
    id: 'keyring-target',
    name: (target) => keyringSubpackageByTarget[target],
    collect: 'native-files',
    parent: 'keyring-host',
  },
  {
    id: 'pi-tui',
    name: () => '@earendil-works/pi-tui',
    // pi-tui is bundled into main.cjs at build time — we don't collect it as
    // a native dep, only register it so koffi can declare it as parent.
    collect: 'virtual',
    parent: null,
  },
  {
    id: 'koffi',
    name: () => 'koffi',
    collect: 'js-and-native-file',
    parent: 'pi-tui',
    nativeFileRelatives: (target) => [`build/koffi/${koffiTripletByTarget[target]}/koffi.node`],
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
