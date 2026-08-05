/**
 * `kimi acp`
 *
 * Verifies that the ACP sub-command is registered on the program and
 * that the action wires the harness into `@moonshot-ai/acp-adapter`'s
 * `runAcpServer` (the real server is stubbed so the test doesn't
 * actually take over stdio).
 */

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runAcpServer } from '@moonshot-ai/acp-adapter';

import { runLoginFlow } from '#/cli/sub/login-flow';
import { registerAcpCommand } from '#/cli/sub/acp';

vi.mock('@moonshot-ai/acp-adapter', () => ({
  ACP_BUILTIN_SLASH_COMMANDS: [],
  runAcpServer: vi.fn(async () => undefined),
}));
vi.mock('#/cli/sub/login-flow', () => ({ runLoginFlow: vi.fn(async () => undefined) }));

class ExitCalled extends Error {
  constructor(public code: number | string | null | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

describe('kimi acp', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv('KIMI_CODE_LEGACY_FLAG', '1');
    vi.mocked(runAcpServer).mockClear();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number | string | null) => {
      throw new ExitCalled(code);
    }) as never);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it('registers an `acp` subcommand on the program', () => {
    const program = new Command('kimi');
    registerAcpCommand(program);

    const acp = program.commands.find((c) => c.name() === 'acp');
    expect(acp).toBeDefined();
    expect(acp?.description()).toMatch(/Agent Client Protocol/);
  });

  it('invokes runAcpServer with a constructed harness and exits 0 on success', async () => {
    const program = new Command('kimi').exitOverride();
    registerAcpCommand(program);

    await expect(program.parseAsync(['node', 'kimi', 'acp'])).rejects.toThrow(ExitCalled);

    expect(runAcpServer).toHaveBeenCalledTimes(1);
    const harnessArg = vi.mocked(runAcpServer).mock.calls[0]?.[0];
    expect(harnessArg).toBeDefined();
    const optsArg = vi.mocked(runAcpServer).mock.calls[0]?.[1];
    expect(optsArg).toEqual(
      expect.objectContaining({
        agentInfo: { name: 'Kimi Code CLI', version: expect.any(String) },
      }),
    );
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('forwards KIMI_CODE_HOME to terminalAuthEnv when set', async () => {
    const previous = process.env['KIMI_CODE_HOME'];
    process.env['KIMI_CODE_HOME'] = '/tmp/kimi-debug';
    try {
      const program = new Command('kimi').exitOverride();
      registerAcpCommand(program);

      await expect(program.parseAsync(['node', 'kimi', 'acp'])).rejects.toThrow(ExitCalled);

      const optsArg = vi.mocked(runAcpServer).mock.calls[0]?.[1];
      expect(optsArg).toEqual(
        expect.objectContaining({
          terminalAuthEnv: { KIMI_CODE_HOME: '/tmp/kimi-debug' },
        }),
      );
    } finally {
      if (previous === undefined) {
        delete process.env['KIMI_CODE_HOME'];
      } else {
        process.env['KIMI_CODE_HOME'] = previous;
      }
    }
  });

  it('omits terminalAuthEnv when KIMI_CODE_HOME is unset', async () => {
    const previous = process.env['KIMI_CODE_HOME'];
    delete process.env['KIMI_CODE_HOME'];
    try {
      const program = new Command('kimi').exitOverride();
      registerAcpCommand(program);

      await expect(program.parseAsync(['node', 'kimi', 'acp'])).rejects.toThrow(ExitCalled);

      const optsArg = vi.mocked(runAcpServer).mock.calls[0]?.[1] as {
        terminalAuthEnv?: unknown;
      };
      expect(optsArg.terminalAuthEnv).toBeUndefined();
    } finally {
      if (previous !== undefined) {
        process.env['KIMI_CODE_HOME'] = previous;
      }
    }
  });

  it('forwards process.argv[1] as terminalAuthLegacyCommand', async () => {
    const program = new Command('kimi').exitOverride();
    registerAcpCommand(program);

    await expect(program.parseAsync(['node', 'kimi', 'acp'])).rejects.toThrow(ExitCalled);

    const optsArg = vi.mocked(runAcpServer).mock.calls[0]?.[1] as {
      terminalAuthLegacyCommand?: string;
    };
    // process.argv[1] points at the test runner entry — non-empty
    // absolute-ish path, exactly what we want forwarded.
    expect(typeof optsArg.terminalAuthLegacyCommand).toBe('string');
    expect((optsArg.terminalAuthLegacyCommand ?? '').length).toBeGreaterThan(0);
    expect(optsArg.terminalAuthLegacyCommand).toBe(process.argv[1]);
  });

  it('exits without starting the ACP server when --login is passed', async () => {
    const program = new Command('kimi').exitOverride();
    registerAcpCommand(program);

    await expect(program.parseAsync(['node', 'kimi', 'acp', '--login'])).resolves.toBe(program);

    expect(runLoginFlow).toHaveBeenCalledOnce();
    expect(runAcpServer).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
