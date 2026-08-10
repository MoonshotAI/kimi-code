/**
 * Scenario: prompt-driven session behavior, including historical-turn forks.
 * Responsibilities: public SDK events, persisted replay, metadata, and input errors.
 * Wiring: real in-process core/storage with only the remote model provider stubbed.
 * Run: pnpm exec vitest run packages/node-sdk/test/session-prompt-events.test.ts
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createKimiHarness, type Event } from '#/index';

import { fakeLlmStep, writeFakeModelConfig } from './session-runtime-helpers';
import { TEST_IDENTITY } from './test-identity';

/**
 * Fake host-proxy model step state. The Rust engine runs turns against the
 * `llmStep` host callback (the retired JS-engine kosong `createProvider`
 * mock does not reach the engine), so tests drive and inspect the step here.
 */
const llmState: {
  calls: Array<{ system_prompt: string; messages: unknown; model_name?: string }>;
  responseText: string;
} = {
  calls: [],
  responseText: 'hello from fake provider',
};

const tempDirs: string[] = [];

beforeEach(() => {
  llmState.calls.length = 0;
  llmState.responseText = 'hello from fake provider';
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
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
      llmStep: fakeLlmStep(llmState),
    });

    try {
      await writeFakeModelConfig(homeDir);
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

  it('runs prompts as engine turns without synthesizing prompt metadata', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
      llmStep: fakeLlmStep(llmState),
    });

    try {
      await writeFakeModelConfig(homeDir);
      const session = await harness.createSession({ id: 'ses_prompt_meta', workDir });
      const events: Event[] = [];
      const unsubscribe = session.onEvent((event) => {
        events.push(event);
      });

      let done = waitForEvent(session, (event) => event.type === 'session.turn.ended');
      await session.prompt('use api_key=secret-value for the request');
      await done;

      // Prompt metadata (title/lastPrompt sanitization) was host-side on the
      // retired JS engine; the Rust engine emits turn events only. The prompt
      // text reaches the model step verbatim — redaction is host-projecting.
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'session.turn.started' }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'llm.delta',
          sessionId: session.id,
          agentId: 'main',
          part: { type: 'text', text: 'hello from fake provider' },
        }),
      );
      expect(events).not.toContainEqual(
        expect.objectContaining({ type: 'session.meta.updated' }),
      );
      expect(llmState.calls[0]?.messages).toEqual(
        expect.arrayContaining([expect.objectContaining({ role: 'user' })]),
      );

      events.length = 0;
      done = waitForEvent(session, (event) => event.type === 'session.turn.ended');
      await session.prompt('second prompt');
      await done;
      unsubscribe();

      expect(events).not.toContainEqual(
        expect.objectContaining({ type: 'session.meta.updated' }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'session.turn.ended' }),
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
      llmStep: fakeLlmStep(llmState),
    });

    try {
      await writeFakeModelConfig(homeDir);
      const session = await harness.createSession({ id: 'ses_prompt_events', workDir });
      const events: Event[] = [];
      const done = waitForEvent(session, (event) => event.type === 'session.turn.ended');
      const unsubscribe = session.onEvent((event) => {
        events.push(event);
      });

      await session.prompt('hello');
      await done;
      unsubscribe();

      expect(events.some((event) => event.type === 'session.turn.started')).toBe(true);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'llm.delta',
          sessionId: session.id,
          agentId: 'main',
          part: { type: 'text', text: 'hello from fake provider' },
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'session.turn.ended',
          sessionId: session.id,
          agentId: 'main',
          turn_id: 0,
          stop_reason: 'EndTurn',
        }),
      );
      // System-prompt rendering is host-side (A8): the SDK host does not
      // render the CLI profile at createSession, so the model step carries
      // the engine's (empty) default prompt — assert the user message flows
      // to the step instead of a host-rendered prompt string.
      expect(llmState.calls[0]?.messages).toEqual(
        expect.arrayContaining([expect.objectContaining({ role: 'user' })]),
      );
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
      llmStep: fakeLlmStep(llmState),
    });

    try {
      await writeFakeModelConfig(homeDir);
      const session = await harness.createSession({ id: 'ses_prompt_unsubscribe', workDir });
      const unsubscribedEvents: Event[] = [];
      const unsubscribe = session.onEvent((event) => {
        unsubscribedEvents.push(event);
      });
      unsubscribe();
      const done = waitForEvent(session, (event) => event.type === 'session.turn.ended');

      await session.prompt([{ type: 'text', text: 'hello' }]);
      await done;

      expect(unsubscribedEvents).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('runs init through the generateAgentsMd RPC without prompt metadata updates', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
      llmStep: fakeLlmStep(llmState),
    });

    try {
      await writeFakeModelConfig(homeDir);
      const session = await harness.createSession({ id: 'ses_init_rpc', workDir });
      const events: Event[] = [];
      const unsubscribe = session.onEvent((event) => {
        events.push(event);
      });

      await session.init();
      unsubscribe();

      // init spawns a one-shot child agent internally; the legacy
      // `subagent.spawned` event surface was removed with the
      // protocol-toward-engine rewrite, so only the RPC/history side effects
      // below are asserted.
      expect(events).not.toContainEqual(
        expect.objectContaining({
          type: 'session.meta.updated',
        }),
      );
      expect(llmState.calls[0]?.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: expect.stringContaining('[Skill: init]'),
          }),
        ]),
      );
      expect(JSON.stringify(llmState.calls[0]?.messages)).toContain('Task requirements:');
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
      llmStep: fakeLlmStep(llmState),
    });

    try {
      await writeFakeModelConfig(homeDir);
      const session = await harness.createSession({ id: 'ses_btw_rpc', workDir });
      const events: Event[] = [];
      const unsubscribe = session.onEvent((event) => {
        events.push(event);
      });

      let done = waitForEvent(session, (event) => event.type === 'session.turn.ended');
      await session.prompt('main task context');
      await done;

      llmState.responseText = 'The main agent is working from the existing context.';
      events.length = 0;
      // The engine wire carries no per-agent id (side-agent turns share the
      // session id and are stamped `main` by the SDK), so the side turn is
      // observed through its model step: the btw agent is seeded with the
      // main conversation and answers the side question from that context.
      done = waitForEvent(session, (event) => event.type === 'session.turn.ended');
      const agentId = await session.startBtw();
      expect(agentId).toMatch(/^btw-/);
      await harness.withInteractiveAgent(agentId, () =>
        session.prompt('What are you working on right now?'),
      );
      await done;
      unsubscribe();
      expect(harness.interactiveAgentId).toBe('main');

      expect(events).not.toContainEqual(
        expect.objectContaining({
          type: 'session.meta.updated',
        }),
      );
      const btwHistoryText = JSON.stringify(llmState.calls[1]?.messages);
      expect(btwHistoryText).toContain('main task context');
      expect(btwHistoryText).toContain('What are you working on right now?');

      // The engine owns session persistence; the host no longer writes a
      // session-directory state.json (agent bookkeeping lives in the engine
      // store). Resume keeps the session alive across close.
      await harness.closeSession(session.id);
      const resumed = await harness.resumeSession({ id: session.id });
      expect(resumed.id).toBe(session.id);
    } finally {
      await harness.close();
    }
  });

  it('persists only conversation through the selected turn across resume', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
      llmStep: fakeLlmStep(llmState),
    });

    try {
      await writeFakeModelConfig(homeDir);
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
      const replayText = visibleReplayText((resumed.getResumeState()?.agents['main']?.replay ?? []) as never);

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
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
      llmStep: fakeLlmStep(llmState),
    });

    try {
      await writeFakeModelConfig(homeDir);
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
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
      llmStep: fakeLlmStep(llmState),
    });

    try {
      await writeFakeModelConfig(homeDir);
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
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
      llmStep: fakeLlmStep(llmState),
    });

    try {
      await writeFakeModelConfig(homeDir);
      const source = await harness.createSession({ id: 'ses_turn_fork_id_source', workDir });
      await runPrompt(source, 'kept prompt', 'kept answer');
      await runPrompt(source, 'future prompt', 'future answer');
      const fork = await harness.forkSession({ id: source.id, turnIndex: 0 });
      const started = waitForEvent(fork, (event) => event.type === 'session.turn.started');
      const ended = waitForEvent(fork, (event) => event.type === 'session.turn.ended');

      await fork.prompt('branch continuation');

      await expect(started).resolves.toMatchObject({
        type: 'session.turn.started',
        turn_id: 1,
      });
      await ended;
    } finally {
      await harness.close();
    }
  });

  it('omits subagents created after the selected historical turn', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
      llmStep: fakeLlmStep(llmState),
    });

    try {
      await writeFakeModelConfig(homeDir);
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
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
      llmStep: fakeLlmStep(llmState),
    });

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
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
      llmStep: fakeLlmStep(llmState),
    });

    try {
      await writeFakeModelConfig(homeDir);
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
      llmStep: fakeLlmStep(llmState),
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
  llmState.responseText = response;
  const done = waitForEvent(session, (event) => event.type === 'session.turn.ended');
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
