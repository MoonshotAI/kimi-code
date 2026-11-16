import { afterEach, describe, expect, it, vi } from 'vitest';

import { IAgentTaskService, type AgentTaskInfo } from '#/agent/task/task';
import { renderNotificationXml } from '#/agent/task/notificationXml';
import { AgentTaskPersistence } from '#/agent/task/persist';
import { agentTaskInfo, type AgentTaskFields } from '#/agent/task/handler';
import {
  AgentTaskRequestService,
  AgentTaskService,
  type IAgentTaskHistoryService,
} from '#/agent/task/taskService';
import type { AgentToolExecutionHandler } from '#/agent/toolExecutor/toolExecutor';
import type { ToolExecutionStatus } from '#/tool/executor';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import {
  createTaskChannel,
  startControlledTask,
  taskHistoryRecords,
  type TaskChannel,
} from './stubs';

function projectionHandler(
  fields: AgentTaskFields,
  status: ToolExecutionStatus = 'success',
): AgentToolExecutionHandler {
  const running = status === 'running' || status === 'stopping';
  return {
    snapshot: () => ({
      id: 'call-question',
      taskId: 'bash-task01',
      name: 'Bash',
      status,
      phase: 'execute',
      args: {},
      detached: true,
      fields: { task: fields },
      timing: {
        total: { startedAt: 10, endedAt: running ? null : 20, elapsedMs: 10 },
        execute: { startedAt: 10, endedAt: running ? null : 20, elapsedMs: 10 },
      },
    }),
  } as unknown as AgentToolExecutionHandler;
}

function restoredTaskService(
  channel: TaskChannel,
  infos: readonly AgentTaskInfo[],
  agentId = 'main',
): { readonly manager: IAgentTaskService; readonly history: IAgentTaskHistoryService } {
  const reduced = new AgentTaskService(agentId);
  reduced.restore(taskHistoryRecords(infos, agentId));
  const history: IAgentTaskHistoryService = {
    _serviceBrand: undefined,
    getTask: (taskId) => reduced.get(taskId),
    list: (activeOnly, limit) => reduced.list(activeOnly, limit),
    values: () => reduced.values(),
    reconcile: async () => {},
  };
  return {
    history,
    manager: new AgentTaskRequestService(channel.toolExecutor, history, channel.outputs),
  };
}

function processInfo(overrides: Partial<AgentTaskInfo> = {}): AgentTaskInfo {
  return {
    taskId: 'bash-abcdef01',
    kind: 'process',
    command: 'sleep 60',
    description: 'process work',
    pid: 4242,
    startedAt: 1,
    endedAt: null,
    exitCode: null,
    status: 'running',
    detached: true,
    ...overrides,
  } as AgentTaskInfo;
}

describe('AgentTaskService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists, reads, stops and projects real handler task info', async () => {
    const channel = createTaskChannel();
    const svc = channel.service;
    const task = await startControlledTask(channel);
    const id = task.handler.taskId;
    expect(svc.list().map((info) => info.taskId)).toContain(id);
    expect(await svc.readOutput(id)).toBe('');
    await svc.stop(id);

    expect(agentTaskInfo(projectionHandler({
      kind: 'process', description: 'process work', command: 'sleep 1', pid: 123, exitCode: 0,
      parentToolCallId: 'call-process',
    }))).toMatchObject({
      taskId: 'bash-task01', kind: 'process', description: 'process work', status: 'completed',
      detached: true, startedAt: 10, endedAt: 20, command: 'sleep 1', pid: 123, exitCode: 0,
      parentToolCallId: 'call-process',
    });
    expect(agentTaskInfo(projectionHandler({
      kind: 'agent', description: 'agent work', agentId: 'agent-1', subagentType: 'explore',
      model: 'k2', thinkingEffort: 'high', timedOut: true, stopReason: 'deadline', stopCode: 'TASK_TIMEOUT',
    }, 'failed'))).toMatchObject({
      kind: 'agent', status: 'timed_out', agentId: 'agent-1', subagentType: 'explore', model: 'k2',
      thinkingEffort: 'high', stopReason: 'deadline', stopCode: 'TASK_TIMEOUT',
    });
    expect(agentTaskInfo(projectionHandler({
      kind: 'question', description: 'question work', questionCount: 2, stopReason: 'cancelled',
    }, 'aborted'))).toMatchObject({
      kind: 'question', status: 'killed', questionCount: 2, toolCallId: 'call-question', stopReason: 'cancelled',
    });
    expect(agentTaskInfo(projectionHandler({
      kind: 'process', description: 'still running', command: 'sleep 10', pid: 456, exitCode: null,
    }, 'running'))).toMatchObject({ status: 'running', endedAt: null });
  });

  it('wait with a timeout beyond the timer ceiling does not resolve immediately', async () => {
    const channel = createTaskChannel();
    const svc = channel.service;
    const task = await startControlledTask(channel);
    const waited = svc.wait(task.handler.taskId, 10 * 365 * 24 * 3600 * 1000);
    const early = await Promise.race([
      waited.then(() => 'returned' as const),
      new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 50)),
    ]);
    expect(early).toBe('waiting');
    await svc.stop(task.handler.taskId);
    await expect(waited).resolves.toMatchObject({ taskId: task.handler.taskId });
  });

  it('creates a terminal completion from real handler output', async () => {
    const channel = createTaskChannel();
    const task = await startControlledTask(channel, { output: 'finished output', completion: Promise.resolve('') });
    const info = await channel.service.wait(task.handler.taskId);
    if (info === undefined) throw new Error('missing task info');
    const completion = await channel.outputs.createCompletion(info, task.handler.snapshot().id);
    expect(JSON.stringify(completion)).toContain('task.completed');
    expect(JSON.stringify(completion)).toContain(task.handler.taskId);
    expect(JSON.stringify(completion)).toContain('finished output');
  });

  it('does not suppress a terminal completion after WaitFor returns', async () => {
    const channel = createTaskChannel();
    const task = await startControlledTask(channel, { completion: Promise.resolve('done') });
    const info = await channel.service.wait(task.handler.taskId);
    if (info === undefined) throw new Error('missing task info');
    const completion = await channel.outputs.createCompletion(info, task.handler.snapshot().id);
    expect(completion.attributes?.origin).toMatchObject({ kind: 'task', taskId: task.handler.taskId });
  });

  it('cancels only the wait signal without stopping or suppressing the task', async () => {
    const channel = createTaskChannel();
    const task = await startControlledTask(channel);
    const controller = new AbortController();
    const waiting = channel.service.wait(task.handler.taskId, undefined, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow();
    expect(channel.service.getTask(task.handler.taskId)?.status).toBe('running');
    task.resolve('done');
    const info = await channel.service.wait(task.handler.taskId);
    if (info === undefined) throw new Error('missing task info');
    expect(await channel.outputs.createCompletion(info, task.handler.snapshot().id)).toBeDefined();
  });

  it('keeps independent completion construction for separate tasks', async () => {
    const channel = createTaskChannel();
    const first = await startControlledTask(channel, { completion: Promise.resolve('a') });
    const second = await startControlledTask(channel, { completion: Promise.resolve('b') });
    const infos = await Promise.all([
      channel.service.wait(first.handler.taskId),
      channel.service.wait(second.handler.taskId),
    ]);
    const completions = await Promise.all(infos.map((info, index) =>
      channel.outputs.createCompletion(info!, index === 0 ? first.handler.snapshot().id : second.handler.snapshot().id)
    ));
    expect(completions.map((entry) => entry.attributes?.origin)).toEqual([
      expect.objectContaining({ taskId: first.handler.taskId }),
      expect.objectContaining({ taskId: second.handler.taskId }),
    ]);
  });

  it('does not consume completion when TaskOutput reads a snapshot', async () => {
    const channel = createTaskChannel();
    const task = await startControlledTask(channel, { output: 'readable', completion: Promise.resolve('') });
    const info = await channel.service.wait(task.handler.taskId);
    expect((await channel.service.getOutputSnapshot(task.handler.taskId, 100)).preview).toContain('readable');
    expect(await channel.outputs.createCompletion(info!, task.handler.snapshot().id)).toBeDefined();
  });

  it('unwinds nested wait chains leaf-first without deadlocking', async () => {
    const channel = createTaskChannel();
    const leaf = await startControlledTask(channel);
    const parent = await startControlledTask(channel);
    const leafWait = channel.service.wait(leaf.handler.taskId);
    const parentWait = channel.service.wait(parent.handler.taskId);
    leaf.resolve('leaf');
    expect((await leafWait)?.status).toBe('completed');
    parent.resolve('parent');
    expect((await parentWait)?.status).toBe('completed');
  });

  it('returns undefined for a task owned by another agent instead of waiting forever', async () => {
    const channel = createTaskChannel();
    const other = restoredTaskService(channel, [], 'agent-other').manager;
    await expect(other.wait('bash-deadbeef', 0)).resolves.toBeUndefined();
  });

  it('stops every live handler explicitly and leaves no active tasks', async () => {
    const channel = createTaskChannel();
    await startControlledTask(channel);
    await startControlledTask(channel, { detached: false });
    await Promise.all(channel.service.list(true).map((info) => channel.service.stop(info.taskId)));
    expect(channel.service.list(true)).toEqual([]);
  });

  it('keeps a completed foreground-only task out of background history', async () => {
    const channel = createTaskChannel();
    const task = await startControlledTask(channel, { detached: false, completion: Promise.resolve('done') });
    await channel.service.wait(task.handler.taskId);
    expect(channel.service.list(false)).toEqual([]);
  });

  it('stops tasks when output persistence is unavailable', async () => {
    const channel = createTaskChannel({ outputPersistenceAvailable: false });
    const task = await startControlledTask(channel);
    expect((await channel.service.stop(task.handler.taskId))?.status).toBe('killed');
  });

  it('coalesces task changes, ignores output, and cancels queued events on dispose', async () => {
    const channel = createTaskChannel();
    const changes: AgentTaskInfo[] = [];
    channel.service.onDidChangeTask((info) => changes.push(info));
    const task = await startControlledTask(channel, { detached: false });
    await vi.waitFor(() => expect(changes).toHaveLength(1));
    expect(changes[0]).toMatchObject({ status: 'running', detached: false });

    task.write('output only');
    task.handler.detach();
    task.handler.detach();
    channel.toolExecutor.release(task.handler.taskId);
    await vi.waitFor(() => expect(changes).toHaveLength(2));
    expect(changes[1]).toMatchObject({ status: 'running', detached: true });

    const queued = await startControlledTask(channel, { detached: false });
    await vi.waitFor(() => expect(changes).toHaveLength(3));
    queued.handler.detach();
    (channel.service as AgentTaskRequestService).dispose();
    task.resolve('released');
    queued.resolve('disposed');
    await Promise.all([task.handler.wait(), queued.handler.wait()]);
    await Promise.resolve();
    expect(changes).toHaveLength(3);
  });

  it('falls back to Wire history after the live handler is released', async () => {
    const channel = createTaskChannel();
    const task = await startControlledTask(channel, { completion: Promise.resolve('done') });
    const info = await channel.service.wait(task.handler.taskId);
    if (info === undefined) throw new Error('missing task info');
    const restored = restoredTaskService(channel, [info]).manager;
    expect(restored.getTask(task.handler.taskId)?.status).toBe('completed');
    channel.toolExecutor.release(task.handler.taskId);
    expect(restored.getTask(task.handler.taskId)).toMatchObject({ status: 'completed' });
  });

  it('stop is idempotent for a terminal handler', async () => {
    const channel = createTaskChannel();
    const task = await startControlledTask(channel);
    await channel.service.stop(task.handler.taskId, 'first');
    expect((await channel.service.stop(task.handler.taskId, 'second'))?.status).toBe('killed');
  });

  it('restores terminal history without rebuilding wait-delivery keys', async () => {
    const channel = createTaskChannel();
    const info = processInfo({ status: 'completed', endedAt: 2, exitCode: 0 });
    const restored = restoredTaskService(channel, [info]).manager;
    expect(restored.getTask(info.taskId)).toEqual(info);
    expect(restored.list(true)).toEqual([]);
  });

  it('restore touches only the agent own task records', () => {
    const own = new AgentTaskService('agent-1');
    own.restore(taskHistoryRecords([processInfo()], 'agent-1'));
    const other = new AgentTaskService('main');
    other.restore(taskHistoryRecords([processInfo()], 'agent-1'));
    expect(own.list(false)[0]).toMatchObject({ status: 'lost' });
    expect(other.list(false)).toEqual([]);
  });

  it('main restore claims a previous v2 session task with its legacy output path', async () => {
    const bytes = new InMemoryStorageService();
    const sessionScope = 'sessions/test-ws/test-session';
    const taskId = 'bash-legacy01';
    const info = processInfo({ taskId, status: 'completed', endedAt: 2, exitCode: 0 });
    await bytes.write(`${sessionScope}/tasks/${taskId}`, 'output.log', new TextEncoder().encode('legacy output'));
    const persistence = new AgentTaskPersistence(
      '/tmp/test-session/agents/main',
      `${sessionScope}/agents/main`,
      bytes,
      { dir: '/tmp/test-session', scope: sessionScope },
    );
    const channel = createTaskChannel({ persistence });
    const main = restoredTaskService(channel, [info]).manager;

    expect(main.list(false)).toEqual([expect.objectContaining({ taskId, status: 'completed' })]);
    expect(await main.getOutputSnapshot(taskId, 100)).toEqual({
      outputPath: `/tmp/test-session/tasks/${taskId}/output.log`,
      outputSizeBytes: 13,
      previewBytes: 13,
      truncated: false,
      fullOutputAvailable: true,
      preview: 'legacy output',
    });
  });

  it('subagent restore does not claim previous v2 session tasks', () => {
    const subagent = new AgentTaskService('agent-1');
    subagent.restore(taskHistoryRecords([processInfo()], 'main'));
    expect(subagent.list(false)).toEqual([]);
  });

  it('keeps live tasks visible independently of restored history', async () => {
    const channel = createTaskChannel();
    const task = await startControlledTask(channel);
    const restored = restoredTaskService(channel, [processInfo({ status: 'completed', endedAt: 2 })]).manager;
    expect(restored.list(true).map((info) => info.taskId)).toEqual([task.handler.taskId]);
    expect(restored.list(false)).toHaveLength(2);
  });

  it('has no active task after the last live handler stops', async () => {
    const channel = createTaskChannel();
    const task = await startControlledTask(channel);
    await channel.service.stop(task.handler.taskId);
    expect(channel.service.list(true)).toEqual([]);
  });

  it('retains complete foreground output beyond the memory limit', async () => {
    const channel = createTaskChannel();
    const output = 'x'.repeat(1024 * 1024 + 100);
    const task = await startControlledTask(channel, { detached: false, output, completion: Promise.resolve('') });
    await channel.service.wait(task.handler.taskId);
    expect((await channel.service.getOutputSnapshot(task.handler.taskId, 1)).outputSizeBytes).toBe(output.length);
  });

  it('retains complete detached output beyond the memory limit', async () => {
    const channel = createTaskChannel();
    const output = 'y'.repeat(1024 * 1024 + 100);
    const task = await startControlledTask(channel, { output, completion: Promise.resolve('') });
    await channel.service.wait(task.handler.taskId);
    expect((await channel.service.getOutputSnapshot(task.handler.taskId, 1)).outputSizeBytes).toBe(output.length);
  });

  it('continues reading persisted output after the retention limit trips', async () => {
    const channel = createTaskChannel();
    const task = await startControlledTask(channel, {
      output: 'z'.repeat(1024 * 1024 + 100), completion: Promise.resolve(''),
    });
    await channel.service.wait(task.handler.taskId);
    await channel.outputs.appendTaskOutput(task.handler.taskId, 'suffix');
    expect(await channel.service.readOutput(task.handler.taskId, 6)).toBe('suffix');
  });

  it('returns detached output tail after the retention limit trips', async () => {
    const channel = createTaskChannel();
    const task = await startControlledTask(channel, {
      output: 'q'.repeat(1024 * 1024 + 100), completion: Promise.resolve(''),
    });
    await channel.service.wait(task.handler.taskId);
    expect((await channel.service.readOutputTail(task.handler.taskId, 100)).data.byteLength).toBe(100);
  });

  it('does not cap or drop a detached agent result larger than the limit', async () => {
    const channel = createTaskChannel();
    const bigResult = 'a'.repeat(1024 * 1024 + 100);
    const task = await startControlledTask(channel, { output: bigResult, completion: Promise.resolve('') });
    expect((await channel.service.wait(task.handler.taskId))?.status).toBe('completed');
    expect((await channel.service.getOutputSnapshot(task.handler.taskId, 1)).outputSizeBytes).toBe(bigResult.length);
  });

  it('reads restored output exclusively from output.log', async () => {
    const channel = createTaskChannel();
    const info = processInfo({ status: 'completed', endedAt: 2, exitCode: 0 });
    await channel.outputs.appendTaskOutput(info.taskId, 'persisted output');
    const restored = restoredTaskService(channel, [info]).manager;
    expect(await restored.readOutput(info.taskId)).toBe('persisted output');
  });

  it('marks restored running history lost without synthesizing termination', () => {
    const service = new AgentTaskService('main');
    service.restore(taskHistoryRecords([processInfo()]));
    expect(service.get('bash-abcdef01')).toMatchObject({ status: 'lost', endedAt: null });
  });

  it('rejects projection for a handler without task fields', () => {
    const handler = {
      snapshot: () => ({ taskId: 'bash-task01', fields: {} }),
    } as unknown as AgentToolExecutionHandler;
    expect(() => agentTaskInfo(handler)).toThrow('has no task fields');
  });
});

describe('Agent task notification XML', () => {
  it('renders task notifications with escaped attributes and generic children', () => {
    const text = renderNotificationXml({
      id: 'n_"1&2',
      category: 'task',
      type: 'task.done',
      source_kind: 'background_task',
      source_id: 'bg&1',
      title: 'Task finished',
      severity: 'info',
      body: 'The task completed.',
      children: [
        [
          '<output-file path="/tmp/logs/a&amp;b/output.log" bytes="1234">',
          'Read the output file to retrieve the result: /tmp/logs/a&amp;b/output.log',
          '</output-file>',
        ].join('\n'),
      ],
    });

    expect(text).toContain('id="n_&quot;1&amp;2"');
    expect(text).toContain('source_id="bg&amp;1"');
    expect(text).toContain('Title: Task finished');
    expect(text).toContain('Severity: info');
    expect(text).toContain('<output-file path="/tmp/logs/a&amp;b/output.log" bytes="1234">');
    expect(text).toContain('Read the output file to retrieve the result: /tmp/logs/a&amp;b/output.log');
    expect(text).not.toContain('<task-notification>');
    expect(text.trimEnd()).toMatch(/<\/notification>$/);
  });

  it('renders an agent_id attribute when the notification carries one', () => {
    const text = renderNotificationXml({
      id: 'n_lost1',
      category: 'task',
      type: 'task.lost',
      source_kind: 'background_task',
      source_id: 'agent-w7gq3wwj',
      agent_id: 'agent-0',
      title: 'Background agent lost',
      severity: 'warning',
      body: 'Background agent 1 lost.',
    });

    expect(text).toContain('source_id="agent-w7gq3wwj"');
    expect(text).toContain('agent_id="agent-0"');
  });

  it('omits the agent_id attribute when the notification does not carry one', () => {
    const text = renderNotificationXml({
      id: 'n_bash',
      category: 'task',
      type: 'task.completed',
      source_kind: 'background_task',
      source_id: 'bash-abcdef00',
      title: 'Background task completed',
      severity: 'info',
      body: 'echo done completed.',
    });

    expect(text).not.toContain('agent_id=');
  });

  it('ignores unrelated fields while applying attribute fallbacks', () => {
    const text = renderNotificationXml({
      id: '',
      source_kind: 'host',
      tail_output: 'should stay out of the XML',
    });

    expect(text).toContain('id="unknown"');
    expect(text).toContain('category="unknown"');
    expect(text).not.toContain('<task-notification>');
    expect(text).not.toContain('should stay out of the XML');
  });
});
