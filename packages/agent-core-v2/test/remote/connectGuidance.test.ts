import { describe, expect, it } from 'vitest';

import { connectWithGuidance } from '#/remote/client/connectGuidance';
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
