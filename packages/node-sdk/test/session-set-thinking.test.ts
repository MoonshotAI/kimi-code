import { afterEach, describe, expect, it } from 'vitest';

import { createKimiHarness, type KimiError } from '#/index';

import { makeTempDir, removeTempDirs } from './session-runtime-helpers';
import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];

afterEach(async () => {
  await removeTempDirs(tempDirs);
});

describe('Session.setThinking', () => {
  it('applies the thinking effort through the engine', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-thinking-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-thinking-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_thinking_wire', workDir });

      // Rust semantics: `session/set_thinking` is a silent RPC applied from
      // the next turn; the contract is that it succeeds without error.
      await expect(session.setThinking('low')).resolves.toBeUndefined();
    } finally {
      await harness.close();
    }
  });

  it('rejects empty thinking efforts', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-thinking-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-thinking-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_thinking_empty', workDir });

      await expect(session.setThinking('   ')).rejects.toMatchObject({
        name: 'KimiError',
        code: 'session.thinking_empty',
      } satisfies Partial<KimiError>);
    } finally {
      await harness.close();
    }
  });

  it('rejects after the session is closed', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-thinking-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-thinking-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_thinking_closed', workDir });
      await session.close();

      await expect(session.setThinking('high')).rejects.toMatchObject({
        name: 'KimiError',
        code: 'session.closed',
      } satisfies Partial<KimiError>);
    } finally {
      await harness.close();
    }
  });
});
