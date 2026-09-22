import { describe, expect, it, vi } from 'vitest';

import { classifyHandshakeFailure, connectWithGuidance } from '#/remote/client/connectGuidance';
import { HandshakeError } from '#/remote/client/connection';
import type { LocalRunner } from '#/remote/client/executorDetect';
import type { LauncherSpec } from '#/remote/client/launchers';

const SSH: LauncherSpec = { type: 'ssh', host: 'dev-box' };
const DOCKER: LauncherSpec = { type: 'docker', container: 'myapp-dev' };
const COMMAND: LauncherSpec = {
  type: 'command',
  program: '/usr/bin/sandbox',
  args: ['ssh', 'i-1', '--', '/home/me/.kimi-code/bin/kimi', 'exec-server', '--listen', 'stdio'],
};

function missingExecutorError(exitCode: number | null = 127): HandshakeError {
  return new HandshakeError(
    `executor process exited before the handshake completed (code ${exitCode ?? 'null'}, signal null): kimi: command not found`,
    { kind: 'executor-exit', exitCode },
  );
}

function incompatibleError(): HandshakeError {
  return new HandshakeError(
    'executor version 0.0.4 is below the minimum 0.1.0; upgrade the remote executor (kimi exec-server) and retry',
    { kind: 'incompatible', executorVersion: '0.0.4', minExecutorVersion: '0.1.0' },
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
    expect(classifyHandshakeFailure(incompatibleError())).toBe('incompatible');
  });

  it('treats plain errors and kind-less handshake errors as other', () => {
    expect(classifyHandshakeFailure(new Error('boom'))).toBe('other');
    expect(classifyHandshakeFailure(new HandshakeError('initialize response must be an object'))).toBe(
      'other',
    );
  });
});

describe('connectWithGuidance', () => {
  it('returns immediately when the first attempt succeeds', async () => {
    const attempt = vi.fn(async () => 'ok');
    await expect(connectWithGuidance(attempt, { launcher: SSH })).resolves.toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('fails a missing ssh executor with static install guidance and no fabricated commands', async () => {
    const error = await connectWithGuidance(
      async () => {
        throw missingExecutorError();
      },
      { launcher: SSH },
    ).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(HandshakeError);
    const message = (error as Error).message;
    expect(message).toContain('was not found on ssh:dev-box');
    expect(message).toContain('Kimi Code release CDN');
    expect(message).toContain('executor path (~/.kimi-code/bin/kimi)');
    expect(message).toContain('Then reconnect the environment.');
    expect(message).not.toContain('curl -fL');
    expect(message).not.toContain('/tmp/kimi-install');
  });

  it('resolves a docker tilde remoteBin before detecting, and names the resolved path', async () => {
    const runner: LocalRunner = async () => ({ code: 0, signal: null, stdout: '/home/container\n', stderr: '' });
    const error = await connectWithGuidance(
      async () => {
        throw missingExecutorError(126);
      },
      { launcher: DOCKER, runner },
    ).catch((error: unknown) => error);
    const message = (error as Error).message;
    expect(message).toContain('docker:myapp-dev');
    expect(message).toContain('executor path (/home/container/.kimi-code/bin/kimi)');
  });

  it('answers a handshake timeout with timeout wording plus install guidance', async () => {
    const error = await connectWithGuidance(
      async () => {
        throw new HandshakeError('initialize timed out after 10000ms', { kind: 'timeout' });
      },
      { launcher: SSH },
    ).catch((error: unknown) => error);
    const message = (error as Error).message;
    expect(message).toContain('did not answer the handshake in time');
    expect(message).toContain('Kimi Code release CDN');
  });

  it('answers a too-old executor with upgrade guidance naming both versions', async () => {
    const error = await connectWithGuidance(
      async () => {
        throw incompatibleError();
      },
      { launcher: SSH },
    ).catch((error: unknown) => error);
    const message = (error as Error).message;
    expect(message).toContain('reports version 0.0.4, below the required minimum 0.1.0');
    expect(message).toContain('Upgrade the executor');
    expect(message).not.toContain('was not found');
  });

  it('fails a missing executor on a command environment with the invoked path', async () => {
    const error = await connectWithGuidance(
      async () => {
        throw missingExecutorError();
      },
      { launcher: COMMAND },
    ).catch((error: unknown) => error);
    const message = (error as Error).message;
    expect(message).toContain('command:/usr/bin/sandbox');
    expect(message).toContain('the absolute path your launcher command invokes');
  });

  it('rethrows unclassified failures unchanged', async () => {
    const failure = new HandshakeError('initialize response must be an object');
    await expect(
      connectWithGuidance(
        async () => {
          throw failure;
        },
        { launcher: SSH },
      ),
    ).rejects.toBe(failure);
  });
});
