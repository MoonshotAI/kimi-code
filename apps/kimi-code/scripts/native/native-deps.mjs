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

const piTuiNativeFileByTarget = Object.freeze({
  'darwin-arm64': ['native/darwin/prebuilds/darwin-arm64/darwin-platform.node'],
  'darwin-x64': ['native/darwin/prebuilds/darwin-x64/darwin-platform.node'],
  'linux-arm64': ['native/linux/prebuilds/linux-arm64/linux-platform-x11.node'],
  'linux-x64': ['native/linux/prebuilds/linux-x64/linux-platform-x11.node'],
  'win32-arm64': ['native/win32/prebuilds/win32-arm64/win32-platform.node'],
  'win32-x64': ['native/win32/prebuilds/win32-x64/win32-platform.node'],
});

export function isSupportedTarget(target) {
  return SUPPORTED_TARGETS.includes(target);
}

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
    collect: 'native-file-only',
    parent: null,
    nativeFileRelatives: (target) => piTuiNativeFileByTarget[target] ?? [],
  },
]);

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
