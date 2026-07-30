/**
 * Scenario: an idle or cold-loaded engine launches work independently of any ACP prompt request.
 * Responsibilities: preserve history/live ordering and project each safe trigger, tool lifecycle,
 * and final reply exactly once over ACP NDJSON.
 * Wiring: real v1/v2 harnesses, engines, node SDK, ACP connections, filesystem, and shell task;
 * only the remote Chat Completions endpoint is stubbed on loopback.
 * Run: pnpm --filter @moonshot-ai/acp-adapter exec vitest run test/agent-initiated-engine.e2e.test.ts
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createRealEngineRig,
  type Engine,
  type RealEngineRig,
  waitForSessionEvent,
} from './_helpers/real-engine-rig';

const LONG_RUNNING_COMMAND = "node -e 'setInterval(()=>{},1e3)'";
const SAFE_TERMINATION_TEXT = 'Test background task was stopped.';
const PERSISTED_USER_TEXT = 'Persist this cron reminder before restart.';
const PERSISTED_ASSISTANT_TEXT = 'Cron reminder persisted.';
const RESTORE_BOUNDARY_TASK_DESCRIPTION = 'Restore boundary task';
const RESTORED_TASK_TRIGGER = 'Restore boundary task was lost.';
const RESTORED_CRON_PROMPT = 'Review the restored fixture now.';
const RESTORED_ASSISTANT_TEXT = 'Restored cron review finished.';
const CLOCK_START_MS = 1_735_689_600_000;

const rigs = new Set<RealEngineRig>();
const rigCreations: Array<Promise<RealEngineRig>> = [];
const environmentRestorers: Array<() => void> = [];
const testProcesses = new Map<number, string>();
const testGateReleasers: Array<() => void> = [];

afterEach(async () => {
  const cleanupErrors: unknown[] = [];
  for (const release of testGateReleasers.splice(0).toReversed()) {
    try {
      release();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  const creationResults = await Promise.allSettled(rigCreations.splice(0));
  for (const result of creationResults) {
    if (result.status === 'rejected') cleanupErrors.push(result.reason);
  }
  const closingRigs = [...rigs].toReversed();
  rigs.clear();

  for (const rig of closingRigs) {
    await registerActiveTestProcesses(rig);
  }
  for (const rig of closingRigs) {
    try {
      await rig.closeRuntime();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  const closingProcesses = [...testProcesses];
  testProcesses.clear();
  for (const [pid, statePath] of closingProcesses) {
    try {
      await terminateTestProcess(pid, statePath);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  for (const rig of closingRigs) {
    try {
      await rig.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  for (const restore of environmentRestorers.splice(0).toReversed()) {
    try {
      restore();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, 'Failed to clean up real-engine ACP test resources');
  }
});

describe.sequential('ACP idle engine turn projection', () => {
  it.each(['v1', 'v2'] as const)(
    'projects a complete idle task-notification turn through the %s engine',
    async (engine) => {
      const rig = await createAutonomousRig(engine);
      await expect(
        rig.client.prompt({
          sessionId: rig.session.id,
          prompt: [{ type: 'text', text: 'Start the test background task.' }],
        }),
      ).resolves.toEqual({ stopReason: 'end_turn' });
      const activeTasks = await rig.session.listBackgroundTasks({ activeOnly: true });
      expect(activeTasks).toEqual([
        expect.objectContaining({
          kind: 'process',
          command: LONG_RUNNING_COMMAND,
          detached: true,
          status: 'running',
        }),
      ]);
      const task = activeTasks[0];
      if (task === undefined) {
        throw new Error(`${engine} did not retain the background task`);
      }
      rig.collecting.updates.length = 0;

      const terminated = waitForSessionEvent(
        rig.session,
        (event) =>
          event.type === 'background.task.terminated' &&
          event.info.taskId === task.taskId,
        `${engine} background.task.terminated`,
      );
      const autonomousTurn = waitForSessionEvent(
        rig.session,
        (event) =>
          event.type === 'turn.started' &&
          event.origin.kind === (engine === 'v1' ? 'background_task' : 'task') &&
          event.origin.taskId === task.taskId,
        `${engine} background turn.started`,
      );
      const turnEnded = waitForSessionEvent(
        rig.session,
        (event) => event.type === 'turn.ended',
        `${engine} turn.ended`,
      );
      const safeTrigger = rig.collecting.waitForUpdate(
        (notification) =>
          notification.update.sessionUpdate === 'user_message_chunk' &&
          notification.update.content.type === 'text' &&
          notification.update.content.text === SAFE_TERMINATION_TEXT,
        `${engine} safe autonomous trigger`,
      );
      const toolStarted = rig.collecting.waitForUpdate(
        (notification) => notification.update.sessionUpdate === 'tool_call',
        `${engine} tool_call`,
      );
      const assistantReply = rig.collecting.waitForUpdate(
        (notification) =>
          notification.update.sessionUpdate === 'agent_message_chunk' &&
          notification.update.content.type === 'text' &&
          notification.update.content.text === 'Autonomous review finished.',
        `${engine} assistant reply`,
      );

      await rig.session.stopBackgroundTask(task.taskId);
      const [
        terminatedEvent,
        autonomousEvent,
        endedEvent,
        triggerUpdate,
        toolUpdate,
        replyUpdate,
      ] = await Promise.all([
        terminated,
        autonomousTurn,
        turnEnded,
        safeTrigger,
        toolStarted,
        assistantReply,
      ]);
      const toolCallId = toolUpdate.update.sessionUpdate === 'tool_call'
        ? toolUpdate.update.toolCallId
        : undefined;
      if (toolCallId === undefined) {
        throw new Error('tool_call waiter returned a different ACP update');
      }
      const toolCompleted = await rig.collecting.waitForUpdate(
        (notification) =>
          notification.update.sessionUpdate === 'tool_call_update' &&
          notification.update.toolCallId === toolCallId &&
          notification.update.status === 'completed',
        `${engine} completed tool_call_update for ${toolCallId}`,
      );
      expect(terminatedEvent.type).toBe('background.task.terminated');
      expect(autonomousEvent.type).toBe('turn.started');
      expect(endedEvent).toMatchObject({ type: 'turn.ended', reason: 'completed' });
      expect(rig.modelRequests).toHaveLength(4);
      expect(rig.modelRequests.map((request) => request.authorization)).toEqual([
        'Bearer YOUR_API_KEY',
        'Bearer YOUR_API_KEY',
        'Bearer YOUR_API_KEY',
        'Bearer YOUR_API_KEY',
      ]);
      expect(rig.modelRequests[2]?.body).toMatchObject({
        model: 'stub-model',
        stream: true,
        tools: expect.arrayContaining([
          expect.objectContaining({
            function: expect.objectContaining({ name: 'Read' }),
          }),
        ]),
      });
      expect(rig.modelRequests[3]?.body).toMatchObject({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: 'tool', content: expect.stringContaining('fixture contents') }),
        ]),
      });

      const orderedUpdates = [
        triggerUpdate,
        toolUpdate,
        toolCompleted,
        replyUpdate,
      ].map((update) => rig.collecting.updates.indexOf(update));
      expect(orderedUpdates).toEqual(orderedUpdates.toSorted((left, right) => left - right));
      expect(new Set(orderedUpdates).size).toBe(orderedUpdates.length);

      const wire = JSON.stringify(rig.collecting.updates);
      expect(wire).not.toContain('<notification');
      expect(wire).not.toContain('task_id:');
      expect(wire).not.toContain(task.taskId);
    },
    30_000,
  );

  it.each(['v1', 'v2'] as const)(
    'replays a completed autonomous task as one safe turn after a second cold load through the %s engine',
    async (engine) => {
      const original = await createAutonomousRig(engine);
      await expect(
        original.client.prompt({
          sessionId: original.session.id,
          prompt: [{ type: 'text', text: 'Start the test background task.' }],
        }),
      ).resolves.toEqual({ stopReason: 'end_turn' });
      const task = (await original.session.listBackgroundTasks({ activeOnly: true }))[0];
      if (task === undefined) {
        throw new Error(`${engine} did not retain the background task`);
      }
      const autonomousTurnEnded = waitForSessionEvent(
        original.session,
        (event) =>
          event.type === 'turn.ended' &&
          event.reason === 'completed',
        `${engine} completed autonomous turn`,
      );
      const autonomousReply = original.collecting.waitForUpdate(
        (notification) =>
          notification.update.sessionUpdate === 'agent_message_chunk' &&
          notification.update.content.type === 'text' &&
          notification.update.content.text === 'Autonomous review finished.',
        `${engine} autonomous reply before restart`,
      );

      await original.session.stopBackgroundTask(task.taskId);
      await Promise.all([autonomousTurnEnded, autonomousReply]);
      const sessionId = original.session.id;
      await original.closeRuntime();

      const reloaded = await trackRig(createRealEngineRig({
        engine,
        homeDir: original.homeDir,
        workDir: original.workDir,
        replies: [],
        session: { kind: 'load', id: sessionId },
      }));

      const taskTriggers = reloaded.collecting.updates.filter(
        (notification) =>
          notification.update.sessionUpdate === 'user_message_chunk' &&
          notification.update.content.type === 'text' &&
          notification.update.content.text === SAFE_TERMINATION_TEXT,
      );
      const toolCalls = reloaded.collecting.updates.filter(
        (notification) =>
          notification.update.sessionUpdate === 'tool_call' &&
          notification.update.toolCallId.includes('call_read_fixture'),
      );
      const replies = reloaded.collecting.updates.filter(
        (notification) =>
          notification.update.sessionUpdate === 'agent_message_chunk' &&
          notification.update.content.type === 'text' &&
          notification.update.content.text === 'Autonomous review finished.',
      );
      expect(taskTriggers).toHaveLength(1);
      expect(toolCalls).toHaveLength(1);
      expect(replies).toHaveLength(1);
      const toolCall = toolCalls[0];
      if (toolCall?.update.sessionUpdate !== 'tool_call') {
        throw new Error(`${engine} did not replay the autonomous Read tool`);
      }
      const toolCallId = toolCall.update.toolCallId;
      const completedToolCalls = reloaded.collecting.updates.filter(
        (notification) =>
          notification.update.sessionUpdate === 'tool_call_update' &&
          notification.update.toolCallId === toolCallId &&
          notification.update.status === 'completed',
      );
      expect(completedToolCalls).toHaveLength(1);

      const orderedUpdates = [
        taskTriggers[0],
        toolCall,
        completedToolCalls[0],
        replies[0],
      ].map((notification) =>
        notification === undefined
          ? -1
          : reloaded.collecting.updates.indexOf(notification),
      );
      expect(orderedUpdates.every((index) => index >= 0)).toBe(true);
      expect(orderedUpdates).toEqual(
        orderedUpdates.toSorted((left, right) => left - right),
      );
      expect(new Set(orderedUpdates).size).toBe(orderedUpdates.length);
      expect(reloaded.modelRequests).toHaveLength(0);

      const wire = JSON.stringify(reloaded.collecting.updates);
      expect(wire).not.toContain('<notification');
    },
    45_000,
  );

  it.each(['v1', 'v2'] as const)(
    'loads persisted cron work atomically through the %s engine',
    async (engine) => {
      const signalListenersBefore = process.listenerCount('SIGUSR1');
      const homeDir = await mkdtemp(join(tmpdir(), `kimi-acp-${engine}-resume-home-`));
      const workDir = await mkdtemp(join(tmpdir(), `kimi-acp-${engine}-resume-work-`));
      const clockPath = join(homeDir, 'cron-clock.txt');
      const readPath = join(workDir, 'restored-fixture.txt');
      await writeFile(clockPath, String(CLOCK_START_MS), 'utf-8');
      await writeFile(readPath, 'restored fixture contents', 'utf-8');
      setTestEnvironment('KIMI_CRON_CLOCK', `file:${clockPath}`);
      setTestEnvironment('KIMI_CRON_MANUAL_TICK', '1');
      setTestEnvironment('KIMI_CRON_NO_JITTER', '1');
      setTestEnvironment('KIMI_CRON_NO_STALE', '1');
      setTestEnvironment('KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT', '1');

      const original = await trackRig(createRealEngineRig({
        engine,
        homeDir,
        workDir,
        replies: [
          {
            kind: 'tool',
            id: 'call_create_restore_boundary_task',
            name: 'Bash',
            arguments: {
              command: LONG_RUNNING_COMMAND,
              description: RESTORE_BOUNDARY_TASK_DESCRIPTION,
              run_in_background: true,
            },
          },
          {
            kind: 'tool',
            id: 'call_create_cron',
            name: 'CronCreate',
            arguments: {
              cron: '* * * * *',
              prompt: RESTORED_CRON_PROMPT,
              recurring: false,
            },
          },
          { kind: 'text', text: PERSISTED_ASSISTANT_TEXT },
        ],
      }));
      await expect(
        original.client.prompt({
          sessionId: original.session.id,
          prompt: [{ type: 'text', text: PERSISTED_USER_TEXT }],
        }),
      ).resolves.toEqual({ stopReason: 'end_turn' });
      const persistedTasks = await original.session.listBackgroundTasks({
        activeOnly: true,
      });
      expect(persistedTasks).toEqual([
        expect.objectContaining({
          kind: 'process',
          command: LONG_RUNNING_COMMAND,
          description: RESTORE_BOUNDARY_TASK_DESCRIPTION,
          detached: true,
          status: 'running',
        }),
      ]);
      const persistedTask = persistedTasks[0];
      if (persistedTask?.kind !== 'process') {
        throw new Error(`${engine} did not retain the restore-boundary process`);
      }
      const sessionDir = original.session.summary?.sessionDir;
      if (sessionDir === undefined) {
        throw new Error(`${engine} session summary did not expose its persistence directory`);
      }
      const persistedTaskStatePath = join(
        sessionDir,
        'agents',
        'main',
        'tasks',
        `${persistedTask.taskId}.json`,
      );
      testProcesses.set(persistedTask.pid, persistedTaskStatePath);
      expect(original.modelRequests).toHaveLength(3);
      await expect(original.session.getCronTasks()).resolves.toEqual({
        tasks: [
          expect.objectContaining({
            cron: '* * * * *',
            recurring: false,
            nextFireAt: 1_735_689_660_000,
          }),
        ],
      });

      const sessionId = original.session.id;
      await original.closeRuntime();
      expect(process.listenerCount('SIGUSR1')).toBe(signalListenersBefore);
      await writeFile(clockPath, String(CLOCK_START_MS + 60_000), 'utf-8');

      const historyReached = controlledPromise();
      const releaseHistory = controlledPromise();
      const modelRequestReached = controlledPromise();
      const releaseModelReply = controlledPromise();
      testGateReleasers.push(releaseHistory.resolve, releaseModelReply.resolve);
      let heldHistory = false;
      let loadSettled = false;
      const loadingRig = trackRig(createRealEngineRig({
        engine,
        homeDir,
        workDir,
        session: { kind: 'load', id: sessionId },
        replies: [
          {
            kind: 'tool',
            id: 'call_restore_read',
            name: 'Read',
            arguments: { path: readPath },
          },
          { kind: 'text', text: RESTORED_ASSISTANT_TEXT },
        ],
        onSessionUpdate: async (notification) => {
          if (
            heldHistory ||
            notification.update.sessionUpdate !== 'agent_message_chunk' ||
            notification.update.content.type !== 'text' ||
            notification.update.content.text !== PERSISTED_ASSISTANT_TEXT
          ) {
            return;
          }
          heldHistory = true;
          historyReached.resolve();
          await releaseHistory.promise;
        },
        beforeModelReply: async (_request, index) => {
          if (index !== 0) return;
          modelRequestReached.resolve();
          await releaseModelReply.promise;
        },
      })).finally(() => {
        loadSettled = true;
      });

      const firstBoundary = await Promise.race([
        historyReached.promise.then(() => 'history' as const),
        loadingRig.then(() => 'load' as const),
      ]);
      expect(firstBoundary).toBe('history');
      try {
        expect(loadSettled).toBe(false);
        expect(process.emit('SIGUSR1')).toBe(true);
        await Promise.resolve();
        await Promise.resolve();
        expect(loadSettled).toBe(false);
      } finally {
        releaseHistory.resolve();
      }

      const restored = await loadingRig;
      const restoredTaskTrigger = restored.collecting.waitForUpdate(
        (notification) =>
          notification.update.sessionUpdate === 'user_message_chunk' &&
          notification.update.content.type === 'text' &&
          notification.update.content.text === RESTORED_TASK_TRIGGER,
        `${engine} restored task safe trigger`,
      );
      const restoredCronTrigger = restored.collecting.waitForUpdate(
        (notification) =>
          notification.update.sessionUpdate === 'user_message_chunk' &&
          notification.update.content.type === 'text' &&
          notification.update.content.text === RESTORED_CRON_PROMPT,
        `${engine} restored cron safe trigger`,
      );
      try {
        await Promise.all([
          restoredTaskTrigger,
          restoredCronTrigger,
          modelRequestReached.promise,
        ]);
        expect(
          restored.collecting.updates.filter(
            (notification) =>
              notification.update.sessionUpdate === 'tool_call' &&
              notification.update.toolCallId.includes('call_restore_read'),
          ),
        ).toHaveLength(0);
        expect(
          restored.collecting.updates.filter(
            (notification) =>
              notification.update.sessionUpdate === 'agent_message_chunk' &&
              notification.update.content.type === 'text' &&
              notification.update.content.text === RESTORED_ASSISTANT_TEXT,
          ),
        ).toHaveLength(0);
      } finally {
        releaseModelReply.resolve();
      }

      await restored.collecting.waitForUpdate(
        (notification) =>
          notification.update.sessionUpdate === 'agent_message_chunk' &&
          notification.update.content.type === 'text' &&
          notification.update.content.text === RESTORED_ASSISTANT_TEXT,
        `${engine} restored cron assistant reply`,
      );
      expect(restored.modelRequests).toHaveLength(2);
      expect(restored.modelRequests[0]?.body).toMatchObject({
        model: 'stub-model',
        stream: true,
        tools: expect.arrayContaining([
          expect.objectContaining({
            function: expect.objectContaining({ name: 'Read' }),
          }),
        ]),
      });
      expect(restored.modelRequests[1]?.body).toMatchObject({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'tool',
            content: expect.stringContaining('restored fixture contents'),
          }),
        ]),
      });

      const restoredTaskTriggers = restored.collecting.updates.filter(
        (notification) =>
          notification.update.sessionUpdate === 'user_message_chunk' &&
          notification.update.content.type === 'text' &&
          notification.update.content.text === RESTORED_TASK_TRIGGER,
      );
      const restoredCronTriggers = restored.collecting.updates.filter(
        (notification) =>
          notification.update.sessionUpdate === 'user_message_chunk' &&
          notification.update.content.type === 'text' &&
          notification.update.content.text === RESTORED_CRON_PROMPT,
      );
      const liveToolCalls = restored.collecting.updates.filter(
        (notification) =>
          notification.update.sessionUpdate === 'tool_call' &&
          notification.update.toolCallId.includes('call_restore_read'),
      );
      expect(restoredTaskTriggers).toHaveLength(1);
      expect(restoredCronTriggers).toHaveLength(1);
      expect(liveToolCalls).toHaveLength(1);
      const liveToolCall = liveToolCalls[0];
      if (liveToolCall?.update.sessionUpdate !== 'tool_call') {
        throw new Error(`${engine} did not project the restored Read tool`);
      }
      const liveToolCallId = liveToolCall.update.toolCallId;
      const completedLiveToolCalls = restored.collecting.updates.filter(
        (notification) =>
          notification.update.sessionUpdate === 'tool_call_update' &&
          notification.update.toolCallId === liveToolCallId &&
          notification.update.status === 'completed',
      );
      const liveAssistantReplies = restored.collecting.updates.filter(
        (notification) =>
          notification.update.sessionUpdate === 'agent_message_chunk' &&
          notification.update.content.type === 'text' &&
          notification.update.content.text === RESTORED_ASSISTANT_TEXT,
      );
      expect(completedLiveToolCalls).toHaveLength(1);
      expect(liveAssistantReplies).toHaveLength(1);

      const orderedUpdates = [
        restored.collecting.updates.find(
          (notification) =>
            notification.update.sessionUpdate === 'agent_message_chunk' &&
            notification.update.content.type === 'text' &&
            notification.update.content.text === PERSISTED_ASSISTANT_TEXT,
        ),
        restoredTaskTriggers[0],
        restoredCronTriggers[0],
        liveToolCall,
        completedLiveToolCalls[0],
        liveAssistantReplies[0],
      ].map((notification) =>
        notification === undefined
          ? -1
          : restored.collecting.updates.indexOf(notification),
      );
      expect(orderedUpdates.every((index) => index >= 0)).toBe(true);
      expect(orderedUpdates).toEqual(
        orderedUpdates.toSorted((left, right) => left - right),
      );
      expect(new Set(orderedUpdates).size).toBe(orderedUpdates.length);

      const wire = JSON.stringify(restored.collecting.updates);
      expect(wire).not.toContain('<cron-fire');
      expect(wire).not.toContain('<notification');

      await restored.closeRuntime();
      await terminateTestProcess(persistedTask.pid, persistedTaskStatePath);
      testProcesses.delete(persistedTask.pid);
      expect(process.listenerCount('SIGUSR1')).toBe(signalListenersBefore);
    },
    45_000,
  );
});

async function createAutonomousRig(engine: Engine): Promise<RealEngineRig> {
  const homeDir = await mkdtemp(join(tmpdir(), `kimi-acp-${engine}-home-`));
  const workDir = await mkdtemp(join(tmpdir(), `kimi-acp-${engine}-work-`));
  const readPath = join(workDir, 'fixture.txt');
  await writeFile(readPath, 'fixture contents', 'utf-8');
  const rig = await trackRig(createRealEngineRig({
    engine,
    homeDir,
    workDir,
    replies: [
      {
        kind: 'tool',
        id: 'call_start_background',
        name: 'Bash',
        arguments: {
          command: LONG_RUNNING_COMMAND,
          description: 'Test background task',
          run_in_background: true,
        },
      },
      { kind: 'text', text: 'Background task started.' },
      {
        kind: 'tool',
        id: 'call_read_fixture',
        name: 'Read',
        arguments: { path: readPath },
      },
      { kind: 'text', text: 'Autonomous review finished.' },
    ],
  }));
  return rig;
}

function trackRig(creation: Promise<RealEngineRig>): Promise<RealEngineRig> {
  const tracked = creation.then((rig) => {
    rigs.add(rig);
    return rig;
  });
  rigCreations.push(tracked);
  void tracked.catch(() => undefined);
  return tracked;
}

async function registerActiveTestProcesses(rig: RealEngineRig): Promise<void> {
  const sessionDir = rig.session.summary?.sessionDir;
  if (sessionDir === undefined) return;
  try {
    const tasks = await rig.session.listBackgroundTasks({ activeOnly: true });
    for (const task of tasks) {
      if (task.kind !== 'process') continue;
      testProcesses.set(
        task.pid,
        join(
          sessionDir,
          'agents',
          'main',
          'tasks',
          `${task.taskId}.json`,
        ),
      );
    }
  } catch {
    // A test may have deliberately closed this runtime before afterEach. Any
    // process discovered while it was live was already registered explicitly.
  }
}

function controlledPromise(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function setTestEnvironment(name: string, value: string): void {
  const hadValue = Object.prototype.hasOwnProperty.call(process.env, name);
  const previous = process.env[name];
  process.env[name] = value;
  environmentRestorers.push(() => {
    if (hadValue) {
      process.env[name] = previous;
    } else {
      delete process.env[name];
    }
  });
}

async function terminateTestProcess(
  pid: number,
  statePath: string,
): Promise<void> {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (isMissingProcess(error)) {
      return;
    }
    throw error;
  }

  const signal = AbortSignal.timeout(5_000);
  while (!signal.aborted) {
    try {
      const persisted: unknown = JSON.parse(await readFile(statePath, 'utf-8'));
      const status =
        typeof persisted === 'object' &&
        persisted !== null &&
        'status' in persisted
          ? persisted.status
          : undefined;
      if (
        status === 'completed' ||
        status === 'failed' ||
        status === 'killed' ||
        status === 'timed_out'
      ) {
        return;
      }
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  throw new Error(
    `Timed out waiting for test process ${String(pid)} to persist its terminal state`,
  );
}

function isMissingProcess(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ESRCH'
  );
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}
