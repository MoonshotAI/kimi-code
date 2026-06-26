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

type FakeStreamScript =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'textThenAbort'; readonly text: string }
  | { readonly kind: 'thinkThenAbort'; readonly think: string }
  | {
      readonly kind: 'thinkThenTextThenAbort';
      readonly think: string;
      readonly text: string;
    };

const fakeProviderState = vi.hoisted(() => ({
  calls: [] as Array<{
    readonly systemPrompt: string;
    readonly history: unknown;
  }>,
  providerConfigs: [] as unknown[],
  responseText: 'hello from fake provider',
  scripts: [] as FakeStreamScript[],
}));

vi.mock('@moonshot-ai/kosong', async (importOriginal) => {
  const actual = await importOriginal<typeof KosongModule>();
  const waitForAbort = async (signal: AbortSignal | undefined): Promise<void> => {
    if (signal === undefined) {
      throw new Error('Expected fake provider to receive an abort signal');
    }
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  };
  const throwAbortError = (): never => {
    throw new DOMException('The operation was aborted.', 'AbortError');
  };
  return {
    ...actual,
    createProvider: (config: unknown) => {
      fakeProviderState.providerConfigs.push(config);
      return {
        name: 'fake',
        modelName: 'fake-model',
        thinkingEffort: null,
        async generate(
          systemPrompt: string,
          _tools: unknown,
          history: unknown,
          options?: { readonly signal?: AbortSignal },
        ) {
          fakeProviderState.calls.push({ systemPrompt, history });
          const script = fakeProviderState.scripts.shift() ?? {
            kind: 'text',
            text: fakeProviderState.responseText,
          };
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
              switch (script.kind) {
                case 'text':
                  yield { type: 'text', text: script.text };
                  return;
                case 'textThenAbort':
                  yield { type: 'text', text: script.text };
                  await waitForAbort(options?.signal);
                  throwAbortError();
                  return;
                case 'thinkThenAbort':
                  yield { type: 'think', think: script.think };
                  await waitForAbort(options?.signal);
                  throwAbortError();
                  return;
                case 'thinkThenTextThenAbort':
                  yield { type: 'think', think: script.think };
                  yield { type: 'text', text: script.text };
                  await waitForAbort(options?.signal);
                  throwAbortError();
                  return;
                default: {
                  const _exhaustive: never = script;
                  return _exhaustive;
                }
              }
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
  fakeProviderState.scripts.length = 0;
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

  it('resumes visible text streamed before cancel without resuming thinking-only deltas', async () => {
    const homeDir = await makeTempDir();
    const textWorkDir = await makeTempDir();
    const thinkWorkDir = await makeTempDir();
    const mixedWorkDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      await configureFakeProvider(harness);

      fakeProviderState.scripts.push({
        kind: 'textThenAbort',
        text: 'Partial answer before cancel.',
      });
      const textSession = await harness.createSession({
        id: 'ses_prompt_resume_cancel_text',
        workDir: textWorkDir,
      });
      const textDelta = waitForEvent(
        textSession,
        (event) =>
          event.type === 'assistant.delta' &&
          event.delta === 'Partial answer before cancel.',
      );
      const textEnded = waitForEvent(textSession, (event) => event.type === 'turn.ended');

      await textSession.prompt('Start streaming');
      await textDelta;
      await textSession.cancel();
      await expect(textEnded).resolves.toMatchObject({
        type: 'turn.ended',
        reason: 'cancelled',
      });
      await textSession.close();

      const resumedText = await harness.resumeSession({ id: textSession.id });
      fakeProviderState.scripts.push({
        kind: 'text',
        text: 'Fresh response after text resume.',
      });
      const resumedTextEnded = waitForEvent(
        resumedText,
        (event) => event.type === 'turn.ended',
      );
      await resumedText.prompt('Follow up');
      await resumedTextEnded;

      expect(fakeProviderState.calls.at(-1)?.history).toMatchObject([
        {
          role: 'user',
          content: [{ type: 'text', text: 'Start streaming' }],
          toolCalls: [],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Partial answer before cancel.' }],
          toolCalls: [],
        },
        {
          role: 'user',
          content: [{ type: 'text', text: 'Follow up' }],
          toolCalls: [],
        },
      ]);
      await resumedText.close();

      fakeProviderState.scripts.push({
        kind: 'thinkThenAbort',
        think: 'Partial reasoning before cancel.',
      });
      const thinkSession = await harness.createSession({
        id: 'ses_prompt_resume_cancel_think',
        workDir: thinkWorkDir,
      });
      const thinkDelta = waitForEvent(
        thinkSession,
        (event) =>
          event.type === 'thinking.delta' &&
          event.delta === 'Partial reasoning before cancel.',
      );
      const thinkEnded = waitForEvent(thinkSession, (event) => event.type === 'turn.ended');

      await thinkSession.prompt('Start thinking');
      await thinkDelta;
      await thinkSession.cancel();
      await expect(thinkEnded).resolves.toMatchObject({
        type: 'turn.ended',
        reason: 'cancelled',
      });
      await thinkSession.close();

      const resumedThink = await harness.resumeSession({ id: thinkSession.id });
      fakeProviderState.scripts.push({
        kind: 'text',
        text: 'Fresh response after thinking resume.',
      });
      const resumedThinkEnded = waitForEvent(
        resumedThink,
        (event) => event.type === 'turn.ended',
      );
      await resumedThink.prompt('Follow up');
      await resumedThinkEnded;

      expect(fakeProviderState.calls.at(-1)?.history).toMatchObject([
        {
          role: 'user',
          content: [{ type: 'text', text: 'Start thinking\n\nFollow up' }],
          toolCalls: [],
        },
      ]);
      await resumedThink.close();

      fakeProviderState.scripts.push({
        kind: 'thinkThenTextThenAbort',
        think: 'Completed reasoning before answer.',
        text: 'Partial answer after reasoning.',
      });
      const mixedSession = await harness.createSession({
        id: 'ses_prompt_resume_cancel_mixed',
        workDir: mixedWorkDir,
      });
      const mixedThinkDelta = waitForEvent(
        mixedSession,
        (event) =>
          event.type === 'thinking.delta' &&
          event.delta === 'Completed reasoning before answer.',
      );
      const mixedTextDelta = waitForEvent(
        mixedSession,
        (event) =>
          event.type === 'assistant.delta' &&
          event.delta === 'Partial answer after reasoning.',
      );
      const mixedEnded = waitForEvent(mixedSession, (event) => event.type === 'turn.ended');

      await mixedSession.prompt('Start mixed streaming');
      await mixedThinkDelta;
      await mixedTextDelta;
      await mixedSession.cancel();
      await expect(mixedEnded).resolves.toMatchObject({
        type: 'turn.ended',
        reason: 'cancelled',
      });
      await mixedSession.close();

      const resumedMixed = await harness.resumeSession({ id: mixedSession.id });
      fakeProviderState.scripts.push({
        kind: 'text',
        text: 'Fresh response after mixed resume.',
      });
      const resumedMixedEnded = waitForEvent(
        resumedMixed,
        (event) => event.type === 'turn.ended',
      );
      await resumedMixed.prompt('Follow up');
      await resumedMixedEnded;

      expect(fakeProviderState.calls.at(-1)?.history).toMatchObject([
        {
          role: 'user',
          content: [{ type: 'text', text: 'Start mixed streaming' }],
          toolCalls: [],
        },
        {
          role: 'assistant',
          content: [
            { type: 'think', think: 'Completed reasoning before answer.' },
            { type: 'text', text: 'Partial answer after reasoning.' },
          ],
          toolCalls: [],
        },
        {
          role: 'user',
          content: [{ type: 'text', text: 'Follow up' }],
          toolCalls: [],
        },
      ]);
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
