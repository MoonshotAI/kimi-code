import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  call,
  createFakeModel,
  held,
  reply,
  say,
  type FakeModel,
  type Lane,
  type ModelRequest,
  type RequestFacts,
} from '@moonshot-ai/testkit/model';

import { createKimiHarness, type Event, type KimiHarness } from '#/index';

import { TEST_IDENTITY } from './test-identity';
import { waitForAgentWireEvent } from './session-runtime-helpers';

let model: FakeModel;
let catchAll: Lane | undefined;
let fetchStub: ReturnType<typeof vi.spyOn> | undefined;

function replies(): Lane {
  catchAll ??= model.route('session', () => true);
  return catchAll;
}

function userMentions(request: RequestFacts, text: string): boolean {
  return request.texts('user').some((content) => content.includes(text));
}

function systemPromptOf(request: ModelRequest | undefined): string {
  return request?.texts('system').join('\n') ?? '';
}

function historyOf(request: ModelRequest | undefined): string {
  return JSON.stringify((request?.body as { readonly messages?: unknown } | undefined)?.messages ?? []);
}

const tempDirs: string[] = [];

beforeEach(() => {
  model = createFakeModel();
  catchAll = undefined;
  fetchStub = vi.spyOn(globalThis, 'fetch').mockImplementation(model.fetch);
});

afterEach(async () => {
  fetchStub?.mockRestore();
  fetchStub = undefined;
  try {
    model.verify();
  } finally {
    await model.close();
    for (const dir of tempDirs.splice(0)) {
      await removeTempDir(dir);
    }
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
  it('continues notifying sessions after disabling and restarting with identical prompt and tools', async () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_FLAG', '0');
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_NOTIFY_USER', '');
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const notify = (id: string) =>
      call(
        'NotifyUser',
        { title: 'Checking the work', message: 'Reviewing the changed files.' },
        { id },
      );
    replies().script(
      notify('notify-1'),
      say('Work completed.'),
      notify('notify-3'),
      say('Work completed.'),
      notify('notify-5'),
      say('Work completed.'),
    );
    let harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
      uiCapabilities: ['update_panel'],
    });
    try {
      await configureFakeProvider(harness);
      await harness.setConfig({ experimental: { notify_user: true } });
      let session = await harness.createSession({ id: 'ses_notify_continue', workDir });
      const events: Event[] = [];
      let unsubscribe = session.onEvent((event) => events.push(event));
      for (let turn = 0; turn < 3; turn++) {
        if (turn === 1) await harness.setConfig({ experimental: { notify_user: false } });
        if (turn === 2) {
          unsubscribe();
          await harness.close();
          harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir, uiCapabilities: [] });
          session = await harness.resumeSession({ id: 'ses_notify_continue' });
          unsubscribe = session.onEvent((event) => events.push(event));
        }
        const done = waitForEvent(session, (event) => event.type === 'turn.ended');
        await session.prompt(`Continue the work, turn ${turn + 1}.`);
        expect(await done).toMatchObject({ reason: 'completed' });
      }
      unsubscribe();
      const requests = model.requests().map(
        (request) => request.body as { tools: unknown; messages: Array<{ role: string; content: unknown }> },
      );
      expect(requests).toHaveLength(6);
      const system = (request: (typeof requests)[number]) =>
        request.messages.filter((message) => message.role === 'system');
      for (const request of requests) {
        expect(request.tools).toEqual(requests[0]!.tools);
        expect(system(request)).toEqual(system(requests[0]!));
      }
      const results = events.filter((event) => event.type === 'tool.result');
      expect(results).toHaveLength(3);
      expect(results.every((event) => event.isError !== true)).toBe(true);
      expect(JSON.stringify(results[0])).toContain('Update shown to the user.');
      expect(JSON.stringify(results.slice(1))).toContain(
        'Notifications are disabled; the update was not displayed.',
      );
    } finally {
      await harness.close();
      vi.unstubAllEnvs();
    }
  });

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
      replies().script(say('first reply'), say('second reply'), say('image reply'));
      const session = await harness.createSession({ id: 'ses_prompt_meta', workDir });
      const events: Event[] = [];
      const unsubscribe = session.onEvent((event) => {
        events.push(event);
      });

      let done = waitForEvent(session, (event) => event.type === 'turn.ended');
      await session.prompt('use api_key=secret-value for the request');
      await done;

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
      replies().script(say('hello from fake provider'));
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
      expect(systemPromptOf(model.requests()[0])).toContain('You are Kimi Code CLI');
      expect(systemPromptOf(model.requests()[0])).toContain('Available skills');
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
      replies().script(say('hello from fake provider'));
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
      replies().script(say('AGENTS.md written.'));
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
      expect(historyOf(model.requests()[0])).toContain('Task requirements:');
    } finally {
      await harness.close();
    }
  });

  it('carries the prompt on the public turn.started event for subagent system triggers', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      await configureFakeProvider(harness);
      replies().script(say('AGENTS.md written.'));
      const session = await harness.createSession({ id: 'ses_init_rpc_v2', workDir });
      const events: Event[] = [];
      const unsubscribe = session.onEvent((event) => {
        events.push(event);
      });

      await session.init();
      unsubscribe();

      const spawned = events.find((event) => event.type === 'subagent.spawned');
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'turn.started',
          sessionId: session.id,
          agentId: spawned?.type === 'subagent.spawned' ? spawned.subagentId : undefined,
          origin: { kind: 'system_trigger', name: 'subagent' },
          prompt: expect.stringContaining('Task requirements:'),
        }),
      );
    } finally {
      await harness.close();
    }
  });

  it('includes cancelled subagent output in persisted replay only when resume explicitly requests it', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });
    const childPrompt = 'Find why the parser never terminates.';
    const bgWorkerPrompt = 'Keep streaming in background across fork and close.';
    const finding = 'Found the loop at src/parser.ts:42; not verified yet.';
    const draft = 'Drafting the report: the loop never advances.';
    const parentAfterChild = Promise.withResolvers<void>();
    const childDraft = model.hold('child-draft');
    const bgWorkerDraft = model.hold('bg-worker');

    try {
      await configureFakeProvider(harness);
      model
        .route('bg-worker', (request) => userMentions(request, bgWorkerPrompt))
        .script(held('bg-worker', reply(say('working'), say(' still working')), 1));
      const bgParent = model
        .route('bg-parent', (request) => userMentions(request, 'Start background worker and finish turn'))
        .script(
          call(
            'Agent',
            { description: 'bg worker', prompt: bgWorkerPrompt, run_in_background: true },
            { id: 'call_bg_worker' },
          ),
          say('Worker running in background.'),
        );
      const child = model
        .route('child', (request) => userMentions(request, childPrompt))
        .script(
          call('TaskList', {}, { id: 'child_tasks', text: finding }),
          held('child-draft', reply(say(draft), say(' and the rest')), 1),
        );

      const session = await harness.createSession({ id: 'ses_subagent_replay', workDir });
      await session.setPermission('yolo');
      const events: Event[] = [];
      const unsubscribe = session.onEvent((event) => events.push(event));
      await runPrompt(session, 'seed completed boundary', 'seed answer');
      replies().script(
        call(
          'Agent',
          { description: 'trace parser loop', prompt: childPrompt, run_in_background: true },
          { id: 'call_agent' },
        ),
        async (request) => {
          await childDraft.reached();
          await parentAfterChild.promise;
          const taskId = /task_id: (agent-[0-9a-z]+)/.exec(request.rawBody)?.[1];
          if (taskId === undefined) throw new Error('Expected a background task id');
          return call('TaskStop', { task_id: taskId }, { id: 'call_stop' });
        },
        say('Stopped the subagent.'),
      );
      await session.prompt('Stop the subagent after it writes a draft.');
      await childDraft.reached();

      const runningFork = await harness.forkSession({ id: session.id });
      expect(runningFork.getResumeState()?.agents['main']).toMatchObject({ userTurnCount: 2 });
      expect(visibleReplayText(runningFork.getResumeState()?.agents['main']?.replay ?? [])).toEqual([
        'user:seed completed boundary',
        'assistant:seed answer',
        'user:Stop the subagent after it writes a draft.',
      ]);
      expect(Object.keys(runningFork.getResumeState()?.sessionMetadata.agents ?? {})).toEqual([
        'main',
      ]);
      await runningFork.close();

      parentAfterChild.resolve();
      await vi.waitFor(
        () => {
          expect(
            replies().requests().filter((request) => userMentions(request, 'Stop the subagent')),
          ).toHaveLength(3);
          expect(events).toContainEqual(
            expect.objectContaining({ type: 'turn.ended', agentId: 'main', reason: 'completed' }),
          );
          expect(events).toContainEqual(
            expect.objectContaining({
              type: 'background.task.terminated',
              info: expect.objectContaining({ status: 'killed' }),
            }),
          );
        },
        { timeout: 10_000, interval: 10 },
      );
      unsubscribe();

      const spawned = events.find((event) => event.type === 'subagent.spawned');
      if (spawned?.type !== 'subagent.spawned') throw new Error('Expected persisted subagent');
      expect(child.requests()).toHaveLength(2);
      const stopResults = events.filter(
        (event) => event.type === 'tool.result' && event.toolCallId === 'call_stop',
      );
      expect(stopResults).toHaveLength(1);
      expect(JSON.stringify(stopResults[0])).toContain('status: killed');
      expect(JSON.stringify(stopResults[0])).toContain('Stopped by TaskStop');
      const terminated = events.find(
        (event) => event.type === 'background.task.terminated' && event.info.status === 'killed',
      );
      if (terminated?.type !== 'background.task.terminated') {
        throw new Error('Expected a killed background task notification');
      }
      const stoppedOutput = await session.getBackgroundTaskOutput(terminated.info.taskId);
      expect(stoppedOutput).toContain('[partial output]');
      expect(stoppedOutput).toContain(finding);
      expect(stoppedOutput.split(draft)).toHaveLength(2);
      const terminalEvents = events.filter(
        (event) => event.type === 'subagent.cancelled' || event.type === 'subagent.failed',
      );
      expect(terminalEvents).toEqual([
        expect.objectContaining({ type: 'subagent.cancelled', subagentId: spawned.subagentId }),
      ]);
      await session.close();

      const defaultResume = await harness.resumeSession({ id: session.id });
      expect(defaultResume.getResumeState()?.agents).not.toHaveProperty(spawned.subagentId);
      await defaultResume.close();

      const fullResume = await harness.resumeSession({
        id: session.id,
        includeSubagents: true,
      });
      const agents = fullResume.getResumeState()?.agents ?? {};
      const childReplay = agents[spawned.subagentId]?.replay ?? [];
      expect(childReplay).toContainEqual(
        expect.objectContaining({
          type: 'message',
          message: expect.objectContaining({ role: 'assistant' }),
        }),
      );
      expect(JSON.stringify(childReplay).split(finding)).toHaveLength(2);
      expect(JSON.stringify(childReplay).split(draft)).toHaveLength(2);
      expect(agents['main']?.replay).toContainEqual(
        expect.objectContaining({
          type: 'message',
          message: expect.objectContaining({
            origin: expect.objectContaining({ kind: 'task', status: 'killed' }),
          }),
        }),
      );
      await fullResume.close();

      const bgSession = await harness.createSession({ id: 'ses_bg_reconcile', workDir });
      await bgSession.setPermission('yolo');
      const bgTurnEnded = waitForEvent(
        bgSession,
        (event) => event.type === 'turn.ended' && event.agentId === 'main',
      );
      await bgSession.prompt('Start background worker and finish turn');
      await bgTurnEnded;
      await bgWorkerDraft.reached();
      expect(bgParent.requests()).toHaveLength(2);

      const idleFork = await harness.forkSession({ id: bgSession.id });
      expect(bgParent.requests()).toHaveLength(2);
      await vi.waitFor(async () => {
        expect(await idleFork.listBackgroundTasks({ activeOnly: false })).toEqual([
          expect.objectContaining({ status: 'lost' }),
        ]);
        expect((await idleFork.getContext()).history).toContainEqual(
          expect.objectContaining({
            origin: expect.objectContaining({ kind: 'task', status: 'lost' }),
          }),
        );
      });
      await idleFork.close();

      await bgSession.close();
      const coldBgResume = await harness.resumeSession({ id: bgSession.id });
      expect(bgParent.requests()).toHaveLength(2);
      await vi.waitFor(async () => {
        expect((await coldBgResume.getContext()).history).toContainEqual(
          expect.objectContaining({
            origin: expect.objectContaining({ kind: 'task', status: 'killed' }),
          }),
        );
      });
      await coldBgResume.close();
    } finally {
      parentAfterChild.resolve();
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
      replies().script(say('hello from fake provider'));
      const session = await harness.createSession({ id: 'ses_btw_rpc', workDir });
      const events: Event[] = [];
      const unsubscribe = session.onEvent((event) => {
        events.push(event);
      });

      let done = waitForEvent(session, (event) => event.type === 'turn.ended');
      await session.prompt('main task context');
      await done;

      replies().script(say('The main agent is working from the existing context.'));
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
      expect(systemPromptOf(model.requests()[1])).toBe(systemPromptOf(model.requests()[0]));
      const btwHistoryText = historyOf(model.requests()[1]);
      expect(btwHistoryText).toContain('main task context');
      expect(btwHistoryText).toContain('What are you working on right now?');

      await harness.closeSession(session.id);
      const resumed = await harness.resumeSession({ id: session.id });
      const resumeState = resumed.getResumeState();
      expect(resumeState?.agents).toMatchObject({ main: { userTurnCount: 1 } });
      expect(resumeState?.agents).not.toHaveProperty(agentId);
    } finally {
      await harness.close();
    }
  });

  it('preserves started user turns through resume, undo, compaction and reload', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });

    try {
      await configureFakeProvider(harness);
      const source = await harness.createSession({ id: 'ses_user_turn_count', workDir });
      await runPrompt(source, 'first question', 'first answer');
      await runPrompt(source, 'second question', 'second answer');
      await runPrompt(source, 'third question', 'third answer');
      model.expectCacheBreak('undo rewrites the history', { at: 'history' });
      await source.undoHistory(1);
      await source.close();

      const resumed = await harness.resumeSession({ id: source.id, replayTurnLimit: 1 });
      expect(resumed.getResumeState()?.agents['main']).toMatchObject({ userTurnCount: 3 });
      expect(visibleReplayText(resumed.getResumeState()?.agents['main']?.replay ?? [])).toEqual([
        'user:second question',
        'assistant:second answer',
      ]);

      const snapshot = resumed.getResumeState()!;
      const { userTurnCount, ...legacyMain } = snapshot.agents['main']!;
      const legacySnapshot: typeof snapshot = {
        ...snapshot,
        agents: { ...snapshot.agents, main: legacyMain },
      };
      expect(userTurnCount).toBe(3);
      expect(legacySnapshot.agents['main']?.userTurnCount).toBeUndefined();

      replies().script(say('Compacted summary.'));
      await resumed.compact();
      await waitForAgentWireEvent(homeDir, source.id, 'context.apply_compaction');
      const compacted = await harness.reloadSession({ id: source.id });
      expect(compacted.getResumeState()?.agents['main']).toMatchObject({ userTurnCount: 3 });
      await runPrompt(compacted, 'follow-up question', 'follow-up answer');
      const reloaded = await harness.reloadSession({ id: source.id });
      expect(reloaded.getResumeState()?.agents['main']).toMatchObject({ userTurnCount: 4 });
    } finally {
      await harness.close();
    }
  });

  it('persists completed turns and the active prompt when forking a running source across resume', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });
    try {
      await configureFakeProvider(harness);
      const source = await harness.createSession({ id: 'ses_turn_fork_source', workDir });
      await source.setPermission('yolo');
      await runPrompt(source, 'first question', 'first answer');
      await runPrompt(source, 'second question', 'second answer');

      const toolStarted = waitForEvent(
        source,
        (event) => event.type === 'tool.call.started' && event.turnId === 2,
      );
      const activeEnded = waitForEvent(
        source,
        (event) => event.type === 'turn.ended' && event.turnId === 2,
        5_000,
      );
      const queuedEnded = waitForEvent(
        source,
        (event) => event.type === 'turn.ended' && event.turnId === 3,
        5_000,
      );
      replies().script(
        call('Bash', { command: 'node -e "setTimeout(() => {}, 2000)"' }, { id: 'running-fork-shell' }),
        say('third answer'),
        say('queued answer'),
      );
      await source.prompt('third question');
      await toolStarted;
      await source.prompt('queued question');

      const fullFork = await harness.forkSession({ id: source.id });
      expect(fullFork.getResumeState()?.agents['main']).toMatchObject({ userTurnCount: 3 });
      expect(visibleReplayText(fullFork.getResumeState()?.agents['main']?.replay ?? [])).toEqual([
        'user:first question',
        'assistant:first answer',
        'user:second question',
        'assistant:second answer',
        'user:third question',
      ]);
      await fullFork.close();

      await expect(
        harness.forkSession({ id: source.id, turnIndex: 2 }),
      ).rejects.toMatchObject({
        name: 'KimiError',
        code: 'request.invalid',
        details: { turnIndex: 2, availableTurns: 2 },
      });

      const fork = await harness.forkSession({
        id: source.id,
        forkId: 'ses_turn_fork_child',
        turnIndex: 0,
      });
      expect(fork.getResumeState()?.agents['main']).toMatchObject({ userTurnCount: 1 });
      expect(visibleReplayText(fork.getResumeState()?.agents['main']?.replay ?? [])).toEqual([
        'user:first question',
        'assistant:first answer',
      ]);

      await activeEnded;
      await queuedEnded;
      await source.close();
      const completedSource = await harness.resumeSession({ id: source.id });
      expect(completedSource.getResumeState()?.agents['main']).toMatchObject({ userTurnCount: 4 });
      expect(
        visibleReplayText(completedSource.getResumeState()?.agents['main']?.replay ?? []),
      ).toEqual([
        'user:first question',
        'assistant:first answer',
        'user:second question',
        'assistant:second answer',
        'user:third question',
        'assistant:',
        'assistant:third answer',
        'user:queued question',
        'assistant:queued answer',
      ]);

      await fork.close();
      const resumed = await harness.resumeSession({ id: fork.id });
      await runPrompt(resumed, 'fork follow-up', 'fork answer');
      const reloaded = await harness.reloadSession({ id: fork.id });
      expect(reloaded.getResumeState()?.agents['main']).toMatchObject({ userTurnCount: 2 });
    } finally {
      await harness.close();
    }
  });

  it('returns the requested identity and derives metadata from the selected historical turn', async () => {
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
      expect(fork.summary).toMatchObject({
        title: 'Historical branch',
        lastPrompt: 'branch here',
        metadata: { source: 'vscode', branch: 'historical' },
      });
      expect(state?.sessionMetadata).toMatchObject({
        title: 'Historical branch',
        lastPrompt: 'branch here',
        custom: { source: 'vscode', branch: 'historical' },
      });
    } finally {
      await harness.close();
    }
  });

  it('flattens the undo branch out of a turn-sliced fork', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });

    try {
      await configureFakeProvider(harness);
      const source = await harness.createSession({ id: 'ses_turn_fork_undo_source', workDir });
      await runPrompt(source, 'kept prompt one', 'kept answer one');
      await runPrompt(source, 'kept prompt two', 'kept answer two');
      await runPrompt(source, 'retracted prompt', 'retracted answer');
      model.expectCacheBreak('undo rewrites the history', { at: 'history' });
      await source.undoHistory(1);
      await runPrompt(source, 'follow-up prompt', 'follow-up answer');

      const fork = await harness.forkSession({
        id: source.id,
        forkId: 'ses_turn_fork_undo_child',
        turnIndex: 3,
      });
      await fork.close();
      const resumed = await harness.resumeSession({ id: fork.id });
      const replayText = visibleReplayText(resumed.getResumeState()?.agents['main']?.replay ?? []);

      expect(replayText).toEqual([
        'user:kept prompt one',
        'assistant:kept answer one',
        'user:kept prompt two',
        'assistant:kept answer two',
        'user:follow-up prompt',
        'assistant:follow-up answer',
      ]);

      const wireFiles = (await readdir(homeDir, { recursive: true })).filter((path) =>
        path.endsWith(join('agents', 'main', 'wire.jsonl')),
      );
      const forkedLines = (await readFile(
        join(homeDir, wireFiles.find((path) => path.includes(fork.id))!),
        'utf8',
      ))
        .trimEnd()
        .split('\n');
      const types = forkedLines.map((line) => (JSON.parse(line) as { type: string }).type);
      expect(types).not.toContain('agent.switched');
      expect(types).not.toContain('context.undo');
      expect(types).not.toContain('context.undone');

      const sourceLines = (await readFile(
        join(homeDir, wireFiles.find((path) => path.includes(source.id))!),
        'utf8',
      ))
        .trimEnd()
        .split('\n');
      const sourceTypes = sourceLines.map((line) => (JSON.parse(line) as { type: string }).type);
      expect(sourceTypes).toContain('agent.switched');
      expect(sourceLines.some((line) => line.includes('retracted'))).toBe(true);

      const retractedTypes = forkedLines
        .filter((line) => line.includes('retracted'))
        .map((line) => (JSON.parse(line) as { type: string }).type);
      expect(retractedTypes).toEqual([]);
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
      replies().script(say('branch answer'));

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
      replies().script(say('AGENTS.md written.'));
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

  it('forks the active user prompt while the first turn is still running', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });
    const firstReply = model.hold('first-reply');

    try {
      await configureFakeProvider(harness);
      const source = await harness.createSession({ id: 'ses_turn_fork_range_source', workDir });
      replies().script(held('first-reply', say('hello from fake provider')));
      const started = waitForEvent(source, (event) => event.type === 'turn.started');
      const ended = waitForEvent(source, (event) => event.type === 'turn.ended');
      await source.prompt('only question');
      await started;

      const fork = await harness.forkSession({
        id: source.id,
        forkId: 'ses_turn_fork_range_child',
      });
      expect(fork.summary).toMatchObject({ lastPrompt: 'only question', lastTurnReason: 'cancelled' });
      expect(visibleReplayText(fork.getResumeState()?.agents['main']?.replay ?? [])).toEqual([
        'user:only question',
      ]);
      await expect(
        harness.listSessions({ sessionId: 'ses_turn_fork_range_child' }),
      ).resolves.toHaveLength(1);
      await fork.close();

      firstReply.release();
      await ended;
      await source.close();
      const completedSource = await harness.resumeSession({ id: source.id });
      expect(visibleReplayText(completedSource.getResumeState()?.agents['main']?.replay ?? [])).toEqual([
        'user:only question',
        'assistant:hello from fake provider',
      ]);

      const resumed = await harness.resumeSession({ id: fork.id });
      await runPrompt(resumed, 'fork question', 'fork answer');
      await resumed.close();
      const reloaded = await harness.resumeSession({ id: fork.id });
      expect(reloaded.getResumeState()?.agents['main']).toMatchObject({ userTurnCount: 2 });
      expect(visibleReplayText(reloaded.getResumeState()?.agents['main']?.replay ?? [])).toEqual([
        'user:only question',
        'user:fork question',
        'assistant:fork answer',
      ]);
    } finally {
      firstReply.release();
      await harness.close();
    }
  });

  it('cancels only the prompt a cancel names while another turn keeps running', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });
    const firstReply = model.hold('first-reply');

    try {
      await configureFakeProvider(harness);
      const session = await harness.createSession({ id: 'ses_cancel_named_prompt', workDir });
      replies().script(held('first-reply', say('first answer')));
      const started = waitForEvent(session, (event) => event.type === 'turn.started');
      await session.prompt('first question');
      await started;
      const queued = waitForEvent(session, (event) => event.type === 'prompt.queued');
      await session.prompt('queued question', { promptId: 'queued-prompt' });
      await queued;

      const aborted = waitForEvent(
        session,
        (event) => event.type === 'prompt.aborted' && event.promptId === 'queued-prompt',
      );
      await session.cancel({ promptId: 'queued-prompt' });
      await aborted;
      await expect(session.cancel({ promptId: 'queued-prompt' })).rejects.toMatchObject({
        code: 'prompt.not_found',
      });
      const ended = waitForEvent(session, (event) => event.type === 'turn.ended');
      firstReply.release();

      await expect(ended).resolves.toMatchObject({ reason: 'completed' });
      expect(model.requests().map((request) => request.firstUserText)).toEqual(['first question']);
    } finally {
      firstReply.release();
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
  replies().script(say(response));
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
        baseUrl: 'https://model.example.test/v1',
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
  timeoutMs = 1_000,
): Promise<Event> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error('Timed out waiting for session event'));
    }, timeoutMs);
    const unsubscribe = session.onEvent((event) => {
      if (!predicate(event)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(event);
    });
  });
}
