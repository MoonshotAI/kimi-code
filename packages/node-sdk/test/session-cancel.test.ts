import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createKimiHarness, type KimiError, type Event } from '#/index';

import { makeTempDir, removeTempDirs, waitForSDKEvent } from './session-runtime-helpers';
import { TEST_IDENTITY } from './test-identity';

// Rust semantics: engine turns run against a host-proxy `llmStep`. A hanging
// step keeps the turn active until cancelled.
const HANGING_LLM: (req: unknown) => Promise<unknown> = () => new Promise(() => {});

const tempDirs: string[] = [];

afterEach(async () => {
  await removeTempDirs(tempDirs);
});

describe('Session.cancel', () => {
  it('cancels an active streaming turn and emits session.turn.ended(Aborted)', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-cancel-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-cancel-work-');
    await writeFakeModelConfig(homeDir);
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY, llmStep: HANGING_LLM });

    try {
      const session = await harness.createSession({ id: 'ses_cancel_active_turn', workDir });
      const events: Event[] = [];
      const unsubscribe = session.onEvent((event) => {
        events.push(event);
      });
      const started = waitForSDKEvent(session, (event) => event.type === 'session.turn.started');
      const ended = waitForSDKEvent(session, (event) => event.type === 'session.turn.ended');

      await session.prompt('start a turn that will be cancelled');
      const startedEvent = await started;
      await session.cancel();
      const endedEvent = await ended;
      unsubscribe();

      expect(startedEvent).toMatchObject({
        type: 'session.turn.started',
        sessionId: session.id,
      });
      expect(endedEvent).toMatchObject({
        type: 'session.turn.ended',
        sessionId: session.id,
        turn_id: startedEvent.type === 'session.turn.started' ? startedEvent.turn_id : undefined,
        stop_reason: 'Aborted',
      });
      expect(events).toContainEqual(expect.objectContaining({ type: 'session.turn.started' }));
      expect(events).toContainEqual(expect.objectContaining({ type: 'session.turn.ended' }));
    } finally {
      await harness.close();
    }
  });

  it('rejects manual compaction on an empty session with compaction.unable', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-cancel-compact-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-cancel-compact-work-');
    await writeFakeModelConfig(homeDir);
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_cancel_compaction', workDir });

      await expect(session.compact({ instruction: 'Keep the compact test pending.' })).rejects.toMatchObject({
        name: 'KimiError',
        code: 'compaction.unable',
      } satisfies Partial<KimiError>);
    } finally {
      await harness.close();
    }
  });

  it('rejects after the session is closed', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-cancel-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-cancel-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_cancel_closed', workDir });
      await session.close();

      await expect(session.cancel()).rejects.toMatchObject({
        name: 'KimiError',
        code: 'session.closed',
      } satisfies Partial<KimiError>);
      await expect(session.cancelCompaction()).rejects.toMatchObject({
        name: 'KimiError',
        code: 'session.closed',
      } satisfies Partial<KimiError>);
    } finally {
      await harness.close();
    }
  });
});

describe('KimiHarness.forkSession', () => {
  it('rejects while the source session has an active turn', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-fork-active-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-fork-active-work-');
    await writeFakeModelConfig(homeDir);
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY, llmStep: HANGING_LLM });

    try {
      const session = await harness.createSession({ id: 'ses_fork_active_turn', workDir });
      const started = waitForSDKEvent(session, (event) => event.type === 'session.turn.started');
      const ended = waitForSDKEvent(session, (event) => event.type === 'session.turn.ended');

      await session.prompt('keep this turn active');
      await started;
      try {
        await expect(
          harness.forkSession({
            id: session.id,
            forkId: 'ses_fork_active_child',
          }),
        ).rejects.toMatchObject({
          name: 'KimiError',
          code: 'session.fork_active_turn',
        } satisfies Partial<KimiError>);
      } finally {
        await session.cancel().catch(() => undefined);
        await ended.catch(() => undefined);
      }
    } finally {
      await harness.close();
    }
  });
});

async function writeFakeModelConfig(homeDir: string): Promise<void> {
  await writeFile(
    join(homeDir, 'config.toml'),
    `
default_model = "fake-model"

[providers.local]
type = "kimi"
base_url = "https://example.test/v1"
api_key = "sk-test"

[models.fake-model]
provider = "local"
model = "fake-model"
max_context_size = 1000
`,
    'utf-8',
  );
}

