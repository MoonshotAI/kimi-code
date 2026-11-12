import { PassThrough, Readable } from 'node:stream';
import type { Writable } from 'node:stream';
import { join } from 'pathe';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { IHostProcess } from '#/os/interface/hostProcess';
import { type AgentTaskInfo, IAgentTaskService } from '#/agent/task/task';
import { ContextAppendMessage } from '#/agent/contextMemory/contextEvents';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentConversationUndoService } from '#/agent/undo/undo';
import { ErrorCodes } from '#/errors';
import { ITaskStopTool } from '#/agent/tools/task/task-stop/task-stop';
import { IAgentTaskOutputService, createTaskCompletionEntry, emptyOutputSnapshot } from '#/agent/task/taskOutput';
import { sessionOccupiedError } from '#/persistence/interface/sessionLock';
import { ISessionRunGate } from '#/session/sessionActivity/sessionRunGate';
import { interactions } from '#/human/interaction/facade';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import type { AgentRunHandle } from '#/session/subagent/subagent';
import type { WireRecord } from '#/wire/record';
import {
  createTestAgent,
  execEnvServices,
  InMemoryWireRecordPersistence,
  sessionService,
  taskServices,
  type TestAgentContext,
} from '../../harness';
import { submitPromptTurn } from '../loop/stubs';
import { executeTool } from '../../tools/fixtures/execute-tool';
import {
  restoreTaskHistory,
  startAgentTaskInLoop,
  taskHistoryRecords,
  startBashTaskInLoop,
  startControlledTaskInLoop,
  startQuestionTaskInLoop,
  type ControlledTask,
  type ControlledTaskOptions,
} from './stubs';

const contexts: TestAgentContext[] = [];

function track(ctx: TestAgentContext): TestAgentContext {
  contexts.push(ctx);
  return ctx;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function immediateProcess(exitCode: number, stdoutText = ''): IHostProcess {
  return {
    _serviceBrand: undefined,
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from(stdoutText ? [stdoutText] : []),
    stderr: Readable.from([]),
    pid: 30000 + exitCode,
    exitCode,
    wait: vi.fn().mockResolvedValue(exitCode) as IHostProcess['wait'],
    kill: vi.fn().mockResolvedValue(undefined) as IHostProcess['kill'],
    dispose: vi.fn().mockResolvedValue(undefined) as IHostProcess['dispose'],
  };
}

function controllableProcess() {
  const stdout = new PassThrough();
  let resolveWait!: (code: number) => void;
  const waitPromise = new Promise<number>((resolve) => {
    resolveWait = resolve;
  });
  let currentExitCode: number | null = null;
  const proc: IHostProcess = {
    _serviceBrand: undefined,
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout,
    stderr: Readable.from([]),
    pid: 30001,
    get exitCode() {
      return currentExitCode;
    },
    wait: () => waitPromise,
    kill: vi.fn(async () => {
      if (currentExitCode !== null) return;
      currentExitCode = 143;
      stdout.destroy();
      resolveWait(143);
    }) as unknown as IHostProcess['kill'],
    dispose: vi.fn().mockResolvedValue(undefined) as IHostProcess['dispose'],
  };
  return {
    proc,
    write: (text: string) => stdout.write(text),
    finish: (exitCode: number) => {
      currentExitCode = exitCode;
      stdout.end();
      resolveWait(exitCode);
    },
  };
}

function processContext(proc: IHostProcess): TestAgentContext {
  return track(createTestAgent(execEnvServices({ processRunner: { spawn: async () => proc } })));
}

function agentContext(
  completion: Promise<{ readonly result: string }>,
  partialOutput = '',
): TestAgentContext {
  const ctx = track(createTestAgent());
  vi.spyOn(ctx.get(ISessionSubagentService), 'run').mockImplementation(async (agent) => ({
    agentId: agent.agentId,
    turn: {} as AgentRunHandle['turn'],
    completion: completion.then(({ result }) => ({ summary: result })),
    partialOutput: () => partialOutput,
  }));
  return ctx;
}

function startAgent(ctx: TestAgentContext, description: string) {
  return startAgentTaskInLoop(ctx, {
    description,
    prompt: description,
    run_in_background: true,
  });
}

function startControlled(ctx: TestAgentContext, options: ControlledTaskOptions = {}) {
  return startControlledTaskInLoop(ctx, options);
}

function taskNotifications(ctx: TestAgentContext, taskId?: string) {
  return ctx.context.history().filter((message) =>
    message.origin?.kind === 'task' && (taskId === undefined || message.origin.taskId === taskId)
  );
}

function liveTaskChanges(ctx: TestAgentContext): AgentTaskInfo[] {
  const changes: AgentTaskInfo[] = [];
  ctx.get(IAgentTaskService).onDidChangeTask((info) => changes.push(info));
  return changes;
}

async function drain(ctx: TestAgentContext, taskId: string): Promise<void> {
  await vi.waitFor(() => expect(taskNotifications(ctx, taskId)).toHaveLength(1), { timeout: 3000 });
  await ctx.get(IAgentLoopService).settled();
}

async function completeControlled(
  ctx: TestAgentContext,
  task: ControlledTask,
  output = '',
): Promise<void> {
  ctx.mockNextResponse({ type: 'text', text: 'notification ack' });
  task.resolve(output);
  await task.handler.wait();
  await drain(ctx, task.handler.taskId);
}

function processInfo(overrides: Partial<Extract<AgentTaskInfo, { kind: 'process' }>> = {}) {
  return {
    taskId: 'bash-done0000',
    kind: 'process',
    command: 'echo done',
    description: 'process done',
    pid: 4242,
    startedAt: 1,
    endedAt: 2,
    exitCode: 0,
    status: 'completed',
    detached: true,
    ...overrides,
  } as Extract<AgentTaskInfo, { kind: 'process' }>;
}

function agentInfo(overrides: Partial<Extract<AgentTaskInfo, { kind: 'agent' }>> = {}) {
  return {
    taskId: 'agent-done0000',
    kind: 'agent',
    agentId: 'agent-child',
    description: 'agent done',
    subagentType: 'coder',
    startedAt: 1,
    endedAt: 2,
    status: 'completed',
    detached: true,
    ...overrides,
  } as Extract<AgentTaskInfo, { kind: 'agent' }>;
}

const QUESTION_INPUT = {
  questions: [{
    question: 'Which database?',
    header: 'Storage',
    options: [
      { label: 'Postgres', description: 'Relational' },
      { label: 'SQLite', description: 'Embedded' },
    ],
    multi_select: false,
  }],
  background: true,
};

function recordInfo(record: WireRecord, key: 'taskId' | 'status'): unknown {
  return (record['info'] as Record<string, unknown> | undefined)?.[key];
}

function controlQuestions(ctx: TestAgentContext) {
  const sessionId = ctx.get(ISessionContext).sessionId;
  const pending = new Set<string>();
  const scan = (): void => {
    for (const request of interactions.findAll({ kind: 'question', resolved: false, tags: { sessionId } })) {
      pending.add(request.id);
    }
  };
  const subscription = interactions.onDidChangePending(scan);
  scan();
  return {
    answer(result: unknown) {
      for (const id of pending) interactions.respond(id, result);
      pending.clear();
    },
    dispose() {
      subscription();
      interactions.purgeSession(sessionId);
    },
  };
}

describe('AgentTaskService — event emission', () => {
  afterEach(async () => {
    vi.useRealTimers();
    for (const ctx of contexts.splice(0).reverse()) await ctx.dispose();
  });

  it('emits process task changes and persists only detached tasks', async () => {
    const sh = controllableProcess();
    const ctx = processContext(sh.proc);
    const changes = liveTaskChanges(ctx);
    const { handler } = await startBashTaskInLoop(ctx, { command: 'echo', description: 'process', run_in_background: false });
    await vi.waitFor(() => expect(changes).toHaveLength(1));
    expect(changes[0]).toMatchObject({
      taskId: handler.taskId,
      status: 'running',
      detached: false,
      parentToolCallId: handler.snapshot().id,
    });
    let records = await ctx.persistedWireRecords();
    expect(records.filter((record) => record.type === 'task.started' && recordInfo(record, 'taskId') === handler.taskId)).toEqual([]);
    expect(records.filter((record) => record.type === 'task.terminated' && recordInfo(record, 'taskId') === handler.taskId)).toEqual([]);

    sh.write('output only\n');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(changes).toHaveLength(1);
    ctx.get(IAgentTaskService).detach(handler.taskId);
    await vi.waitFor(() => expect(changes).toHaveLength(2));
    expect(changes[1]).toMatchObject({ status: 'running', detached: true });
    records = await ctx.persistedWireRecords();
    expect(records.filter((record) => record.type === 'task.started' && recordInfo(record, 'taskId') === handler.taskId)).toHaveLength(1);

    ctx.mockNextResponse({ type: 'text', text: 'done' });
    sh.finish(0);
    await handler.wait();
    await vi.waitFor(() => expect(changes.at(-1)).toMatchObject({ status: 'completed', detached: true }));
    const delivered = changes.length;
    await drain(ctx, handler.taskId);
    expect(changes).toHaveLength(delivered);
    records = await ctx.persistedWireRecords();
    expect(records.filter((record) => record.type === 'task.terminated' && recordInfo(record, 'taskId') === handler.taskId)).toHaveLength(1);

    const backgroundSh = controllableProcess();
    const backgroundCtx = processContext(backgroundSh.proc);
    const backgroundChanges = liveTaskChanges(backgroundCtx);
    const background = await startBashTaskInLoop(backgroundCtx, { command: 'echo', description: 'background', run_in_background: true });
    await vi.waitFor(() => expect(backgroundChanges).toHaveLength(1));
    expect(backgroundChanges[0]).toMatchObject({ status: 'running', detached: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(backgroundChanges).toHaveLength(1);
    backgroundCtx.mockNextResponse({ type: 'text', text: 'done' });
    backgroundSh.finish(0);
    await background.handler.wait();
    await drain(backgroundCtx, background.handler.taskId);
  });

  it('emits agent task changes and persists only detached tasks', async () => {
    const completion = deferred<{ result: string }>();
    const ctx = agentContext(completion.promise);
    const changes = liveTaskChanges(ctx);
    const { handler } = await startAgentTaskInLoop(ctx, {
      description: 'agent work',
      prompt: 'agent work',
      run_in_background: false,
    });
    await vi.waitFor(() => expect(changes).toHaveLength(1));
    expect(changes[0]).toMatchObject({
      taskId: handler.taskId,
      status: 'running',
      detached: false,
      parentToolCallId: handler.snapshot().id,
    });
    let records = await ctx.persistedWireRecords();
    expect(records.filter((record) => record.type === 'task.started' && recordInfo(record, 'taskId') === handler.taskId)).toEqual([]);
    expect(records.filter((record) => record.type === 'task.terminated' && recordInfo(record, 'taskId') === handler.taskId)).toEqual([]);

    ctx.get(IAgentTaskService).detach(handler.taskId);
    await vi.waitFor(() => expect(changes).toHaveLength(2));
    expect(changes[1]).toMatchObject({ status: 'running', detached: true });
    records = await ctx.persistedWireRecords();
    expect(records.filter((record) => record.type === 'task.started' && recordInfo(record, 'taskId') === handler.taskId)).toHaveLength(1);

    ctx.mockNextResponse({ type: 'text', text: 'done' });
    completion.resolve({ result: 'done' });
    await handler.wait();
    await vi.waitFor(() => expect(changes.at(-1)).toMatchObject({ status: 'completed', detached: true }));
    const delivered = changes.length;
    await drain(ctx, handler.taskId);
    expect(changes).toHaveLength(delivered);
    records = await ctx.persistedWireRecords();
    expect(records.filter((record) => record.type === 'task.terminated' && recordInfo(record, 'taskId') === handler.taskId)).toHaveLength(1);

    const backgroundCompletion = deferred<{ result: string }>();
    const backgroundCtx = agentContext(backgroundCompletion.promise);
    const backgroundChanges = liveTaskChanges(backgroundCtx);
    const background = await startAgent(backgroundCtx, 'background agent');
    await vi.waitFor(() => expect(backgroundChanges).toHaveLength(1));
    expect(backgroundChanges[0]).toMatchObject({ status: 'running', detached: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(backgroundChanges).toHaveLength(1);
    backgroundCtx.mockNextResponse({ type: 'text', text: 'done' });
    backgroundCompletion.resolve({ result: 'done' });
    await background.handler.wait();
    await drain(backgroundCtx, background.handler.taskId);
  });

  it('tracks natural exit telemetry with one terminal record', async () => {
    const sh = controllableProcess();
    const ctx = processContext(sh.proc);
    const { handler } = await startBashTaskInLoop(ctx, { command: 'echo', description: 'process', run_in_background: true });
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    sh.write('done\n');
    sh.finish(0);
    await handler.wait();
    await drain(ctx, handler.taskId);
    const records = await ctx.persistedWireRecords();
    expect(records.filter((record) => record.type === 'task.terminated' && recordInfo(record, 'taskId') === handler.taskId)).toHaveLength(1);
    expect(records.at(-1)).toBeDefined();
  });

  it('tracks failed and timed-out terminal statuses', async () => {
    const failedProcess = immediateProcess(1);
    const failedCtx = processContext(failedProcess);
    const { handler: failed } = await startBashTaskInLoop(failedCtx, { command: 'false', description: 'failed', run_in_background: true });
    await failed.wait();
    const timedCtx = track(createTestAgent());
    const timed = await startControlled(timedCtx, { timeoutMs: 0 });
    await timed.handler.wait();
    expect((await failedCtx.persistedWireRecords()).some((record) => record.type === 'task.terminated' && recordInfo(record, 'status') === 'failed')).toBe(true);
    expect((await timedCtx.persistedWireRecords()).some((record) => record.type === 'task.terminated' && recordInfo(record, 'status') === 'timed_out')).toBe(true);
  });

  it('stops a task with one terminal record', async () => {
    const ctx = track(createTestAgent());
    const task = await startControlled(ctx);
    await ctx.get(IAgentTaskService).stop(task.handler.taskId, 'stop now');
    const records = await ctx.persistedWireRecords();
    expect(records.filter((record) => record.type === 'task.terminated' && recordInfo(record, 'taskId') === task.handler.taskId)).toHaveLength(1);
  });

  it('marks restored running history lost without dispatching task.terminated', async () => {
    const ctx = track(createTestAgent(taskServices()));
    const running = agentInfo({ status: 'running', endedAt: null });
    ctx.mockNextResponse({ type: 'text', text: 'lost task acknowledged' });
    await restoreTaskHistory(ctx, [running]);
    await drain(ctx, running.taskId);
    expect(ctx.get(IAgentTaskService).getTask(running.taskId)?.status).toBe('lost');
    expect((await ctx.persistedWireRecords()).filter((record) => record.type === 'task.terminated')).toEqual([]);
  });
});

describe('AgentTaskService — notification delivery', () => {
  afterEach(async () => {
    for (const ctx of contexts.splice(0).reverse()) await ctx.dispose();
  });

  it('delivers completed agent task notifications through an auto-launched turn', async () => {
    const completion = deferred<{ result: string }>();
    const ctx = agentContext(completion.promise);
    const { handler } = await startAgent(ctx, 'inspect repository');
    ctx.mockNextResponse({ type: 'text', text: 'notification ack' });
    completion.resolve({ result: 'final agent output' });
    await handler.wait();
    await drain(ctx, handler.taskId);
    expect(JSON.stringify(taskNotifications(ctx, handler.taskId))).toContain('<output-file');
    expect(await ctx.get(IAgentTaskService).readOutput(handler.taskId)).toContain('final agent output');
  });

  it('inlines the answer in completed question task notifications', async () => {
    const ctx = track(createTestAgent());
    const questions = controlQuestions(ctx);
    try {
      const { handler } = await startQuestionTaskInLoop(ctx, QUESTION_INPUT);
        ctx.mockNextResponse({ type: 'text', text: 'notification ack' });
      questions.answer({ Postgres: true });
      await handler.wait();
      await drain(ctx, handler.taskId);
      expect(JSON.stringify(taskNotifications(ctx, handler.taskId))).toContain('Postgres');
      expect(JSON.stringify(taskNotifications(ctx, handler.taskId))).toContain('answers');
    } finally {
      questions.dispose();
    }
  });

  it('reports a dismissed question task without an output file', async () => {
    const ctx = track(createTestAgent());
    const questions = controlQuestions(ctx);
    try {
      const { handler } = await startQuestionTaskInLoop(ctx, QUESTION_INPUT);
        ctx.mockNextResponse({ type: 'text', text: 'notification ack' });
      questions.answer(null);
      await handler.wait();
      await drain(ctx, handler.taskId);
      const text = JSON.stringify(taskNotifications(ctx, handler.taskId));
      expect(text).toContain('dismissed');
      expect(text).not.toContain('output-file');
    } finally {
      questions.dispose();
    }
  });

  it('keeps the generic wording for question output that is not an answer payload', async () => {
    const ctx = track(createTestAgent());
    const task = await startControlled(ctx);
    await completeControlled(ctx, task, 'not an answer payload');
    expect(JSON.stringify(taskNotifications(ctx, task.handler.taskId))).toContain('not an answer payload');
  });

  it('reports a failed question task with its reason and no answer block', async () => {
    const ctx = track(createTestAgent());
    const completion = deferred<never>();
    const task = await startControlled(ctx, { completion: completion.promise });
    completion.reject(new Error('question failed'));
    ctx.mockNextResponse({ type: 'text', text: 'notification ack' });
    await task.handler.wait();
    await drain(ctx, task.handler.taskId);
    const text = JSON.stringify(taskNotifications(ctx, task.handler.taskId));
    expect(text).toContain('question failed');
    expect(text).not.toContain('[answers]');
  });

  it('enqueues completed process task notifications into the turn flow', async () => {
    const sh = controllableProcess();
    const ctx = processContext(sh.proc);
    const { handler } = await startBashTaskInLoop(ctx, { command: 'echo', description: 'process', run_in_background: true });
    ctx.mockNextResponse({ type: 'text', text: 'notification ack' });
    sh.write('process output\n');
    sh.finish(0);
    await handler.wait();
    await drain(ctx, handler.taskId);
    expect(JSON.stringify(taskNotifications(ctx, handler.taskId))).toContain('<output-file');
    expect(await ctx.get(IAgentTaskService).readOutput(handler.taskId)).toContain('process output');
  });

  it('enqueues stopped process task notifications into the turn flow', async () => {
    const sh = controllableProcess();
    const ctx = processContext(sh.proc);
    const { handler } = await startBashTaskInLoop(ctx, { command: 'sleep', description: 'process', run_in_background: true });
    ctx.mockNextResponse({ type: 'text', text: 'notification ack' });
    await ctx.get(IAgentTaskService).stop(handler.taskId, 'stop now');
    await drain(ctx, handler.taskId);
    expect(JSON.stringify(taskNotifications(ctx, handler.taskId))).toContain(handler.taskId);
  });

  it('TaskStopTool does not suppress the real terminal notification', async () => {
    const ctx = track(createTestAgent());
    const task = await startControlled(ctx);
    ctx.mockNextResponse({ type: 'text', text: 'notification ack' });
    const result = await executeTool(ctx.get(ITaskStopTool), {
      turnId: 0,
      toolCallId: 'stop-call',
      args: { task_id: task.handler.taskId, reason: 'model requested stop' },
      signal: new AbortController().signal,
    });
    expect(result.isError ?? false).toBe(false);
    await drain(ctx, task.handler.taskId);
    expect(taskNotifications(ctx, task.handler.taskId)).toHaveLength(1);
  });

  it('TaskStopTool persists stop reason across reload', async () => {
    const ctx = track(createTestAgent());
    const task = await startControlled(ctx);
    await executeTool(ctx.get(ITaskStopTool), {
      turnId: 0,
      toolCallId: 'stop-call',
      args: { task_id: task.handler.taskId, reason: 'persist this reason' },
      signal: new AbortController().signal,
    });
    await completeControlled(ctx, task);
    expect(JSON.stringify(await ctx.persistedWireRecords())).toContain('persist this reason');
    await ctx.expectResumeMatches();
  });

  it('TaskStopTool returns only stop status while partial output remains readable', async () => {
    const ctx = track(createTestAgent());
    const task = await startControlled(ctx);
    task.write('partial agent output');
    const result = await executeTool(ctx.get(ITaskStopTool), {
      turnId: 0,
      toolCallId: 'stop-call',
      args: { task_id: task.handler.taskId },
      signal: new AbortController().signal,
    });
    expect(JSON.stringify(result)).not.toContain('partial agent output');
    await completeControlled(ctx, task);
    expect(await ctx.get(IAgentTaskService).readOutput(task.handler.taskId)).toContain('partial agent output');
  });

  it('TaskStopTool reports no text when a stopped agent task wrote none', async () => {
    const ctx = track(createTestAgent());
    const task = await startControlled(ctx);
    await executeTool(ctx.get(ITaskStopTool), {
      turnId: 0,
      toolCallId: 'stop-call',
      args: { task_id: task.handler.taskId },
      signal: new AbortController().signal,
    });
    await completeControlled(ctx, task);
    expect(await ctx.get(IAgentTaskService).readOutput(task.handler.taskId)).toBe('');
  });

  it('TaskStopTool keeps the full result when the agent completes before the stop lands', async () => {
    const ctx = track(createTestAgent());
    const task = await startControlled(ctx, { completion: Promise.resolve('complete result') });
    await task.handler.wait();
    const info = await ctx.get(IAgentTaskService).stop(task.handler.taskId);
    expect(info?.status).toBe('completed');
    await completeControlled(ctx, task);
    expect(JSON.stringify(taskNotifications(ctx, task.handler.taskId))).toContain('complete result');
  });

  it('keeps a stopped agent task partial output readable after reload', async () => {
    const ctx = track(createTestAgent());
    const task = await startControlled(ctx);
    task.write('persisted partial output');
    await ctx.get(IAgentTaskService).stop(task.handler.taskId);
    await completeControlled(ctx, task);
    await ctx.expectResumeMatches();
    expect(await ctx.get(IAgentTaskService).readOutput(task.handler.taskId)).toContain('persisted partial output');
  });

  it('restores terminal agent task notifications once after a prompt-only crash and session lock retry', async () => {
    const info = agentInfo();
    const notificationId = `task:${info.taskId}:${info.status}`;
    const crashCtx = track(createTestAgent(taskServices()));
    crashCtx.mockNextResponse({ type: 'text', text: 'restored agent ack' });
    await restoreTaskHistory(crashCtx, [info], 'main', [{
      type: 'turn.prompt',
      agentId: 'main',
      origin: {
        kind: 'task', taskId: info.taskId, status: info.status, notificationId,
      },
      promptId: notificationId,
      turnId: 0,
      trigger: 'notify',
      input: [{ type: 'text', text: 'notification prompt' }],
    } as unknown as WireRecord]);
    await crashCtx.get(IAgentLoopService).settled();
    expect(taskNotifications(crashCtx, info.taskId)).toHaveLength(1);
    expect(JSON.stringify(taskNotifications(crashCtx, info.taskId))).toContain('<notification');

    const seeded = track(createTestAgent(taskServices()));
    await seeded.restorePersisted();
    const records = [
      ...await seeded.persistedWireRecords(),
      ...taskHistoryRecords([info]),
    ];
    let occupied = true;
    const release = vi.fn();
    const begin = () => {
      if (occupied) throw sessionOccupiedError('test-session');
    };
    const ctx = track(createTestAgent(
      taskServices(),
      sessionService(ISessionRunGate, {
        _serviceBrand: undefined,
        begin,
        acquire: () => {
          begin();
          return { sessionId: 'test-session', release };
        },
      }),
      { persistence: new InMemoryWireRecordPersistence(records) },
    ));
    const loop = ctx.get(IAgentLoopService);
    const createCompletion = vi.spyOn(ctx.get(IAgentTaskOutputService), 'createCompletion');
    ctx.mockNextResponse({ type: 'text', text: 'restored agent ack' });

    await expect(ctx.restorePersisted()).rejects.toMatchObject({ code: ErrorCodes.SESSION_OCCUPIED });
    expect((loop as unknown as { loop?: unknown }).loop).toBeUndefined();
    expect(createCompletion).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(taskNotifications(ctx, info.taskId)).toEqual([]);
    expect(ctx.llmCalls).toEqual([]);
    expect((await ctx.persistedWireRecords()).filter((record) => record.type === 'turn.prompt')).toEqual([]);

    occupied = false;
    await loop.start();
    await loop.settled();
    await loop.start();
    await loop.settled();

    expect(createCompletion).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.invocationCallOrder[0]).toBeGreaterThan(createCompletion.mock.invocationCallOrder[0]!);
    expect(taskNotifications(ctx, info.taskId)).toHaveLength(1);
    expect(JSON.stringify(taskNotifications(ctx, info.taskId))).toContain('<notification');
    expect((await ctx.persistedWireRecords()).filter((record) =>
      record.type === 'turn.prompt' &&
      (record['origin'] as { kind?: string } | undefined)?.kind === 'task'
    )).toHaveLength(1);
  });

  it('replays restored terminal process task notifications when undelivered', async () => {
    const ctx = track(createTestAgent(taskServices()));
    const outputPath = join(
      ctx.get(ISessionContext).sessionDir,
      'agents',
      ctx.get(IAgentScopeContext).agentId,
      'tasks',
      'bash-done0000',
      'output.log',
    );
    await ctx.get(IAgentTaskOutputService).appendTaskOutput('bash-done0000', 'restored shell output');
    ctx.mockNextResponse({ type: 'text', text: 'restored process ack' });
    await restoreTaskHistory(ctx, [processInfo()]);
    await ctx.get(IAgentLoopService).settled();
    const text = JSON.stringify(taskNotifications(ctx, 'bash-done0000'));
    expect(taskNotifications(ctx, 'bash-done0000')).toHaveLength(1);
    expect(text).toContain('Background process completed');
    expect(text).toContain('<output-file');
    expect(text).toContain(outputPath);
    expect(text).not.toContain('restored shell output');
  });

  it('references persisted output without inlining a restored process output tail', async () => {
    const ctx = track(createTestAgent(taskServices()));
    await ctx.get(IAgentTaskOutputService).appendTaskOutput('bash-done0000', 'secret full output');
    ctx.mockNextResponse({ type: 'text', text: 'restored output ack' });
    await restoreTaskHistory(ctx, [processInfo()]);
    await ctx.get(IAgentLoopService).settled();
    const text = JSON.stringify(taskNotifications(ctx, 'bash-done0000'));
    expect(text).toContain('output-file');
    expect(text).not.toContain('secret full output');
  });

  it('does not replay restored notifications already present in history', async () => {
    const ctx = track(createTestAgent(taskServices()));
    const info = processInfo();
    const preceding = [{
      type: 'context.append_message',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'already delivered' }],
        toolCalls: [],
        origin: {
          kind: 'task', taskId: info.taskId, status: 'completed', notificationId: `task:${info.taskId}:completed`,
        },
      },
    } as unknown as WireRecord];
    await restoreTaskHistory(ctx, [info], 'main', preceding);
    ctx.get(IAgentLoopService).flushReminders();
    expect(taskNotifications(ctx, info.taskId)).toHaveLength(1);
  });

  it('does not re-deliver a terminal task notification removed by undo when output is unavailable', async () => {
    const ctx = track(createTestAgent());
    const task = await startControlled(ctx);
    await completeControlled(ctx, task);
    await ctx.get(IAgentConversationUndoService).undo(1);
    await ctx.get(IAgentLoopService).settled();
    expect(taskNotifications(ctx, task.handler.taskId)).toHaveLength(0);
    expect(taskNotifications(ctx)).toHaveLength(0);
  });

  it('preserves a queued notification when undo rejects an active turn', async () => {
    const ctx = track(createTestAgent());
    const loop = ctx.get(IAgentLoopService);
    const task = await startControlled(ctx);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release!: () => void;
    const canFinish = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hook = loop.hooks.onWillBeginStep.register('test-notification-undo', async (_hookCtx, next) => {
      markStarted();
      await canFinish;
      await next();
    });
    try {
      ctx.appendTurnExchange('kept prompt', 'kept answer');
      const active = submitPromptTurn(loop, {
        message: { role: 'user', content: [{ type: 'text', text: 'remove me' }] },
        meta: { origin: { kind: 'user' } },
      }).turn;
      await started;
      task.resolve('done');
      await task.handler.wait();
      expect(loop.snapshot().hasPendingRequests).toBe(true);
      expect(taskNotifications(ctx, task.handler.taskId)).toEqual([]);

      await expect(ctx.get(IAgentConversationUndoService).undo(1)).rejects.toMatchObject({
        code: ErrorCodes.SESSION_BUSY,
        details: { reason: 'loop' },
      });
      expect(active.signal.aborted).toBe(false);

      ctx.mockNextResponse({ type: 'text', text: 'notification acknowledged' });
      ctx.mockNextResponse({ type: 'text', text: 'turn completed' });
      release();
      await expect(active.result).resolves.toMatchObject({ type: 'completed' });
      await drain(ctx, task.handler.taskId);
    } finally {
      release();
      hook.dispose();
    }
  });

  it('does not double-notify newly lost restored agent tasks', async () => {
    const ctx = track(createTestAgent(taskServices()));
    const running = agentInfo({ status: 'running', endedAt: null });
    ctx.mockNextResponse({ type: 'text', text: 'lost task acknowledged' });
    await restoreTaskHistory(ctx, [running]);
    await drain(ctx, running.taskId);
    await ctx.restore(await ctx.persistedWireRecords());
    await drain(ctx, running.taskId);
    expect((await ctx.persistedWireRecords()).filter((record) => record.type === 'task.terminated')).toEqual([]);
  });

  it('does not repeat a restored lost-task notification already present in history', async () => {
    const ctx = track(createTestAgent(taskServices()));
    const info = agentInfo({ status: 'lost' });
    const preceding = [{
      type: 'context.append_message',
      message: {
        role: 'user',
        content: [{ type: 'text', text: '<notification>agent done lost.</notification>' }],
        toolCalls: [],
        origin: {
          kind: 'task', taskId: info.taskId, status: 'lost', notificationId: `task:${info.taskId}:lost`,
        },
      },
    } as unknown as WireRecord];
    await restoreTaskHistory(ctx, [info], 'main', preceding);
    await restoreTaskHistory(ctx, [info], 'main', preceding);
    expect(taskNotifications(ctx, info.taskId)).toHaveLength(1);
  });

  it('does not duplicate a delivered legacy lost-task notification', async () => {
    const ctx = track(createTestAgent(taskServices()));
    const info = agentInfo({ status: 'lost' });
    const preceding = [{
      type: 'context.append_message',
      message: {
        role: 'user',
        content: [{ type: 'text', text: '<notification>agent done lost.</notification>' }],
        toolCalls: [],
        origin: {
          kind: 'task', taskId: info.taskId, status: 'lost', notificationId: `task:${info.taskId}:lost`,
        },
      },
    } as unknown as WireRecord];
    await restoreTaskHistory(ctx, [info], 'main', preceding);
    expect(taskNotifications(ctx, info.taskId)).toHaveLength(1);
  });

  it('restores a lost notification without synthesizing task termination', async () => {
    const ctx = track(createTestAgent(taskServices()));
    const running = agentInfo({ status: 'running', endedAt: null });
    ctx.mockNextResponse({ type: 'text', text: 'lost task acknowledged' });
    await restoreTaskHistory(ctx, [running]);
    await drain(ctx, running.taskId);
    expect((await ctx.persistedWireRecords()).filter((record) => record.type === 'task.terminated')).toEqual([]);
  });

  it('emits an observable append when an agent task notification is delivered', async () => {
    const ctx = track(createTestAgent());
    const appended: unknown[] = [];
    ctx.get(IEventBus).subscribe(ContextAppendMessage, (event) => {
      if (event.message.origin?.kind === 'task') appended.push(event);
    });
    const task = await startControlled(ctx);
    await completeControlled(ctx, task);
    expect(appended).toHaveLength(1);
    expect(JSON.stringify(appended[0])).toContain(task.handler.taskId);
  });

  it('does not let an append subscriber failure interrupt notification delivery', async () => {
    const ctx = track(createTestAgent());
    ctx.get(IEventBus).subscribe(ContextAppendMessage, () => {
      throw new Error('append subscriber failed');
    });
    const task = await startControlled(ctx);
    await completeControlled(ctx, task);
    expect(taskNotifications(ctx, task.handler.taskId)).toHaveLength(1);
  });

  it('emits observable appends for process task notifications', async () => {
    const sh = controllableProcess();
    const ctx = processContext(sh.proc);
    const appended: unknown[] = [];
    ctx.get(IEventBus).subscribe(ContextAppendMessage, (event) => {
      if (event.message.origin?.kind === 'task') appended.push(event);
    });
    const { handler } = await startBashTaskInLoop(ctx, { command: 'echo', description: 'done', run_in_background: true });
    ctx.mockNextResponse({ type: 'text', text: 'notification ack' });
    sh.finish(0);
    await handler.wait();
    await drain(ctx, handler.taskId);
    expect(appended).toHaveLength(1);
    expect(JSON.stringify(appended[0])).toContain(handler.taskId);
  });
});

describe('AgentTaskService — agent recovery notification bodies', () => {
  it('failed agent task body includes resume instructions with the correct agent_id', () => {
    const entry = createTaskCompletionEntry(
      agentInfo({ status: 'failed', stopReason: 'subagent crashed', agentId: 'agent-7' }),
      'call-agent',
      emptyOutputSnapshot(),
    );
    const text = entry.message.content.map((part) => part.type === 'text' ? part.text : '').join('');
    expect(text).toContain('agent_id="agent-7"');
    expect(text).toMatch(/Agent\(resume="agent-7"/);
    expect(text).toMatch(/agent_id.*NOT source_id|source_id.*NOT agent_id/);
  });

  it('completed agent task body does not add resume instructions', () => {
    const entry = createTaskCompletionEntry(
      agentInfo({ agentId: 'agent-8' }),
      'call-agent',
      emptyOutputSnapshot(),
    );
    const text = entry.message.content.map((part) => part.type === 'text' ? part.text : '').join('');
    expect(text).toContain('agent_id="agent-8"');
    expect(text).not.toMatch(/Agent\(resume="agent-8"/);
  });

  it('process task body never mentions resume', () => {
    const info = processInfo({ status: 'failed', exitCode: 1 });
    const entry = createTaskCompletionEntry(info, 'call-process', emptyOutputSnapshot());
    const text = entry.message.content.map((part) => part.type === 'text' ? part.text : '').join('');
    expect(text).not.toContain('agent_id=');
    expect(text).not.toMatch(/Agent\(resume=/);
    expect(text).toContain(`source_id="${info.taskId}"`);
  });
});
