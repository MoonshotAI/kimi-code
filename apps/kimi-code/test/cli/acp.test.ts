/**
 * `kimi acp`
 *
 * Verifies that the ACP sub-command is registered on the program and
 * that the action forwards to the platform Rust binary (the Rust `kimi
 * acp` serves the protocol over stdio). The spawn is stubbed so the test
 * doesn't actually take over stdio.
 */

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLogin } = vi.hoisted(() => ({
  mockLogin: vi.fn(async () => ({ providerName: 'kimi-code', ok: true })),
}));

vi.mock('#/cli/sub/login-local', () => ({
  managedKimiLogin: mockLogin,
  kimiAuthStatus: vi.fn(async () => ({ providers: [] })),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: vi.fn() };
});

const { mockFindRustBinary } = vi.hoisted(() => ({
  mockFindRustBinary: vi.fn(),
}));

vi.mock('#/cli/run-shell', () => ({
  findRustBinary: mockFindRustBinary,
}));

import { spawnSync } from 'node:child_process';

import { registerAcpCommand } from '#/cli/sub/acp';

class ExitCalled extends Error {
  constructor(public code: number | string | null | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

describe('kimi acp', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockLogin.mockClear();
    mockFindRustBinary.mockClear();
    vi.mocked(spawnSync).mockClear();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number | string | null) => {
      throw new ExitCalled(code);
    }) as never);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('registers an `acp` subcommand on the program', () => {
    const program = new Command('kimi');
    registerAcpCommand(program);

    const acp = program.commands.find((c) => c.name() === 'acp');
    expect(acp).toBeDefined();
    expect(acp?.description()).toMatch(/ACP|Agent Client Protocol/);
  });

  it('forwards to the Rust binary with the original argv and mirrors its exit code', async () => {
    mockFindRustBinary.mockReturnValue('C:\\kimi\\kimi.exe');
    vi.mocked(spawnSync).mockReturnValue({ status: 0, signal: null } as never);
    const program = new Command('kimi').exitOverride();
    registerAcpCommand(program);

    await expect(program.parseAsync(['node', 'kimi', 'acp'])).rejects.toThrow(ExitCalled);

    expect(spawnSync).toHaveBeenCalledTimes(1);
    const [bin, args] = vi.mocked(spawnSync).mock.calls[0] ?? [];
    expect(bin).toBe('C:\\kimi\\kimi.exe');
    // The forwarder replays the real process argv (the Rust CLI parses the
    // ACP flags itself); in the test runner that is vitest's own argv.
    expect(args).toEqual(process.argv.slice(2));
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('exits 1 when no Rust binary is discoverable', async () => {
    mockFindRustBinary.mockReturnValue(null);
    const program = new Command('kimi').exitOverride();
    registerAcpCommand(program);

    await expect(program.parseAsync(['node', 'kimi', 'acp'])).rejects.toThrow(ExitCalled);
    expect(spawnSync).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits without forwarding when --login is passed', async () => {
    // `managedKimiLogin` (stubbed at module level) resolves immediately and
    // triggers exit 0 — the device flow never hits a real OAuth endpoint.
    const program = new Command('kimi').exitOverride();
    registerAcpCommand(program);

    await expect(program.parseAsync(['node', 'kimi', 'acp', '--login'])).rejects.toThrow(
      ExitCalled,
    );

    expect(mockLogin).toHaveBeenCalledTimes(1);
    expect(spawnSync).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
