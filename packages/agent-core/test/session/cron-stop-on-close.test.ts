import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { testKaos } from '../fixtures/test-kaos';
import type { SDKSessionRPC } from '../../src/rpc';
import { Session } from '../../src/session';

const OS_ENV = {
  osKind: 'Linux',
  osArch: 'arm64',
  osVersion: 'test',
  shellPath: '/bin/bash',
  shellName: 'bash',
} as const;

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  }
});

describe('Session.close stops cron', () => {
  it('stops each agent cron scheduler on close', async () => {
    const { sessionDir, workDir } = await sessionFixture();
    const session = new Session({
      kaos: testKaos.withCwd(workDir),
      id: 'session-cron-stop',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
    });
    const main = await session.createMain();
    const stopSpy = vi.spyOn(main.cron!, 'stop');

    await session.close();

    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it('observably tears down cron side effects (SIGUSR1 listener cleared)', async () => {
    // The spy-only test above proves `stop()` was called but would
    // still pass if `stop()` no-op'd. Gate manual-tick mode so the
    // CronManager binds a real SIGUSR1 listener, then assert the
    // listener count returns to its pre-construction baseline after
    // `session.close()`. Anything short of `unbindSigusr1` running
    // would leak a listener.
    if (process.platform === 'win32') return;
    vi.stubEnv('KIMI_CRON_MANUAL_TICK', '1');

    const before = process.listenerCount('SIGUSR1');
    const { sessionDir, workDir } = await sessionFixture();
    const session = new Session({
      kaos: testKaos.withCwd(workDir),
      id: 'session-cron-stop-sigusr1',
      homedir: sessionDir,
      rpc: createSessionRpc(),
      skills: { explicitDirs: [join(workDir, 'missing-skills')] },
    });
    await session.createMain();
    expect(process.listenerCount('SIGUSR1')).toBe(before + 1);

    await session.close();
    expect(process.listenerCount('SIGUSR1')).toBe(before);
  });
});

async function sessionFixture(): Promise<{
  readonly sessionDir: string;
  readonly workDir: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-session-cron-stop-'));
  tempDirs.push(dir);
  const workDir = join(dir, 'work');
  const sessionDir = join(dir, 'session');
  return { sessionDir, workDir };
}

function createSessionRpc(): SDKSessionRPC {
  return {
    emitEvent: vi.fn(async () => {}),
    requestApproval: vi.fn(async () => ({ decision: 'cancelled' })),
    requestQuestion: vi.fn(async () => null),
    toolCall: vi.fn(async () => ({
      output: 'custom tools are not supported in this test',
      isError: true,
    })),
  } as SDKSessionRPC;
}
