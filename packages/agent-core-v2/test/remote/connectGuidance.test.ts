import { describe, expect, it } from 'vitest';

import { connectWithGuidance } from '#/remote/client/connectGuidance';
import { HandshakeError } from '#/remote/client/connection';
import type { LauncherSpec } from '#/remote/client/launchers';

const SSH: LauncherSpec = { type: 'ssh', host: 'dev-box' };

function missingExecutorError(exitCode: number | null = 127): HandshakeError {
  return new HandshakeError(
    `executor process exited before the handshake completed (code ${exitCode ?? 'null'}, signal null): kimi: command not found`,
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
});
