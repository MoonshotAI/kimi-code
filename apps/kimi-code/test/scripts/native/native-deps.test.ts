import { describe, expect, it } from 'vitest';

import {
  nativeDeps,
  resolveExecutableFileRelatives,
  resolveTargetDeps,
  isSupportedTarget,
  SUPPORTED_TARGETS,
} from '../../../scripts/native/native-deps.mjs';
import { resolveExecutableNativeFiles } from '../../../scripts/native/assets.mjs';
import { appRoot } from '../../../scripts/native/paths.mjs';

describe('SUPPORTED_TARGETS', () => {
  it('contains the six published targets', () => {
    expect([...SUPPORTED_TARGETS].toSorted()).toEqual(
      [
        'darwin-arm64',
        'darwin-x64',
        'linux-arm64',
        'linux-x64',
        'win32-arm64',
        'win32-x64',
      ].toSorted(),
    );
  });
});

describe('isSupportedTarget', () => {
  it('accepts every supported target', () => {
    for (const t of SUPPORTED_TARGETS) {
      expect(isSupportedTarget(t)).toBe(true);
    }
  });

  it('rejects unknown targets', () => {
    expect(isSupportedTarget('linux-x64-musl')).toBe(false);
    expect(isSupportedTarget('darwin-arm')).toBe(false);
  });
});

describe('resolveTargetDeps', () => {
  it('returns one descriptor per package for darwin-arm64', () => {
    const deps = resolveTargetDeps('darwin-arm64');
    const names = deps.map((d) => d.resolvedName);
    expect(names).toContain('@mariozechner/clipboard');
    expect(names).toContain('@mariozechner/clipboard-darwin-arm64');
    expect(names).not.toContain('@earendil-works/pi-tui');
  });

  it('picks the right clipboard subpackage per target', () => {
    expect(
      resolveTargetDeps('linux-x64').map((d) => d.resolvedName),
    ).toContain('@mariozechner/clipboard-linux-x64-gnu');
    expect(
      resolveTargetDeps('win32-x64').map((d) => d.resolvedName),
    ).toContain('@mariozechner/clipboard-win32-x64-msvc');
    expect(
      resolveTargetDeps('win32-arm64').map((d) => d.resolvedName),
    ).toContain('@mariozechner/clipboard-win32-arm64-msvc');
  });

  it('throws on unsupported target', () => {
    expect(() => resolveTargetDeps('linux-x64-musl')).toThrow(/unsupported/i);
  });
});

describe('nativeDeps registry shape', () => {
  it('has clipboard host (collect=js-only)', () => {
    const host = nativeDeps.find((d) => d.id === 'clipboard-host');
    expect(host?.collect).toBe('js-only');
  });

  it('has clipboard-target (collect=native-files, parent=clipboard-host)', () => {
    const target = nativeDeps.find((d) => d.id === 'clipboard-target');
    expect(target?.collect).toBe('native-files');
    expect(target?.parent).toBe('clipboard-host');
  });

  it('keeps pi-tui as an executable helper dependency', () => {
    const piTui = nativeDeps.find((d) => d.id === 'pi-tui');
    expect(piTui?.collect).toBe('virtual');
    expect(piTui?.executableFileRelatives?.('darwin-arm64')).toEqual([
      'native/darwin/prebuilds/darwin-arm64/darwin-modifiers.node',
    ]);
    expect(piTui?.executableFileRelatives?.('win32-x64')).toEqual([
      'native/win32/prebuilds/win32-x64/win32-console-mode.node',
    ]);
    expect(piTui?.executableFileRelatives?.('linux-x64')).toEqual([]);
    expect(resolveExecutableFileRelatives('darwin-x64')).toEqual([
      'native/darwin/prebuilds/darwin-x64/darwin-modifiers.node',
    ]);
  });

  it('resolves pi-tui helper files copied next to the executable', () => {
    expect(resolveExecutableNativeFiles({ appRoot, target: 'darwin-arm64' })).toEqual([
      expect.objectContaining({
        packageName: '@earendil-works/pi-tui',
        relativePath: 'native/darwin/prebuilds/darwin-arm64/darwin-modifiers.node',
      }),
    ]);
    expect(resolveExecutableNativeFiles({ appRoot, target: 'linux-x64' })).toEqual([]);
  });
});
