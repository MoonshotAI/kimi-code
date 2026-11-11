import { describe, expect, it } from 'vitest';

import {
  nativeDeps,
  resolveTargetDeps,
  isSupportedTarget,
  SUPPORTED_TARGETS,
} from '../../../scripts/native/native-deps.mjs';

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
    expect(names).toContain('@moonshot-ai/pi-tui');
    expect(names).toContain('better-sqlite3');
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

  it('encodes native file paths per target', () => {
    const linuxPiTui = resolveTargetDeps('linux-arm64').find(
      (d) => d.resolvedName === '@moonshot-ai/pi-tui',
    );
    expect(linuxPiTui?.nativeFileRelatives).toEqual([
      'native/linux/prebuilds/linux-arm64/linux-platform-x11.node',
    ]);
    const macPiTui = resolveTargetDeps('darwin-x64').find(
      (d) => d.resolvedName === '@moonshot-ai/pi-tui',
    );
    expect(macPiTui?.nativeFileRelatives).toEqual([
      'native/darwin/prebuilds/darwin-x64/darwin-platform.node',
    ]);
    const winArmPiTui = resolveTargetDeps('win32-arm64').find(
      (d) => d.resolvedName === '@moonshot-ai/pi-tui',
    );
    expect(winArmPiTui?.nativeFileRelatives).toEqual([
      'native/win32/prebuilds/win32-arm64/win32-platform.node',
    ]);
    for (const target of SUPPORTED_TARGETS) {
      const sqlite = resolveTargetDeps(target).find((d) => d.resolvedName === 'better-sqlite3');
      expect(sqlite?.nativeFileRelatives).toEqual([`prebuilds/${target}.node`]);
    }
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

  it('has native-file-only entries with no parent', () => {
    for (const id of ['pi-tui', 'better-sqlite3']) {
      const dep = nativeDeps.find((d) => d.id === id);
      expect(dep?.collect).toBe('native-file-only');
      expect(dep?.parent).toBe(null);
    }
  });
});
