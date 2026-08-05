/**
 * `kimi login`
 *
 * Verifies that the login sub-command opens the login-only TUI, which reuses
 * the interactive `/login` platform selector.
 */

import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runShell } from '#/cli/run-shell';
import { registerLoginCommand } from '#/cli/sub/login';

vi.mock('#/cli/run-shell', () => ({ runShell: vi.fn(async () => undefined) }));

describe('kimi login', () => {
  beforeEach(() => {
    vi.mocked(runShell).mockClear();
  });

  it('registers a `login` subcommand on the program', () => {
    const program = new Command('kimi');
    registerLoginCommand(program);

    const login = program.commands.find((command) => command.name() === 'login');
    expect(login).toBeDefined();
    expect(login?.description()).toContain('Kimi Platform API key');
  });

  it('opens the login-only shell with neutral chat options', async () => {
    const program = new Command('kimi').exitOverride();
    registerLoginCommand(program);

    await expect(program.parseAsync(['node', 'kimi', 'login'])).resolves.toBe(program);

    expect(runShell).toHaveBeenCalledOnce();
    expect(runShell).toHaveBeenCalledWith(
      {
        session: undefined,
        continue: false,
        yolo: false,
        auto: false,
        plan: false,
        model: undefined,
        outputFormat: undefined,
        prompt: undefined,
        skillsDirs: [],
        agent: undefined,
        agentFiles: [],
      },
      expect.any(String),
      { loginOnly: true },
    );
  });
});
