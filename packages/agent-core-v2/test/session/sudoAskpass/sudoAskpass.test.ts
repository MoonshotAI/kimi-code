/**
 * `sudoAskpass` service tests — dir/socket/token lifecycle and the real
 * askpass helper roundtrip.
 *
 * Resolves the SUT by interface through a `TestInstantiationService`
 * container (real interaction kernel + password facade, stubbed context /
 * host environment / config / log) rooted at a per-test temp session dir.
 * The socket roundtrip spawns the actual generated `helper.mjs` via
 * `process.execPath`, exactly the way `helper.sh` does at runtime.
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IConfigService } from '#/app/config/config';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { ISessionInteractionService } from '#/session/interaction/interaction';
import { SessionInteractionService } from '#/session/interaction/interactionService';
import { ISessionPasswordService } from '#/session/password/password';
import { SessionPasswordService } from '#/session/password/passwordService';
import {
  ISessionContext,
  makeSessionContext,
} from '#/session/sessionContext/sessionContext';
import {
  ISessionSudoAskpassService,
  SUDO_ASKPASS_COMMAND_ENV,
  SUDO_ASKPASS_ENV,
  SUDO_ASKPASS_TOKEN_ENV,
} from '#/session/sudoAskpass/sudoAskpass';
import { SessionSudoAskpassService } from '#/session/sudoAskpass/sudoAskpassService';

import { stubLog } from '../../_base/log/stubs';

const execFileAsync = promisify(execFile);

const posixEnv: IHostEnvironment = {
  _serviceBrand: undefined,
  osKind: 'Linux',
  osArch: 'arm64',
  osVersion: 'test',
  shellPath: '/bin/bash',
  shellName: 'bash',
  pathClass: 'posix',
  homeDir: '/home/test',
  ready: Promise.resolve(),
};

const windowsEnv: IHostEnvironment = { ...posixEnv, osKind: 'Windows', pathClass: 'win32' };

function stubConfig(values: Record<string, unknown> = {}): IConfigService {
  return {
    _serviceBrand: undefined,
    get: (section: string) => values[section],
  } as unknown as IConfigService;
}

interface RunHelperResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Spawn the generated helper.mjs like helper.sh does; resolve on exit. */
function runHelper(
  helperShPath: string,
  env: Record<string, string>,
  promptArgv: readonly string[],
): Promise<RunHelperResult> {
  const helperMjs = join(dirname(helperShPath), 'helper.mjs');
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [helperMjs, ...promptArgv],
      { env, timeout: 15_000 },
      (error, stdout, stderr) => {
        if (error !== null && error.code === undefined) {
          reject(error);
          return;
        }
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

describe('SessionSudoAskpassService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let sessionDir: string;

  function setup(options: { env?: IHostEnvironment; config?: Record<string, unknown> } = {}): void {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    const ctx: ISessionContext = makeSessionContext({
      sessionId: 's',
      workspaceId: 'w',
      sessionDir,
      sessionScope: 'sessions/w/s',
      cwd: sessionDir,
    });
    ix.stub(ISessionContext, ctx);
    ix.stub(IHostEnvironment, options.env ?? posixEnv);
    ix.stub(IConfigService, stubConfig(options.config));
    ix.stub(ILogService, stubLog());
    ix.set(ISessionInteractionService, new SyncDescriptor(SessionInteractionService));
    ix.set(ISessionPasswordService, new SyncDescriptor(SessionPasswordService));
    ix.set(ISessionSudoAskpassService, new SyncDescriptor(SessionSudoAskpassService));
  }

  beforeEach(async () => {
    sessionDir = await fs.mkdtemp(join(tmpdir(), 'kimi-sudo-askpass-test-'));
  });

  afterEach(async () => {
    disposables.dispose();
    await fs.rm(sessionDir, { recursive: true, force: true });
  });

  it('returns the askpass env with the helper path, token, and command', async () => {
    setup();
    const svc = ix.get(ISessionSudoAskpassService);

    const env = await svc.envForCommand('sudo ls /root');

    expect(env).toBeDefined();
    expect(env![SUDO_ASKPASS_ENV]).toBe(join(sessionDir, 'sudo-askpass', 'helper.sh'));
    expect(env![SUDO_ASKPASS_TOKEN_ENV]).toMatch(/^[0-9a-f]{32}$/);
    expect(env![SUDO_ASKPASS_COMMAND_ENV]).toBe('sudo ls /root');
  });

  it('truncates the forwarded command to 500 chars', async () => {
    setup();
    const svc = ix.get(ISessionSudoAskpassService);

    const env = await svc.envForCommand(`sudo ${'x'.repeat(600)}`);

    expect(env![SUDO_ASKPASS_COMMAND_ENV]).toHaveLength(500);
  });

  it('creates the askpass dir with locked-down permissions on first use', async () => {
    setup();
    const svc = ix.get(ISessionSudoAskpassService);

    const env = await svc.envForCommand('sudo true');
    const dir = dirname(env![SUDO_ASKPASS_ENV]!);

    const dirStat = await fs.stat(dir);
    const shStat = await fs.stat(join(dir, 'helper.sh'));
    const mjsStat = await fs.stat(join(dir, 'helper.mjs'));
    expect(dirStat.mode & 0o777).toBe(0o700);
    expect(shStat.mode & 0o777).toBe(0o700);
    expect(mjsStat.mode & 0o777).toBe(0o600);
  });

  it('reuses one socket and token across commands', async () => {
    setup();
    const svc = ix.get(ISessionSudoAskpassService);

    const first = await svc.envForCommand('sudo a');
    const second = await svc.envForCommand('sudo b');

    expect(second![SUDO_ASKPASS_TOKEN_ENV]).toBe(first![SUDO_ASKPASS_TOKEN_ENV]);
    expect(second![SUDO_ASKPASS_ENV]).toBe(first![SUDO_ASKPASS_ENV]);
  });

  it('returns undefined on Windows', async () => {
    setup({ env: windowsEnv });
    const svc = ix.get(ISessionSudoAskpassService);

    await expect(svc.envForCommand('sudo ls')).resolves.toBeUndefined();
  });

  it('returns undefined when disabled via config', async () => {
    setup({ config: { sudoAskpass: { enabled: false } } });
    const svc = ix.get(ISessionSudoAskpassService);

    await expect(svc.envForCommand('sudo ls')).resolves.toBeUndefined();
    // No askpass dir is created when the channel is disabled.
    await expect(fs.stat(join(sessionDir, 'sudo-askpass'))).rejects.toThrow();
  });

  it('roundtrips a password through the real helper over the socket', async () => {
    setup();
    const svc = ix.get(ISessionSudoAskpassService);
    const passwords = ix.get(ISessionPasswordService);
    const env = (await svc.envForCommand('sudo cat /etc/shadow'))!;

    const helper = runHelper(env[SUDO_ASKPASS_ENV]!, env, ['[sudo] password for testuser: ']);

    // The validated connection becomes one pending password interaction.
    await vi.waitFor(
      () => {
        expect(passwords.listPending()).toHaveLength(1);
      },
      { timeout: 10_000 },
    );
    const pending = passwords.listPending()[0]!;
    expect(pending.prompt).toBe('[sudo] password for testuser: ');
    expect(pending.command).toBe('sudo cat /etc/shadow');

    passwords.resolve(pending.id!, { cancelled: false, password: 'hunter2' });

    const result = await helper;
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('hunter2\n');
  });

  it('queues concurrent helper connections as independent interactions', async () => {
    setup();
    const svc = ix.get(ISessionSudoAskpassService);
    const passwords = ix.get(ISessionPasswordService);
    const env = (await svc.envForCommand('sudo true'))!;

    const first = runHelper(env[SUDO_ASKPASS_ENV]!, env, ['first prompt']);
    const second = runHelper(env[SUDO_ASKPASS_ENV]!, env, ['second prompt']);

    await vi.waitFor(
      () => {
        expect(passwords.listPending()).toHaveLength(2);
      },
      { timeout: 10_000 },
    );
    const byPrompt = new Map(passwords.listPending().map((p) => [p.prompt, p.id!]));
    expect([...byPrompt.keys()].toSorted()).toEqual(['first prompt', 'second prompt']);
    for (const [prompt, id] of byPrompt) {
      passwords.resolve(id, { cancelled: false, password: `pw-for-${prompt}` });
    }

    const results = await Promise.all([first, second]);
    expect(results.map((r) => r.stdout).toSorted()).toEqual([
      'pw-for-first prompt\n',
      'pw-for-second prompt\n',
    ]);
  });

  it('exits the helper with code 1 when the request is cancelled', async () => {
    setup();
    const svc = ix.get(ISessionSudoAskpassService);
    const passwords = ix.get(ISessionPasswordService);
    const env = (await svc.envForCommand('sudo true'))!;

    const helper = runHelper(env[SUDO_ASKPASS_ENV]!, env, ['Password: ']);
    await vi.waitFor(
      () => {
        expect(passwords.listPending()).toHaveLength(1);
      },
      { timeout: 10_000 },
    );
    passwords.resolve(passwords.listPending()[0]!.id!, { cancelled: true });

    const result = await helper;
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
  });

  it('rejects a helper presenting the wrong token', async () => {
    setup();
    const svc = ix.get(ISessionSudoAskpassService);
    const passwords = ix.get(ISessionPasswordService);
    const env = (await svc.envForCommand('sudo true'))!;

    const result = await runHelper(env[SUDO_ASKPASS_ENV]!, { [SUDO_ASKPASS_TOKEN_ENV]: 'wrong' }, [
      'Password: ',
    ]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(passwords.listPending()).toHaveLength(0);
  });

  it('removes the askpass dir on dispose', async () => {
    setup();
    const svc = ix.get(ISessionSudoAskpassService);
    const env = (await svc.envForCommand('sudo true'))!;
    const dir = dirname(env[SUDO_ASKPASS_ENV]!);
    await fs.stat(dir);

    disposables.dispose();

    await vi.waitFor(
      async () => {
        await expect(fs.stat(dir)).rejects.toThrow();
      },
      { timeout: 10_000 },
    );
    // Re-seed the store so afterEach disposal stays balanced.
    disposables = new DisposableStore();
  });
});
