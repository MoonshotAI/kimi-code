import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { delimiter, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '../../src/logging/types';
import type { PasswordRequest, PasswordResult } from '../../src/rpc/sdk-api';
import { SudoAskpassManager, sudoAskpassDir } from '../../src/sudo-askpass';
import { BashTool } from '../../src/tools/builtin/shell/bash';
import { createBackgroundManager } from '../agent/background/helpers';
import { testKaos } from '../fixtures/test-kaos';
import { executeTool } from '../tools/fixtures/execute-tool';

const tempDirs: string[] = [];

function makeTempDir(): string {
  // Deliberately short base path: the askpass unix socket must fit the
  // 104-byte sun_path limit, and the default os.tmpdir() on macOS
  // (/var/folders/…, realpath /private/var/…) already pushes past it.
  const dir = mkdtempSync(join('/tmp', 'sap-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

interface ManagerFixture {
  manager: SudoAskpassManager;
  sessionDir: string;
  requests: PasswordRequest[];
  log: { [K in 'error' | 'warn' | 'info' | 'debug']: ReturnType<typeof vi.fn> };
  respond: (result: PasswordResult) => void;
}

function createManager(
  sessionDir: string,
  options: { enabled?: boolean; withHandler?: boolean } = {},
): ManagerFixture {
  const requests: PasswordRequest[] = [];
  let result: PasswordResult = { kind: 'submitted', password: 'hunter2' };
  const log = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  };
  const manager = new SudoAskpassManager({
    sessionDir,
    enabled: options.enabled ?? true,
    requestPassword:
      options.withHandler === false
        ? undefined
        : async (request) => {
            requests.push(request);
            return result;
          },
    log: log as unknown as Logger,
  });
  return {
    manager,
    sessionDir,
    requests,
    log,
    respond: (next) => {
      result = next;
    },
  };
}

interface HelperRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runHelper(
  helperPath: string,
  prompt: string,
  env: Record<string, string>,
): Promise<HelperRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(helperPath, [prompt], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });
  });
}

describe('SudoAskpassManager', () => {
  it.skipIf(process.platform === 'win32')('injects askpass env vars and truncates the command to 500 chars', async () => {
    const fixture = createManager(makeTempDir());
    const env = await fixture.manager.envFor('x'.repeat(600));
    expect(env).toBeDefined();
    expect(env?.['SUDO_ASKPASS']).toBe(join(sudoAskpassDir(fixture.sessionDir), 'helper.sh'));
    expect(env?.['KIMI_SUDO_ASKPASS_TOKEN']).toMatch(/^[0-9a-f]{32}$/);
    expect(env?.['KIMI_SUDO_ASKPASS_COMMAND']).toHaveLength(500);
    await fixture.manager.dispose();
  });

  it.skipIf(process.platform === 'win32')('round-trips a password through the socket to a real spawned helper', async () => {
    const fixture = createManager(makeTempDir());
    const env = await fixture.manager.envFor('sudo ls /root');
    expect(env).toBeDefined();

    const run = await runHelper(env!['SUDO_ASKPASS']!, '[sudo] password for alice:', {
      ...process.env,
      KIMI_SUDO_ASKPASS_COMMAND: env!['KIMI_SUDO_ASKPASS_COMMAND']!,
    } as Record<string, string>);

    expect(run.exitCode, `stderr: ${run.stderr}`).toBe(0);
    expect(run.stdout).toBe('hunter2\n');
    expect(fixture.requests).toEqual([
      { prompt: '[sudo] password for alice:', command: 'sudo ls /root' },
    ]);
    await fixture.manager.dispose();
  });
  it.skipIf(process.platform === 'win32')('rejects requests with a wrong token', async () => {
    const fixture = createManager(makeTempDir());
    const env = await fixture.manager.envFor('sudo true');
    expect(env).toBeDefined();
    const dir = sudoAskpassDir(fixture.sessionDir);

    const reply = await new Promise<string>((resolve, reject) => {
      const socket = new Socket();
      let buffer = '';
      socket.on('error', reject);
      socket.connect(join(dir, 'askpass.sock'), () => {
        socket.write(`${JSON.stringify({ token: '0'.repeat(32), prompt: 'x' })}\n`);
      });
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        if (buffer.includes('\n')) {
          socket.end();
          resolve(buffer.trim());
        }
      });
    });

    expect(JSON.parse(reply)).toEqual({ cancelled: true });
    expect(fixture.requests).toHaveLength(0);
    await fixture.manager.dispose();
  });

  it.skipIf(process.platform === 'win32')('makes the helper exit 1 when the user cancels', async () => {
    const fixture = createManager(makeTempDir());
    fixture.respond({ kind: 'cancelled' });
    const env = await fixture.manager.envFor('sudo true');
    expect(env).toBeDefined();

    const run = await runHelper(env!['SUDO_ASKPASS']!, '[sudo] password for alice:', {
      ...process.env,
    } as Record<string, string>);

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe('');
    await fixture.manager.dispose();
  });

  it.skipIf(process.platform === 'win32')('never logs the password during a round-trip', async () => {
    const fixture = createManager(makeTempDir());
    const env = await fixture.manager.envFor('sudo true');
    await runHelper(env!['SUDO_ASKPASS']!, '[sudo] password for alice:', {
      ...process.env,
    } as Record<string, string>);

    const logged = [fixture.log.error, fixture.log.warn, fixture.log.info, fixture.log.debug]
      .flatMap((fn) => fn.mock.calls)
      .map((call) => JSON.stringify(call));
    for (const entry of logged) {
      expect(entry).not.toContain('hunter2');
    }
    await fixture.manager.dispose();
  });

  it('returns no env when disabled or when no handler is registered', async () => {
    const disabled = createManager(makeTempDir(), { enabled: false });
    await expect(disabled.manager.envFor('sudo true')).resolves.toBeUndefined();

    const noHandler = createManager(makeTempDir(), { withHandler: false });
    await expect(noHandler.manager.envFor('sudo true')).resolves.toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('removes the askpass dir on dispose', async () => {
    const sessionDir = makeTempDir();
    const fixture = createManager(sessionDir);
    await fixture.manager.envFor('sudo true');
    expect(existsSync(sudoAskpassDir(sessionDir))).toBe(true);

    await fixture.manager.dispose();
    expect(existsSync(sudoAskpassDir(sessionDir))).toBe(false);
    await expect(fixture.manager.envFor('sudo true')).resolves.toBeUndefined();
  });
});

describe('BashTool with a fake sudo', () => {
  function installFakeSudo(binDir: string): void {
    const script = [
      '#!/bin/sh',
      '# Fake sudo for tests: mimics sudo 1.9, which only consults SUDO_ASKPASS',
      '# in askpass mode (-A) — proving the manager\'s bin/sudo PATH shim works.',
      'if [ "$1" != "-A" ]; then',
      '  echo "sudo: a terminal is required to read the password" >&2',
      '  exit 1',
      'fi',
      'shift',
      'password=$("$SUDO_ASKPASS" "[sudo] password for alice:") || exit 1',
      'if [ "$password" != "hunter2" ]; then',
      '  echo "sudo: sorry, try again." >&2',
      '  exit 1',
      'fi',
      'exec "$@"',
      '',
    ].join('\n');
    const path = join(binDir, 'sudo');
    writeFileSync(path, script);
    chmodSync(path, 0o755);
  }

  async function runSudoCommand(
    manager: SudoAskpassManager,
    binDir: string,
  ): Promise<{ isError: boolean; output: string }> {
    const tool = new BashTool(testKaos, '/tmp', createBackgroundManager().manager, {
      sudoAskpass: manager,
    });
    const previousPath = process.env['PATH'];
    process.env['PATH'] = `${binDir}:${previousPath ?? ''}`;
    try {
      const result = await executeTool(tool, {
        turnId: '0',
        toolCallId: 'tc_sudo',
        args: { command: 'sudo echo askpass-ok', timeout: 60 },
        signal: new AbortController().signal,
      });
      return {
        isError: result.isError === true,
        output:
          typeof result.output === 'string' ? result.output : JSON.stringify(result.output),
      };
    } finally {
      if (previousPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = previousPath;
    }
  }

  it.skipIf(process.platform === 'win32')('succeeds when the password handler submits the right password', async () => {
    const fixture = createManager(makeTempDir());
    const binDir = makeTempDir();
    installFakeSudo(binDir);

    const result = await runSudoCommand(fixture.manager, binDir);

    expect(result.isError, `output: ${result.output}`).toBe(false);
    expect(result.output).toContain('askpass-ok');
    // The tool result must not leak the password.
    expect(result.output).not.toContain('hunter2');
    await fixture.manager.dispose();
  });

  it.skipIf(process.platform === 'win32')('fails the command when the user cancels the password prompt', async () => {
    const fixture = createManager(makeTempDir());
    fixture.respond({ kind: 'cancelled' });
    const binDir = makeTempDir();
    installFakeSudo(binDir);

    const result = await runSudoCommand(fixture.manager, binDir);

    expect(result.isError).toBe(true);
    expect(result.output).not.toContain('hunter2');
    await fixture.manager.dispose();
  });
});

describe('BashTool with real sudo (smoke)', () => {
  // Real sudo (1.9+) only consults SUDO_ASKPASS in askpass mode; this proves
  // the manager's bin/sudo PATH shim makes real sudo invoke the helper at
  // all. The handler always cancels, so no real credentials are involved —
  // the helper exits 1 and sudo fails before any authentication attempt.
  const realSudoAvailable = (process.env['PATH'] ?? '')
    .split(delimiter)
    .some((entry) => entry !== '' && existsSync(join(entry, 'sudo')));

  async function runRealSudo(
    fixture: ManagerFixture,
    command: string,
  ): Promise<{ isError: boolean; output: string }> {
    const tool = new BashTool(testKaos, '/tmp', createBackgroundManager().manager, {
      sudoAskpass: fixture.manager,
    });
    const result = await executeTool(tool, {
      turnId: '0',
      toolCallId: 'tc_real_sudo',
      args: { command, timeout: 60 },
      signal: new AbortController().signal,
    });
    return {
      isError: result.isError === true,
      output: typeof result.output === 'string' ? result.output : JSON.stringify(result.output),
    };
  }

  it.skipIf(process.platform === 'win32' || !realSudoAvailable)(
    'real sudo invokes the askpass helper through the shim',
    async () => {
      const fixture = createManager(makeTempDir());
      fixture.respond({ kind: 'cancelled' });

      const result = await runRealSudo(fixture, 'sudo -k -p SMOKETEST-PROMPT true');

      expect(fixture.requests).toHaveLength(1);
      expect(fixture.requests[0]?.prompt).toContain('SMOKETEST-PROMPT');
      expect(result.isError).toBe(true);
      await fixture.manager.dispose();
    },
  );

  it.skipIf(process.platform === 'win32' || !realSudoAvailable)(
    'sudo -n stays non-interactive and never prompts',
    async () => {
      const fixture = createManager(makeTempDir());

      const result = await runRealSudo(fixture, 'sudo -k -n true');

      expect(fixture.requests).toHaveLength(0);
      expect(result.isError).toBe(true);
      await fixture.manager.dispose();
    },
  );

  it.skipIf(process.platform === 'win32' || !realSudoAvailable)(
    'an explicit -A from the caller is harmless',
    async () => {
      const fixture = createManager(makeTempDir());
      fixture.respond({ kind: 'cancelled' });

      const result = await runRealSudo(fixture, 'sudo -A -k -p SMOKETEST-PROMPT true');

      expect(fixture.requests).toHaveLength(1);
      expect(result.isError).toBe(true);
      await fixture.manager.dispose();
    },
  );

  it.skipIf(process.platform === 'win32' || !realSudoAvailable)(
    'sudo -S is not forced into askpass mode (sudo rejects -A with -S)',
    async () => {
      const fixture = createManager(makeTempDir());

      const result = await runRealSudo(fixture, 'sudo -k -S true');

      expect(fixture.requests).toHaveLength(0);
      expect(result.isError).toBe(true);
      expect(result.output).not.toContain('may not be used together');
      await fixture.manager.dispose();
    },
  );
});
