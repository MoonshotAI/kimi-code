import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { LocalKaos, type Environment } from '@moonshot-ai/kaos';
import type * as KosongModule from '@moonshot-ai/kosong';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createKimiHarness, type KimiError, type Event } from '#/index';

import { makeTempDir, removeTempDirs, waitForSDKEvent } from './session-runtime-helpers';
import { TEST_IDENTITY } from './test-identity';

vi.mock('@moonshot-ai/kosong', async (importOriginal) => {
  const actual = await importOriginal<typeof KosongModule>();
  return {
    ...actual,
    createProvider: () => ({
      name: 'fake',
      modelName: 'fake-model',
      thinkingEffort: null,
      async generate(
        _systemPrompt: string,
        _tools: unknown,
        _history: unknown,
        options?: { readonly signal?: AbortSignal },
      ) {
        await waitForAbort(options?.signal);
        throwAbortError();
      },
      withThinking() {
        return this;
      },
    }),
  };
});

const tempDirs: string[] = [];

afterEach(async () => {
  await removeTempDirs(tempDirs);
});

describe('Session.cancel', () => {
  it('cancels an active streaming turn and emits turn_ended(cancelled)', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-cancel-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-cancel-work-');
    await writeFakeModelConfig(homeDir);
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_cancel_active_turn', workDir });
      const events: Event[] = [];
      const unsubscribe = session.onEvent((event) => {
        events.push(event);
      });
      const started = waitForSDKEvent(session, (event) => event.type === 'turn.started');
      const ended = waitForSDKEvent(session, (event) => event.type === 'turn.ended');

      await session.prompt('start a turn that will be cancelled');
      const startedEvent = await started;
      await session.cancel();
      const endedEvent = await ended;
      unsubscribe();

      expect(startedEvent).toMatchObject({
        type: 'turn.started',
        sessionId: session.id,
      });
      expect(endedEvent).toMatchObject({
        type: 'turn.ended',
        sessionId: session.id,
        turnId: startedEvent.type === 'turn.started' ? startedEvent.turnId : undefined,
        reason: 'cancelled',
      });
      expect(events).toContainEqual(expect.objectContaining({ type: 'turn.started' }));
      expect(events).toContainEqual(expect.objectContaining({ type: 'turn.ended' }));
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
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_fork_active_turn', workDir });
      const started = waitForSDKEvent(session, (event) => event.type === 'turn.started');
      const ended = waitForSDKEvent(session, (event) => event.type === 'turn.ended');

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

  it('forks through forkSessionWithKaos when kaos overrides are supplied', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-fork-kaos-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-fork-kaos-work-');
    await writeFakeModelConfig(homeDir);
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const source = await harness.createSession({ id: 'ses_fork_kaos_source', workDir });
      await source.setPlanMode(true);
      const sourcePlan = await source.getPlan();
      if (sourcePlan === null) throw new Error('expected source plan');
      await mkdir(dirname(sourcePlan.path), { recursive: true });
      await writeFile(sourcePlan.path, 'source plan', 'utf-8');

      const fork = await harness.forkSession({
        id: source.id,
        forkId: 'ses_fork_kaos_child',
        kaos: testLocalKaos(),
        persistenceKaos: testLocalKaos(),
      });

      expect(fork.id).toBe('ses_fork_kaos_child');
      // The source's plan file is copied into the fork's own session
      // dir through the supplied kaos pair — not aliased to the source.
      const forkPlan = await fork.getPlan();
      expect(forkPlan).toMatchObject({ content: 'source plan' });
      expect(forkPlan?.path).not.toBe(sourcePlan.path);
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

// `LocalKaos`'s constructor is `private` at the TS level only — build a
// fresh instance around a stub `osEnv` (the same bypass as agent-core's
// `test/fixtures/test-kaos.ts`) so the test stays hermetic: no host
// login-shell or environment probing.
const TEST_OS_ENV: Environment = {
  osKind: 'Linux',
  osArch: 'x86_64',
  osVersion: 'test',
  shellName: 'bash',
  shellPath: '/bin/bash',
};

type LocalKaosCtor = new (osEnv: Environment) => LocalKaos;

function testLocalKaos(): LocalKaos {
  return new (LocalKaos as unknown as LocalKaosCtor)(TEST_OS_ENV);
}

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted === true) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal?.addEventListener(
      'abort',
      () => {
        resolve();
      },
      { once: true },
    );
  });
}

function throwAbortError(): never {
  throw new DOMException('The operation was aborted.', 'AbortError');
}
