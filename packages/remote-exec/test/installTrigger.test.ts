import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { ExecutorArtifact, ExecutorArtifactLocator } from '../src/client/artifactLocator';
import { HandshakeError } from '../src/client/connection';
import {
  ExecutorInstallError,
  type LocalRunner,
  type LocalRunRequest,
} from '../src/client/executorInstaller';
import {
  classifyHandshakeFailure,
  connectWithAutoInstall,
  missingExecutorGuidance,
  upgradeExecutorGuidance,
} from '../src/client/installTrigger';
import type { LauncherSpec } from '../src/client/launchers';

const SSH: LauncherSpec = { type: 'ssh', host: 'dev-box' };
const DOCKER: LauncherSpec = { type: 'docker', container: 'myapp-dev' };
const COMMAND: LauncherSpec = {
  type: 'command',
  program: '/usr/bin/sandbox',
  args: ['ssh', 'i-1', '--', '/home/me/.kimi-code/bin/kimi', 'exec-server', '--listen', 'stdio'],
};

const BINARY_BYTES = new TextEncoder().encode('fake-kimi-sea-binary\n');
const ARTIFACT: ExecutorArtifact = {
  version: '1.2.3',
  filename: 'kimi-code-linux-x64',
  url: 'https://cdn.example.test/binaries/1.2.3/kimi-code-linux-x64',
  sha256: createHash('sha256').update(BINARY_BYTES).digest('hex'),
};

function fixedLocator(): ExecutorArtifactLocator {
  return { locate: vi.fn(async () => ARTIFACT) };
}

function goodFetch(): typeof fetch {
  return vi.fn(async () => new Response(BINARY_BYTES, { status: 200 })) as unknown as typeof fetch;
}

// Minimal ssh-capable fake remote: executor starts missing, activate installs it.
function createSshRunner(): { runner: LocalRunner; requests: LocalRunRequest[] } {
  const requests: LocalRunRequest[] = [];
  let installedVersion: string | undefined;
  const runner: LocalRunner = async (request: LocalRunRequest) => {
    requests.push(request);
    const last = request.args.at(-1) ?? '';
    if (request.program === 'ssh') {
      if (last.includes('uname -sm')) {
        return { code: 0, signal: null, stdout: 'Linux x86_64\n/home/test', stderr: '' };
      }
      if (last.endsWith('--version')) {
        return installedVersion === undefined
          ? { code: 127, signal: null, stdout: '', stderr: 'kimi: command not found' }
          : { code: 0, signal: null, stdout: `${installedVersion}\n`, stderr: '' };
      }
      if (last.startsWith('chmod 755')) {
        installedVersion = ARTIFACT.version;
        return { code: 0, signal: null, stdout: '', stderr: '' };
      }
      return { code: 0, signal: null, stdout: '', stderr: '' };
    }
    return { code: 0, signal: null, stdout: '', stderr: '' };
  };
  return { runner, requests };
}

function missingExecutorError(exitCode: number | null = 127): HandshakeError {
  return new HandshakeError(
    `executor process exited before the handshake completed (code ${exitCode ?? 'null'}, signal null): kimi: command not found`,
    { kind: 'executor-exit', exitCode },
  );
}

describe('classifyHandshakeFailure', () => {
  it('classifies executor exits by code', () => {
    expect(classifyHandshakeFailure(missingExecutorError(127))).toBe('missing');
    expect(classifyHandshakeFailure(missingExecutorError(126))).toBe('missing');
    expect(classifyHandshakeFailure(missingExecutorError(255))).toBe('other');
    expect(classifyHandshakeFailure(missingExecutorError(null))).toBe('other');
  });

  it('classifies timeouts and version gates', () => {
    expect(
      classifyHandshakeFailure(
        new HandshakeError('initialize timed out after 10000ms', { kind: 'timeout' }),
      ),
    ).toBe('timeout');
    expect(
      classifyHandshakeFailure(
        new HandshakeError('executor version 0.0.1 is below the minimum 0.1.0', {
          kind: 'incompatible',
          executorVersion: '0.0.1',
          minExecutorVersion: '0.1.0',
        }),
      ),
    ).toBe('incompatible');
  });

  it('treats plain errors and kind-less handshake errors as other', () => {
    expect(classifyHandshakeFailure(new Error('boom'))).toBe('other');
    expect(classifyHandshakeFailure(new HandshakeError('initialize response must be an object'))).toBe(
      'other',
    );
  });
});

describe('connectWithAutoInstall', () => {
  it('returns immediately when the first attempt succeeds', async () => {
    const attempt = vi.fn(async () => 'connected');
    const result = await connectWithAutoInstall(attempt, { launcher: SSH });
    expect(result).toBe('connected');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('installs once and retries the connect exactly once after a missing executor', async () => {
    const fake = createSshRunner();
    const launchers: LauncherSpec[] = [];
    const attempt = vi.fn(async (launcher: LauncherSpec) => {
      launchers.push(launcher);
      if (launchers.length === 1) throw missingExecutorError();
      return 'connected';
    });

    const result = await connectWithAutoInstall(attempt, {
      launcher: SSH,
      artifactLocator: fixedLocator(),
      fetchImpl: goodFetch(),
      runner: fake.runner,
      clientVersion: '1.2.3',
    });

    expect(result).toBe('connected');
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(launchers[0]).toEqual(SSH);
    expect(launchers[1]).toEqual({ ...SSH, remoteBin: '~/.kimi-code/bin/kimi' });
  });

  it('retries docker connects with the absolute home-based remoteBin', async () => {
    const requests: LocalRunRequest[] = [];
    let installedVersion: string | undefined;
    const runner: LocalRunner = async (request: LocalRunRequest) => {
      requests.push(request);
      const args = request.args;
      if (args.some((arg) => arg.includes('uname -sm'))) {
        return { code: 0, signal: null, stdout: 'Linux x86_64\n/root', stderr: '' };
      }
      if (args.includes('--version')) {
        return installedVersion === undefined
          ? { code: 126, signal: null, stdout: '', stderr: 'executable file not found' }
          : { code: 0, signal: null, stdout: `${installedVersion}\n`, stderr: '' };
      }
      if (args.some((arg) => arg.startsWith('chmod 755'))) {
        installedVersion = ARTIFACT.version;
      }
      return { code: 0, signal: null, stdout: '', stderr: '' };
    };
    const launchers: LauncherSpec[] = [];
    const attempt = vi.fn(async (launcher: LauncherSpec) => {
      launchers.push(launcher);
      if (launchers.length === 1) throw missingExecutorError(126);
      return 'connected';
    });

    await connectWithAutoInstall(attempt, {
      launcher: DOCKER,
      artifactLocator: fixedLocator(),
      fetchImpl: goodFetch(),
      runner,
      clientVersion: '1.2.3',
    });

    expect(attempt).toHaveBeenCalledTimes(2);
    expect(launchers[1]).toEqual({ ...DOCKER, remoteBin: '/root/.kimi-code/bin/kimi' });
  });

  it('does not retry the connect when the install fails', async () => {
    const runner: LocalRunner = async () => ({
      code: 255,
      signal: null,
      stdout: '',
      stderr: 'ssh: connect to host dev-box port 22: Connection refused',
    });
    const attempt = vi.fn(async () => {
      throw missingExecutorError();
    });

    const error = await connectWithAutoInstall(attempt, {
      launcher: SSH,
      artifactLocator: fixedLocator(),
      fetchImpl: goodFetch(),
      runner,
      clientVersion: '1.2.3',
    }).catch((error: unknown) => error);

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(HandshakeError);
    const message = (error as Error).message;
    expect(message).toContain('code 127');
    expect(message).toContain('Auto-install failed');
    expect(message).toContain('step "probe"');
    expect(message).toContain('Connection refused');
  });

  it('surfaces the guidance error when the connect still fails after a successful install', async () => {
    const fake = createSshRunner();
    const retryError = new HandshakeError('initialize timed out after 10000ms', { kind: 'timeout' });
    let calls = 0;
    const attempt = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw missingExecutorError();
      throw retryError;
    });

    const error = await connectWithAutoInstall(attempt, {
      launcher: SSH,
      artifactLocator: fixedLocator(),
      fetchImpl: goodFetch(),
      runner: fake.runner,
      clientVersion: '1.2.3',
    }).catch((error: unknown) => error);

    expect(attempt).toHaveBeenCalledTimes(2);
    expect(error).toBeInstanceOf(HandshakeError);
    expect(error).not.toBe(retryError);
    const wrapped = error as HandshakeError;
    expect(wrapped.kind).toBe('timeout');
    expect(wrapped.message).toContain('initialize timed out after 10000ms');
    expect(wrapped.message).toContain('executor 1.2.3 was installed at');
    expect(wrapped.message).toContain('reconnect still failed');
  });

  it('refuses auto-install for command environments and fails with guidance', async () => {
    const runner = vi.fn() as unknown as LocalRunner;
    const attempt = vi.fn(async () => {
      throw missingExecutorError();
    });

    const error = await connectWithAutoInstall(attempt, {
      launcher: COMMAND,
      artifactLocator: fixedLocator(),
      runner,
    }).catch((error: unknown) => error);

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(runner).not.toHaveBeenCalled();
    const message = (error as Error).message;
    expect(message).toContain('code 127');
    expect(message).toContain('Auto-install is not available for `command` environments');
    expect(message).toContain('Install the executor manually');
  });

  it('gives manual guidance for typed environments when no artifact locator is configured', async () => {
    const attempt = vi.fn(async () => {
      throw missingExecutorError();
    });
    const error = await connectWithAutoInstall(attempt, { launcher: SSH }).catch((error: unknown) => error);

    expect(attempt).toHaveBeenCalledTimes(1);
    const message = (error as Error).message;
    expect(message).toContain('no executor artifact locator');
    expect(message).toContain('scp <kimi-binary> dev-box:/tmp/kimi-install');
  });

  it('gives manual guidance when auto-install is disabled', async () => {
    const attempt = vi.fn(async () => {
      throw missingExecutorError();
    });
    const error = await connectWithAutoInstall(attempt, {
      launcher: SSH,
      artifactLocator: fixedLocator(),
      autoInstall: false,
    }).catch((error: unknown) => error);

    expect((error as Error).message).toContain('Auto-install is disabled');
  });

  it('answers a too-old executor with upgrade guidance, not an install', async () => {
    const runner = vi.fn() as unknown as LocalRunner;
    const attempt = vi.fn(async () => {
      throw new HandshakeError(
        'executor version 0.0.4 is below the minimum 0.1.0; upgrade the remote executor (kimi exec-server) and retry',
        { kind: 'incompatible', executorVersion: '0.0.4', minExecutorVersion: '0.1.0' },
      );
    });

    const error = await connectWithAutoInstall(attempt, {
      launcher: SSH,
      artifactLocator: fixedLocator(),
      runner,
    }).catch((error: unknown) => error);

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(runner).not.toHaveBeenCalled();
    const message = (error as Error).message;
    expect(message).toContain('0.0.4');
    expect(message).toContain('0.1.0');
    expect(message).toContain('Upgrade the executor');
    expect(message).not.toContain('Auto-install failed');
  });

  it('rethrows unclassified failures unchanged', async () => {
    const protocol = new HandshakeError('received a message before the initialize response');
    const attempt = vi.fn(async () => {
      throw protocol;
    });
    const error = await connectWithAutoInstall(attempt, {
      launcher: SSH,
      artifactLocator: fixedLocator(),
    }).catch((error: unknown) => error);
    expect(error).toBe(protocol);
  });
});

describe('guidance text', () => {
  it('missing-executor guidance for docker mentions docker cp and image preinstall', () => {
    const text = missingExecutorGuidance({
      launcher: DOCKER,
      failure: 'missing',
      reason: 'locator-unconfigured',
    });
    expect(text).toContain('docker cp <kimi-binary> myapp-dev:/tmp/kimi-install');
    expect(text).toContain('preinstall the executor in the image');
  });

  it('install-failed guidance carries the artifact URL when the locate succeeded', () => {
    const text = missingExecutorGuidance({
      launcher: SSH,
      failure: 'missing',
      reason: 'install-failed',
      installError: new ExecutorInstallError('upload', 'scp exited 1', { artifact: ARTIFACT }),
    });
    expect(text).toContain('step "upload"');
    expect(text).toContain(ARTIFACT.url);
    expect(text).toContain(ARTIFACT.sha256);
  });

  it('upgrade guidance names the versions and stays distinct from missing guidance', () => {
    const text = upgradeExecutorGuidance({
      launcher: SSH,
      executorVersion: '0.0.4',
      minExecutorVersion: '0.1.0',
    });
    expect(text).toContain('version 0.0.4');
    expect(text).toContain('minimum 0.1.0');
    expect(text).toContain('Upgrade the executor');
    expect(text).not.toContain('was not found');
  });
});
