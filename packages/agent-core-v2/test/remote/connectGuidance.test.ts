import { describe, expect, it } from 'vitest';

import { classifyConnectFailure, connectWithGuidance } from '#/remote/client/connectGuidance';
import { HandshakeError } from '#/remote/client/connection';
import type { LauncherSpec } from '#/remote/client/launchers';

const SSH: LauncherSpec = { type: 'ssh', host: 'dev-box' };

function missingExecutorError(exitCode: number | null = 127, detail = 'kimi: command not found'): HandshakeError {
  return new HandshakeError(
    `executor process exited before the handshake completed (code ${exitCode ?? 'null'}, signal null): ${detail}`,
    { kind: 'executor-exit', exitCode },
  );
}

describe('connectWithGuidance', () => {
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

  it('points a bare executor name at the target PATH', async () => {
    const error = await connectWithGuidance(
      async () => {
        throw missingExecutorError(9009);
      },
      { launcher: { type: 'ssh', host: 'windows-dev', remoteBin: 'kimi' } },
    ).catch((error: unknown) => error);
    const message = (error as Error).message;
    expect(message).toContain('expected at kimi');
    expect(message).toContain('install it as `kimi` on the target\'s PATH');
  });

  it('recognizes the Unix-observed low eight bits of cmd status 9009', async () => {
    const error = await connectWithGuidance(
      async () => {
        throw missingExecutorError(49, "'kimi' is not recognized as an internal or external command, operable program or batch file.");
      },
      { launcher: { type: 'ssh', host: 'windows-dev', remoteBin: 'kimi' } },
    ).catch((error: unknown) => error);
    const message = (error as Error).message;
    expect(message).toContain('was not found on ssh:windows-dev');
    expect(message).toContain('install it as `kimi` on the target\'s PATH');
  });

  it('does not classify an unrelated status 49 as a missing executor', async () => {
    const error = await connectWithGuidance(
      async () => {
        throw missingExecutorError(49, 'executor initialization failed');
      },
      { launcher: { type: 'ssh', host: 'windows-dev', remoteBin: 'kimi' } },
    ).catch((error: unknown) => error);
    expect((error as Error).message).not.toContain('Install the executor manually');
  });

  it('points a command launcher at the remoteBin it appends', async () => {
    const error = await connectWithGuidance(
      async () => {
        throw missingExecutorError();
      },
      { launcher: { type: 'command', program: 'kubectl', args: ['exec', '-i', 'dev-pod', '--'], remoteBin: '/root/.kimi-code/bin/kimi' } },
    ).catch((error: unknown) => error);
    const message = (error as Error).message;
    expect(message).toContain('was not found on command:kubectl (expected at /root/.kimi-code/bin/kimi)');
    expect(message).toContain('executor path (/root/.kimi-code/bin/kimi)');
  });

  it('points a command launcher that invokes exec-server itself at its own command', async () => {
    const error = await connectWithGuidance(
      async () => {
        throw missingExecutorError();
      },
      { launcher: { type: 'command', program: 'sandbox', args: ['ssh', 'i-1', '--', '/opt/kimi', 'exec-server'] } },
    ).catch((error: unknown) => error);
    const message = (error as Error).message;
    expect(message).toContain('was not found on command:sandbox.');
    expect(message).toContain('the absolute path your launcher command invokes');
  });
});

describe('classifyConnectFailure', () => {
  it.each([
    ['SSH platform probe failed: ssh: Could not resolve hostname dev-box: nodename nor servname provided, or not known', 'executor-exit', 'host_not_found'],
    ['SSH platform probe failed: ssh: connect to host dev-box port 22: Connection refused', 'executor-exit', 'connection_refused'],
    ['SSH platform probe failed: ssh: connect to host dev-box port 22: No route to host', 'executor-exit', 'host_unreachable'],
    ['SSH platform probe failed: ssh: connect to host dev-box port 22: Operation timed out', 'executor-exit', 'connect_timeout'],
    ['SSH platform probe failed: me@dev-box: Permission denied (publickey).', 'executor-exit', 'authentication_failed'],
    ['SSH platform probe failed: @@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.', 'executor-exit', 'host_key_changed'],
    ['executor process exited before the handshake completed (code 1, signal null): Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?', 'executor-exit', 'docker_unavailable'],
    ['executor process exited before the handshake completed (code 1, signal null): Error response from daemon: No such container: dev', 'executor-exit', 'container_not_found'],
    ['executor process exited before the handshake completed (code 1, signal null): Error response from daemon: container 3f2a is not running', 'executor-exit', 'container_not_running'],
    ['initialize timed out after 10000ms; executor stderr: ssh: connect to host dev-box port 22: Connection refused', 'timeout', 'connection_refused'],
    ['initialize timed out after 10000ms', 'timeout', 'executor_timeout'],
  ] as const)('classifies %s', (message, kind, expected) => {
    expect(classifyConnectFailure(new HandshakeError(message, { kind, exitCode: kind === 'executor-exit' ? 255 : undefined }))).toBe(expected);
  });

  it('separates a missing executor, an outdated executor, and a stalled SSH connection', () => {
    expect(classifyConnectFailure(missingExecutorError())).toBe('executor_not_found');
    expect(classifyConnectFailure(new HandshakeError('executor 0.1.0 is too old', { kind: 'incompatible' }))).toBe('executor_outdated');
    expect(classifyConnectFailure(new HandshakeError('SSH platform probe timed out after 10000ms', { kind: 'transport-timeout' }))).toBe('connect_timeout');
    expect(classifyConnectFailure(new Error('launcher command "ssh" was not found on PATH'))).toBe('launcher_not_found');
    expect(classifyConnectFailure(new HandshakeError('executor process exited before the handshake completed (code 3, signal null)', { kind: 'executor-exit', exitCode: 3 }))).toBe('unknown');
  });

  it('does not suggest installing the executor when the SSH connection itself stalls', async () => {
    const stalled = new HandshakeError('SSH platform probe timed out after 10000ms', { kind: 'transport-timeout' });
    const error = await connectWithGuidance(
      async () => {
        throw stalled;
      },
      { launcher: SSH },
    ).catch((error: unknown) => error);
    expect(error).toBe(stalled);
  });
});
