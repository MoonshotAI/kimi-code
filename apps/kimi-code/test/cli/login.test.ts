/**
 * `kimi login`
 *
 * Verifies that the login sub-command is registered on the program and
 * that the action drives `harness.auth.login`, prints the device code to
 * stderr, and exits with the right code on success / failure.
 */

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockLogin = vi.fn();

vi.mock('@moonshot-ai/kimi-code-sdk', async () => {
  const actual = await vi.importActual<typeof import('@moonshot-ai/kimi-code-sdk')>(
    '@moonshot-ai/kimi-code-sdk',
  );
  return {
    ...actual,
    createKimiHarness: vi.fn(() => ({
      auth: {
        login: mockLogin,
      },
    })),
  };
});

vi.mock('#/utils/open-url', () => ({ openUrl: vi.fn() }));

import { createKimiHarness } from '@moonshot-ai/kimi-code-sdk';

import { registerLoginCommand } from '#/cli/sub/login';
import { openUrl } from '#/utils/open-url';

class ExitCalled extends Error {
  constructor(public code: number | string | null | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

describe('kimi login', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockLogin.mockReset();
    vi.mocked(openUrl).mockReset();
    vi.mocked(createKimiHarness).mockClear();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number | string | null) => {
      throw new ExitCalled(code);
    }) as never);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('registers a `login` subcommand on the program', () => {
    const program = new Command('kimi');
    registerLoginCommand(program);

    const login = program.commands.find((c) => c.name() === 'login');
    expect(login).toBeDefined();
    expect(login?.description()).toMatch(/[Aa]uthenticat/);
  });

  it('invokes harness.auth.login and exits 0 on success', async () => {
    mockLogin.mockResolvedValue({ providerName: 'kimi-code', ok: true });

    const program = new Command('kimi').exitOverride();
    registerLoginCommand(program);

    await expect(program.parseAsync(['node', 'kimi', 'login'])).rejects.toThrow(ExitCalled);

    expect(mockLogin).toHaveBeenCalledTimes(1);
    expect(mockLogin).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        onDeviceCode: expect.any(Function),
      }),
    );
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('prints device code prompt to stderr', async () => {
    mockLogin.mockImplementation(
      async (
        _providerName: string | undefined,
        options: {
          onDeviceCode?: (data: {
            userCode: string;
            verificationUri: string;
            verificationUriComplete: string;
            expiresIn: number | null;
          }) => void | Promise<void>;
        },
      ) => {
        await options.onDeviceCode?.({
          userCode: 'ABCD-EFGH',
          verificationUri: 'https://example.com/v',
          verificationUriComplete: 'https://example.com/v?code=ABCD-EFGH',
          expiresIn: 600,
        });
        return { providerName: 'kimi-code', ok: true };
      },
    );

    const program = new Command('kimi').exitOverride();
    registerLoginCommand(program);

    await expect(program.parseAsync(['node', 'kimi', 'login'])).rejects.toThrow(ExitCalled);

    const writtenChunks = stderrSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(writtenChunks.some((chunk: string) => chunk.includes('ABCD-EFGH'))).toBe(true);
    expect(writtenChunks.some((chunk: string) => chunk.includes('https://example.com/v'))).toBe(
      true,
    );
    expect(openUrl).toHaveBeenCalledWith('https://example.com/v?code=ABCD-EFGH');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('still prints device code prompt when opening the browser fails', async () => {
    vi.mocked(openUrl).mockImplementation(() => {
      throw new Error('no browser');
    });
    mockLogin.mockImplementation(
      async (
        _providerName: string | undefined,
        options: {
          onDeviceCode?: (data: {
            userCode: string;
            verificationUri: string;
            verificationUriComplete: string;
            expiresIn: number | null;
          }) => void | Promise<void>;
        },
      ) => {
        await options.onDeviceCode?.({
          userCode: 'ABCD-EFGH',
          verificationUri: 'https://example.com/v',
          verificationUriComplete: 'https://example.com/v?code=ABCD-EFGH',
          expiresIn: 600,
        });
        return { providerName: 'kimi-code', ok: true };
      },
    );

    const program = new Command('kimi').exitOverride();
    registerLoginCommand(program);

    await expect(program.parseAsync(['node', 'kimi', 'login'])).rejects.toThrow(ExitCalled);

    const writtenChunks = stderrSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(writtenChunks.some((chunk: string) => chunk.includes('ABCD-EFGH'))).toBe(true);
    expect(writtenChunks.some((chunk: string) => chunk.includes('https://example.com/v'))).toBe(
      true,
    );
    expect(openUrl).toHaveBeenCalledWith('https://example.com/v?code=ABCD-EFGH');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('exits 1 when auth.login throws', async () => {
    mockLogin.mockRejectedValue(new Error('boom'));

    const program = new Command('kimi').exitOverride();
    registerLoginCommand(program);

    await expect(program.parseAsync(['node', 'kimi', 'login'])).rejects.toThrow(ExitCalled);

    const writtenChunks = stderrSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(writtenChunks.some((chunk: string) => chunk.includes('boom'))).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
