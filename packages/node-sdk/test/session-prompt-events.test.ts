/**
 * Scenario: prompt-driven session behavior, including historical-turn forks.
 * Responsibilities: public SDK events, persisted replay, metadata, and input errors.
 * Wiring: real in-process core/storage with only the remote model provider stubbed.
 * Run: pnpm exec vitest run packages/node-sdk/test/session-prompt-events.test.ts
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { KIMI_CODE_PLATFORM } from '@moonshot-ai/kimi-code-oauth';
import type * as KosongModule from '@moonshot-ai/kosong';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createKimiHarness, type Event, type KimiHarness } from '#/index';

import { TEST_IDENTITY } from './test-identity';

const fakeProviderState = vi.hoisted(() => ({
  calls: [] as Array<{
    readonly systemPrompt: string;
    readonly history: unknown;
  }>,
  providerConfigs: [] as unknown[],
  responseText: 'hello from fake provider',
}));

vi.mock('@moonshot-ai/kosong', async (importOriginal) => {
  const actual = await importOriginal<typeof KosongModule>();
  return {
    ...actual,
    createProvider: (config: unknown) => {
      fakeProviderState.providerConfigs.push(config);
      return {
        name: 'fake',
        modelName: 'fake-model',
        thinkingEffort: null,
        async generate(systemPrompt: string, _tools: unknown, history: unknown) {
          fakeProviderState.calls.push({ systemPrompt, history });
          return {
            id: 'fake-response',
            usage: {
              inputOther: 0,
              output: 1,
              inputCacheRead: 0,
              inputCacheCreation: 0,
            },
            finishReason: 'completed',
            rawFinishReason: 'stop',
            async *[Symbol.asyncIterator]() {
              yield { type: 'text', text: fakeProviderState.responseText };
            },
          };
        },
        withThinking() {
          return this;
        },
      };
    },
  };
});

const tempDirs: string[] = [];

beforeEach(() => {
  fakeProviderState.calls.length = 0;
  fakeProviderState.providerConfigs.length = 0;
  fakeProviderState.responseText = 'hello from fake provider';
});

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await removeTempDir(dir);
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-sdk-prompt-'));
  tempDirs.push(dir);
  return dir;
}

async function removeTempDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOTEMPTY' && code !== 'EBUSY' && code !== 'EPERM') {
        throw error;
      }
      await delay(10);
    }
  }

  await rm(dir, { recursive: true, force: true });
}

describe('Session.prompt events', () => {
  it('preserves existing custom metadata when an SDK metadata patch is resumed', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });

    try {
      await configureFakeProvider(harness);
      const session = await harness.createSession({
        id: 'ses_update_metadata',
        workDir,
        metadata: { source: 'vscode' },
      });
      await session.createGoal({ objective: 'Keep core-owned metadata' });
      await session.updateMetadata({
        vscode_legacy_approval: { yolo: true, afk: false },
      });
      await session.close();

      const resumed = await harness.resumeSession({ id: session.id });

      expect(resumed.summary?.metadata).toEqual({
        source: 'vscode',
        vscode_legacy_approval: { yolo: true, afk: false },
      });
      await expect(resumed.getGoal()).resolves.toMatchObject({
        goal: { objective: 'Keep core-owned metadata' },
      });
    } finally {
      await harness.close();
    }
  });

  it('persists sanitized prompt metadata without marking the title custom', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      await configureFakeProvider(harness);
      const session = await harness.createSession({ id: 'ses_prompt_meta', workDir });
      const events: Event[] = [];
      const unsubscribe = session.onEvent((event) => {
        events.push(event);
      });

      let done = waitForEvent(session, (event) => event.type === 'turn.ended');
      await session.prompt('use api_key=secret-value for the request');
      await done;

      const statePath = join(session.summary!.sessionDir, 'state.json');
      const firstState = JSON.parse(await readFile(statePath, 'utf-8')) as Record<string, unknown>;
      expect(firstState['title']).toBe('use api_key=[redacted] for the request');
      expect(firstState['isCustomTitle']).toBe(false);
      expect(firstState['lastPrompt']).toBe('use api_key=[redacted] for the request');
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'session.meta.updated',
          title: 'use api_key=[redacted] for the request',
          patch: expect.objectContaining({
            isCustomTitle: false,
            lastPrompt: 'use api_key=[redacted] for the request',
          }),
        }),
      );

      events.length = 0;
      done = waitForEvent(session, (event) => event.type === 'turn.ended');
      await session.prompt('second prompt');
      await done;

      const secondState = JSON.parse(await readFile(statePath, 'utf-8')) as Record<string, unknown>;
      expect(secondState['title']).toBe('use api_key=[redacted] for the request');
      expect(secondState['isCustomTitle']).toBe(false);
      expect(secondState['lastPrompt']).toBe('second prompt');
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'session.meta.updated',
          patch: expect.objectContaining({
            lastPrompt: 'second prompt',
          }),
        }),
      );

      events.length = 0;
      done = waitForEvent(session, (event) => event.type === 'turn.ended');
      await session.prompt([{ type: 'image_url', imageUrl: { url: 'https://example.com/a.png' } }]);
      await done;
      unsubscribe();

      const mediaState = JSON.parse(await readFile(statePath, 'utf-8')) as Record<string, unknown>;
      expect(mediaState['title']).toBe('use api_key=[redacted] for the request');
      expect(mediaState['lastPrompt']).toBe('[image]');
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'session.meta.updated',
          patch: expect.objectContaining({
            lastPrompt: '[image]',
          }),
        }),
      );
    } finally {
      await harness.close();
    }
  });

  it('emits mapped turn events through Session.onEvent', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      await configureFakeProvider(harness);
      const session = await harness.createSession({ id: 'ses_prompt_events', workDir });
      const events: Event[] = [];
      const done = waitForEvent(session, (event) => event.type === 'turn.ended');
      const unsubscribe = session.onEvent((event) => {
        events.push(event);
      });

      await session.prompt('hello');
      await done;
      unsubscribe();

      expect(events.some((event) => event.type === 'turn.started')).toBe(true);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'assistant.delta',
          sessionId: session.id,
          turnId: 0,
          delta: 'hello from fake provider',
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'turn.ended',
          sessionId: session.id,
          turnId: 0,
          reason: 'completed',
        }),
      );
      expect(fakeProviderState.calls[0]?.systemPrompt).toContain('You are Kimi Code CLI');
      expect(fakeProviderState.calls[0]?.systemPrompt).toContain('Available skills');
      expect(fakeProviderState.providerConfigs[0]).toMatchObject({
        type: 'kimi',
        defaultHeaders: expect.objectContaining({
          'X-Msh-Platform': KIMI_CODE_PLATFORM,
          'User-Agent': 'kimi-code-cli/0.0.0-test',
        }),
      });
      expect(existsSync(join(homeDir, 'device_id'))).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it('supports onEvent unsubscribe without touching runtime wire directly', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      await configureFakeProvider(harness);
      const session = await harness.createSession({ id: 'ses_prompt_unsubscribe', workDir });
      const unsubscribedEvents: Event[] = [];
      const unsubscribe = session.onEvent((event) => {
        unsubscribedEvents.push(event);
      });
      unsubscribe();
      const done = waitForEvent(session, (event) => event.type === 'turn.ended');

      await session.prompt([{ type: 'text', text: 'hello' }]);
      await done;

      expect(unsubscribedEvents).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('runs init through generateAgentsMd RPC as a subagent system trigger without prompt metadata updates', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      await configureFakeProvider(harness);
      const session = await harness.createSession({ id: 'ses_init_rpc', workDir });
      const events: Event[] = [];
      const unsubscribe = session.onEvent((event) => {
        events.push(event);
      });

      await session.init();
      unsubscribe();

      const spawned = events.find((event) => event.type === 'subagent.spawned');
      expect(spawned).toMatchObject({
        type: 'subagent.spawned',
        sessionId: session.id,
        agentId: 'main',
        subagentName: 'coder',
        parentToolCallId: 'generate-agents-md',
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'turn.started',
          sessionId: session.id,
          agentId: spawned?.type === 'subagent.spawned' ? spawned.subagentId : undefined,
          origin: { kind: 'system_trigger', name: 'subagent' },
        }),
      );
      expect(events).not.toContainEqual(
        expect.objectContaining({
          type: 'session.meta.updated',
        }),
      );
      expect(fakeProviderState.calls[0]?.history).toMatchObject([
        {
          role: 'user',
          content: [
            expect.objectContaining({
              text: expect.stringContaining('Task requirements:'),
            }),
          ],
        },
      ]);

      const statePath = join(session.summary!.sessionDir, 'state.json');
      const state = JSON.parse(await readFile(statePath, 'utf-8')) as Record<string, unknown>;
      expect(state['lastPrompt']).toBeUndefined();
    } finally {
      await harness.close();
    }
  });

  it('includes persisted subagent replay only when resume explicitly requests it', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });

    try {
      await configureFakeProvider(harness);
      const session = await harness.createSession({ id: 'ses_subagent_replay', workDir });
      const events: Event[] = [];
      const unsubscribe = session.onEvent((event) => events.push(event));
      await session.init();
      unsubscribe();
      const spawned = events.find((event) => event.type === 'subagent.spawned');
      if (spawned?.type !== 'subagent.spawned') throw new Error('Expected persisted subagent');
      await session.close();

      const defaultResume = await harness.resumeSession({ id: session.id });
      expect(defaultResume.getResumeState()?.agents).not.toHaveProperty(spawned.subagentId);
      await defaultResume.close();

      const fullResume = await harness.resumeSession({
        id: session.id,
        includeSubagents: true,
      });
      expect(fullResume.getResumeState()?.agents[spawned.subagentId]?.replay).toContainEqual(
        expect.objectContaining({
          type: 'message',
          message: expect.objectContaining({ role: 'assistant' }),
        }),
      );
    } finally {
      await harness.close();
    }
  });

  it('starts btw through RPC as a forked subagent without prompt metadata updates', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      await configureFakeProvider(harness);
      const session = await harness.createSession({ id: 'ses_btw_rpc', workDir });
      const events: Event[] = [];
      const unsubscribe = session.onEvent((event) => {
        events.push(event);
      });

      let done = waitForEvent(session, (event) => event.type === 'turn.ended');
      await session.prompt('main task context');
      await done;

      fakeProviderState.responseText = 'The main agent is working from the existing context.';
      events.length = 0;
      done = waitForEvent(
        session,
        (event) => event.type === 'turn.ended' && event.agentId !== 'main',
      );

      const agentId = await session.startBtw();
      await harness.withInteractiveAgent(agentId, () =>
        session.prompt('What are you working on right now?'),
      );
      await done;
      unsubscribe();
      expect(harness.interactiveAgentId).toBe('main');

      const started = events.find(
        (event) =>
          event.type === 'turn.started' &&
          event.agentId === agentId &&
          event.origin.kind === 'user',
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'turn.started',
          sessionId: session.id,
          agentId,
          origin: { kind: 'user' },
        }),
      );
      expect(started?.agentId).not.toBe('main');
      expect(events).not.toContainEqual(expect.objectContaining({ type: 'subagent.spawned' }));
      expect(events).not.toContainEqual(expect.objectContaining({ type: 'subagent.completed' }));
      expect(events).not.toContainEqual(expect.objectContaining({ type: 'subagent.failed' }));
      expect(events).not.toContainEqual(
        expect.objectContaining({
          type: 'session.meta.updated',
        }),
      );
      expect(fakeProviderState.calls[1]?.systemPrompt).toBe(
        fakeProviderState.calls[0]?.systemPrompt,
      );
      const btwHistoryText = JSON.stringify(fakeProviderState.calls[1]?.history);
      expect(btwHistoryText).toContain('main task context');
      expect(btwHistoryText).toContain('What are you working on right now?');

      const statePath = join(session.summary!.sessionDir, 'state.json');
      const state = JSON.parse(await readFile(statePath, 'utf-8')) as Record<string, unknown>;
      expect(state['lastPrompt']).toBe('main task context');
      expect(state['agents']).toMatchObject({ main: expect.any(Object) });
      expect(state['agents']).not.toHaveProperty(agentId);

      await harness.closeSession(session.id);
      const resumed = await harness.resumeSession({ id: session.id });
      const resumeState = resumed.getResumeState();
      expect(resumeState?.agents).toMatchObject({ main: expect.any(Object) });
      expect(resumeState?.agents).not.toHaveProperty(agentId);
      expect(resumeState?.sessionMetadata.agents).not.toHaveProperty(agentId);
    } finally {
      await harness.close();
    }
  });

  it('persists only conversation through the selected turn across resume', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });

    try {
      await configureFakeProvider(harness);
      const source = await harness.createSession({ id: 'ses_turn_fork_source', workDir });
      await runPrompt(source, 'first question', 'first answer');
      await runPrompt(source, 'second question', 'second answer');
      await runPrompt(source, 'third question', 'third answer');

      const fork = await harness.forkSession({
        id: source.id,
        forkId: 'ses_turn_fork_child',
        turnIndex: 1,
      });
      await fork.close();
      const resumed = await harness.resumeSession({ id: fork.id });
      const replayText = visibleReplayText(resumed.getResumeState()?.agents['main']?.replay ?? []);

      expect(replayText).toEqual([
        'user:first question',
        'assistant:first answer',
        'user:second question',
        'assistant:second answer',
      ]);
    } finally {
      await harness.close();
    }
  });

  it('returns the requested identity for a historical fork', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });

    try {
      await configureFakeProvider(harness);
      const source = await harness.createSession({
        id: 'ses_turn_fork_metadata_source',
        workDir,
        metadata: { source: 'vscode' },
      });
      await runPrompt(source, 'branch here', 'kept answer');
      await runPrompt(source, 'future prompt', 'discarded answer');

      const fork = await harness.forkSession({
        id: source.id,
        forkId: 'ses_turn_fork_metadata_child',
        title: 'Historical branch',
        metadata: { branch: 'historical' },
        turnIndex: 0,
      });
      const state = fork.getResumeState();

      expect(fork.id).toBe('ses_turn_fork_metadata_child');
      expect(fork.workDir).toBe(source.workDir);
      expect(state?.sessionMetadata.forkedFrom).toBe(source.id);
    } finally {
      await harness.close();
    }
  });

  it('derives historical fork metadata from the selected turn', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });

    try {
      await configureFakeProvider(harness);
      const source = await harness.createSession({
        id: 'ses_turn_fork_state_source',
        workDir,
        metadata: { source: 'vscode' },
      });
      await runPrompt(source, 'branch here', 'kept answer');
      await runPrompt(source, 'future prompt', 'discarded answer');

      const fork = await harness.forkSession({
        id: source.id,
        forkId: 'ses_turn_fork_state_child',
        title: 'Historical branch',
        metadata: { branch: 'historical' },
        turnIndex: 0,
      });

      expect(fork.summary).toMatchObject({
        title: 'Historical branch',
        lastPrompt: 'branch here',
        metadata: { source: 'vscode', branch: 'historical' },
      });
      expect(fork.getResumeState()?.sessionMetadata).toMatchObject({
        title: 'Historical branch',
        lastPrompt: 'branch here',
        custom: { source: 'vscode', branch: 'historical' },
      });
    } finally {
      await harness.close();
    }
  });

  it('continues with the next turn id after a historical fork', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });

    try {
      await configureFakeProvider(harness);
      const source = await harness.createSession({ id: 'ses_turn_fork_id_source', workDir });
      await runPrompt(source, 'kept prompt', 'kept answer');
      await runPrompt(source, 'future prompt', 'future answer');
      const fork = await harness.forkSession({ id: source.id, turnIndex: 0 });
      const started = waitForEvent(fork, (event) => event.type === 'turn.started');
      const ended = waitForEvent(fork, (event) => event.type === 'turn.ended');

      await fork.prompt('branch continuation');

      await expect(started).resolves.toMatchObject({ type: 'turn.started', turnId: 1 });
      await ended;
    } finally {
      await harness.close();
    }
  });

  it('omits subagents created after the selected historical turn', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });

    try {
      await configureFakeProvider(harness);
      const source = await harness.createSession({ id: 'ses_turn_fork_agents_source', workDir });
      await runPrompt(source, 'kept prompt', 'kept answer');
      await runPrompt(source, 'future prompt', 'future answer');
      await source.init();

      const fork = await harness.forkSession({ id: source.id, turnIndex: 0 });

      expect(Object.keys(fork.getResumeState()?.sessionMetadata.agents ?? {})).toEqual(['main']);
    } finally {
      await harness.close();
    }
  });

  it('rejects a negative historical turn index with request.invalid', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });

    try {
      const source = await harness.createSession({ id: 'ses_turn_fork_negative', workDir });

      await expect(
        harness.forkSession({ id: source.id, turnIndex: -1 }),
      ).rejects.toMatchObject({
        name: 'KimiError',
        code: 'request.invalid',
      });
    } finally {
      await harness.close();
    }
  });

  it('rejects an out-of-range historical turn without creating the fork', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });

    try {
      await configureFakeProvider(harness);
      const source = await harness.createSession({ id: 'ses_turn_fork_range_source', workDir });
      await runPrompt(source, 'only question', 'only answer');

      await expect(
        harness.forkSession({
          id: source.id,
          forkId: 'ses_turn_fork_range_child',
          turnIndex: 1,
        }),
      ).rejects.toMatchObject({
        name: 'KimiError',
        code: 'request.invalid',
        details: { turnIndex: 1, availableTurns: 1 },
      });
      await expect(
        harness.listSessions({ sessionId: 'ses_turn_fork_range_child' }),
      ).resolves.toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('rejects empty prompt input', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const session = await harness.createSession({ id: 'ses_empty_prompt', workDir });
      await expect(session.prompt('   ')).rejects.toMatchObject({
        name: 'KimiError',
        code: 'request.prompt_input_empty',
      });
    } finally {
      await harness.close();
    }
  });
});

async function runPrompt(
  session: Parameters<typeof waitForEvent>[0] & { prompt(input: string): Promise<void> },
  input: string,
  response: string,
): Promise<void> {
  fakeProviderState.responseText = response;
  const done = waitForEvent(session, (event) => event.type === 'turn.ended');
  await session.prompt(input);
  await done;
}

function visibleReplayText(
  records: readonly {
    readonly type: string;
    readonly message?: {
      readonly role: string;
      readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
      readonly origin?: { readonly kind: string };
    };
  }[],
): readonly string[] {
  const entries: string[] = [];
  for (const record of records) {
    if (record.type !== 'message' || record.message === undefined) continue;
    const { message } = record;
    if (message.role === 'user' && message.origin?.kind !== 'user') continue;
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const text = message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('');
    entries.push(`${message.role}:${text}`);
  }
  return entries;
}

async function configureFakeProvider(harness: KimiHarness): Promise<void> {
  await harness.setConfig({
    providers: {
      local: {
        type: 'kimi',
        apiKey: 'sk-test',
      },
    },
    models: {
      'fake-model': {
        provider: 'local',
        model: 'fake-model',
        maxContextSize: 262144,
      },
    },
    defaultModel: 'fake-model',
  });
}

function waitForEvent(
  session: {
    onEvent(listener: (event: Event) => void): () => void;
  },
  predicate: (event: Event) => boolean,
): Promise<Event> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error('Timed out waiting for session event'));
    }, 1_000);
    const unsubscribe = session.onEvent((event) => {
      if (!predicate(event)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(event);
    });
  });
}
