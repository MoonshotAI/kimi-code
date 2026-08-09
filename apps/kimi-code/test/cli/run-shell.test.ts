import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runShell } from '#/cli/run-shell';

import { ExitCalled, captureProcessWrite, mockProcessExit } from '../helpers/process';

vi.mock('#/i18n', () => ({
  t: (key: string) => {
    const translations: Record<string, string> = {
      'tui.statusMessages.shellNoRustBinary':
        'The TypeScript TUI is retired — install the Rust binary (or set KIMI_RUST_BIN).',
    };
    return translations[key] ?? key;
  },
}));

const mocks = vi.hoisted(() => ({
  spawnSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawnSync: mocks.spawnSync,
}));

// run-shell.ts probes candidate binaries under apps/kimi-code/bin/, which only
// ships `kimi.mjs` (a JS launcher, not a candidate), so the no-binary branch
// is stable in a source checkout. Pointing KIMI_RUST_BIN at the launcher makes
// the binary-present branches deterministic without touching the build tree.
const FAKE_RUST_BIN = fileURLToPath(new URL('../../bin/kimi.mjs', import.meta.url));

describe('runShell', () => {
  const argvAtRun = [...process.argv.slice(2)];

  beforeEach(() => {
    vi.stubEnv('KIMI_RUST_BIN', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('writes the retired-TUI notice and returns when no Rust binary is discoverable', async () => {
    const stderr = captureProcessWrite('stderr');
    const exitSpy = mockProcessExit();
    try {
      await runShell({}, '1.2.3-test');

      expect(stderr.text()).toBe(
        'The TypeScript TUI is retired — install the Rust binary (or set KIMI_RUST_BIN).\n',
      );
      expect(mocks.spawnSync).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      stderr.restore();
      exitSpy.mockRestore();
    }
  });

  it('spawns the KIMI_RUST_BIN binary with the original argv and inherited stdio', async () => {
    vi.stubEnv('KIMI_RUST_BIN', FAKE_RUST_BIN);
    mocks.spawnSync.mockReturnValue({ status: 0, signal: null });
    const exitSpy = mockProcessExit();
    try {
      await expect(
        runShell({ session: undefined }, '1.2.3-test', { migrateOnly: true }),
      ).rejects.toBeInstanceOf(ExitCalled);

      expect(mocks.spawnSync).toHaveBeenCalledWith(FAKE_RUST_BIN, argvAtRun, {
        stdio: 'inherit',
      });
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('forwards a non-zero exit status from the Rust binary', async () => {
    vi.stubEnv('KIMI_RUST_BIN', FAKE_RUST_BIN);
    mocks.spawnSync.mockReturnValue({ status: 3, signal: null });
    const exitSpy = mockProcessExit();
    try {
      await expect(runShell({}, '1.2.3-test')).rejects.toBeInstanceOf(ExitCalled);
      expect(exitSpy).toHaveBeenCalledWith(3);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('kills the current process when the Rust binary dies from a signal', async () => {
    vi.stubEnv('KIMI_RUST_BIN', FAKE_RUST_BIN);
    mocks.spawnSync.mockReturnValue({ status: null, signal: 'SIGTERM' });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const exitSpy = mockProcessExit();
    try {
      // In production the kill terminates the process before the trailing
      // process.exit(1) fall-through is reachable; the exit spy absorbs it.
      await expect(runShell({}, '1.2.3-test')).rejects.toBeInstanceOf(ExitCalled);
      expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    } finally {
      killSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it('exits 1 when the Rust binary exits without a status or signal', async () => {
    vi.stubEnv('KIMI_RUST_BIN', FAKE_RUST_BIN);
    mocks.spawnSync.mockReturnValue({ status: null, signal: null });
    const exitSpy = mockProcessExit();
    try {
      await expect(runShell({}, '1.2.3-test')).rejects.toBeInstanceOf(ExitCalled);
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('fails fast when KIMI_RUST_BIN points at a missing file', async () => {
    const missing = '/definitely/not/here/kimi.exe';
    vi.stubEnv('KIMI_RUST_BIN', missing);

    await expect(runShell({}, '1.2.3-test')).rejects.toThrow(
      `KIMI_RUST_BIN is set but no such file: ${missing}`,
    );
  });
});
