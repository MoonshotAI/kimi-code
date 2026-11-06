import { describe, expect, it } from 'vitest';

import { classifyConnectFailure, classifyTransportStderr, connectWithGuidance } from '#/remote/client/connectGuidance';
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
    ['ssh: Could not resolve hostname dev-box: nodename nor servname provided, or not known', 'ssh', 'host_not_found'],
    ['ssh: connect to host dev-box port 22: Connection refused', 'ssh', 'connection_refused'],
    ['ssh: connect to host dev-box port 22: No route to host', 'ssh', 'host_unreachable'],
    ['ssh: connect to host dev-box port 22: Operation timed out', 'ssh', 'connect_timeout'],
    ['me@dev-box: Permission denied (publickey).', 'ssh', 'authentication_failed'],
    ['@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.', 'ssh', 'host_key_changed'],
    ['Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?', 'docker', 'docker_unavailable'],
    ['Error response from daemon: No such container: dev', 'docker', 'container_not_found'],
    ['Error response from daemon: container 3f2a is not running', 'docker', 'container_not_running'],
    ['dial unix:///var/run/docker.sock: connect: connection refused', 'docker', 'connection_refused'],
  ] as const)('classifies %s from the producing process', (stderr, source, expected) => {
    expect(classifyTransportStderr(stderr, source)).toBe(expected);
    expect(classifyConnectFailure(new HandshakeError(stderr, { kind: 'executor-exit', failure: expected }))).toBe(expected);
  });

  it('tries both transport tables for a custom command and keeps SSH and Docker phrases apart', () => {
    const refused = 'dial unix:///var/run/docker.sock: connect: connection refused';
    expect(classifyTransportStderr(refused, 'ssh')).toBe('connection_refused');
    expect(classifyTransportStderr(refused, 'docker')).toBe('connection_refused');
    expect(classifyTransportStderr('Error response from daemon: No such container: dev', 'command')).toBe('container_not_found');
    expect(classifyTransportStderr('ssh: Could not resolve hostname dev-box: Name or service not known', 'command')).toBe('host_not_found');
    expect(classifyTransportStderr('Error: get failed: container no-such-container not found', 'ssh')).toBeUndefined();
    expect(classifyConnectFailure(new Error('pods "dev" not found'), 'command')).toBe('unknown');
  });

  it('keeps the failure recorded at the throw site instead of rescanning the message', () => {
    const recorded = new HandshakeError('ssh: connect to host dev-box port 22: Connection refused', {
      kind: 'timeout',
      failure: 'executor_timeout',
    });
    expect(classifyConnectFailure(recorded, 'ssh')).toBe('executor_timeout');
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

describe('classifyConnectFailure for launchers without a shell', () => {
  const exited = (detail: string, exitCode = 1) => new HandshakeError(
    `executor process exited before the handshake completed (code ${exitCode}, signal null): ${detail}`,
    { kind: 'executor-exit', exitCode },
  );

  it.each([
    ['Apple Container', 'Error: failed to find target executable /no/such/kimi'],
    ['kubectl and OCI runtimes', 'OCI runtime exec failed: exec failed: unable to start container process: exec: "kimi": executable file not found in $PATH'],
    ['bash', 'bash: line 1: kimi: command not found'],
    ['sh', 'sh: 1: kimi: not found'],
  ])('reports a missing executor from %s even with a generic exit code', (_name, detail) => {
    expect(classifyConnectFailure(exited(detail))).toBe('executor_not_found');
  });

  it('names a missing container from runtimes that do not say no such container', () => {
    expect(classifyConnectFailure(exited('Error: get failed: container no-such-container not found'), 'command')).toBe('container_not_found');
  });

  it('does not mistake a missing kubernetes resource for a missing executor', () => {
    expect(classifyConnectFailure(exited('Error from server (NotFound): pods "dev" not found'))).toBe('unknown');
  });

  it('adds install guidance to a missing executor reported with a generic exit code', async () => {
    const error = await connectWithGuidance(
      async () => {
        throw exited('Error: failed to find target executable /no/such/kimi');
      },
      { launcher: { type: 'command', program: 'container', args: ['exec', '-i', 'box'], remoteBin: '/no/such/kimi' } },
    ).catch((error: unknown) => error);
    expect((error as Error).message).toContain('was not found on command:container');
  });
});

