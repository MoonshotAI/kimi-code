import { describe, expect, it, vi } from 'vitest';

import {
  createFeature,
  createUserMessage,
  extractText,
  MAIN_AGENT_ID,
  MemoryBackend,
  createHarness,
  openBlobs,
  openSessionStores,
  Trees,
  useAgent,
  useAgentTools,
  type AgentHandle,
  type FeatureSpec,
  type AgentLlmRequester,
  type SessionHandle,
  type SessionStores,
  type ToolDefinition,
  type ToolMeta,
  type ToolResult,
} from '@moonshot-ai/agent-core';

import {
  createTask,
  TaskRef,
  type TaskEvent,
  type TaskFace,
  type TaskSettledEvent,
  type TaskStartedEvent,
} from '#/features/task/index';

import { fakeRequester, textOutcome, testModel } from '../fake-llm';

type ScriptStep = { text: string } | { toolCall: { name: string; arguments: string } };

let queue: ScriptStep[] = [];
let callSeq = 0;

function createMockRequester(): AgentLlmRequester {
  return fakeRequester((_rest, onEvent) => {
    const out = queue.shift() ?? { text: 'done' };
    onEvent?.({
      type: 'llm.streaming.usage',
      usage: { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 },
    });
    if ('toolCall' in out) {
      return textOutcome('', [
        {
          type: 'function',
          id: `call-${(callSeq += 1)}`,
          name: out.toolCall.name,
          arguments: out.toolCall.arguments,
        },
      ]);
    }
    return textOutcome(out.text);
  });
}

function bindTestLlm(requester: AgentLlmRequester): FeatureSpec {
  return createFeature('test-llm', {
    agent() {
      const agent = useAgent();
      agent.setModel(testModel);
      agent.setRequester(requester);
    },
  });
}

interface BgHandle {
  readonly signal: AbortSignal;
  settle(text: string): void;
  fail(error: unknown): void;
}

function bindTestBgTool(bg: Map<string, BgHandle>): FeatureSpec {
  const tool: ToolDefinition = {
    name: 'TestBg',
    description: 'test background tool',
    parameters: {
      type: 'object',
      properties: { description: { type: 'string' } },
      additionalProperties: false,
    },
    execute: ({ toolCall, signal, detach }) => {
      detach?.(`bg ack ${toolCall.id}`);
      return new Promise<ToolResult>((resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new Error('test bg aborted'));
        });
        bg.set(toolCall.id, {
          signal,
          settle: (text) => {
            resolve({ content: [{ type: 'text', text }] });
          },
          fail: (error) => {
            reject(error);
          },
        });
      });
    },
  };
  return createFeature('test-bg', {
    agent() {
      useAgentTools(tool);
    },
  });
}

interface TaskTestEnv {
  readonly session: SessionHandle;
  readonly stores: SessionStores;
  readonly taskFeature: FeatureSpec<TaskEvent>;
  readonly bg: Map<string, BgHandle>;
  main(): AgentHandle;
  tasks(): TaskFace;
  runTurn(text?: string): Promise<void>;
  remount(): Promise<void>;
  dispose(): Promise<void>;
}

async function startTaskTest(): Promise<TaskTestEnv> {
  const backend = new MemoryBackend();
  const trees = await Trees.open(backend.trees, {});
  const tree = await trees.tree('sess');
  const stores = await openSessionStores(tree, openBlobs(backend.blobs));
  const bg = new Map<string, BgHandle>();
  const taskFeature = createTask();
  const app = createHarness({
    features: [taskFeature, bindTestLlm(createMockRequester()), bindTestBgTool(bg)],
  });
  await app.ready();
  const session = await app.create({ sessionId: 'sess', stores });
  let main = await session.create({ agentId: MAIN_AGENT_ID, systemPrompt: 'main-host' });
  await main.ready();
  const runTurn = async (text = 'go'): Promise<void> => {
    const target = main;
    const done = new Promise<void>((resolve) => {
      target.on('turn.done', () => {
        resolve();
      });
    });
    target.submit(createUserMessage(text));
    await done;
    await stores.flush();
  };
  const remount = async (): Promise<void> => {
    await session.close(MAIN_AGENT_ID);
    main = await session.create({ agentId: MAIN_AGENT_ID, systemPrompt: 'main-host' });
    await main.ready();
  };
  const dispose = async (): Promise<void> => {
    await app.disposeAsync();
    await stores.dispose();
  };
  return {
    session,
    stores,
    taskFeature,
    bg,
    main: () => main,
    tasks: () => main.resolve(TaskRef),
    runTurn,
    remount,
    dispose,
  };
}

function nextTurnDone(agent: AgentHandle): Promise<void> {
  return new Promise<void>((resolve) => {
    agent.on('turn.done', () => {
      resolve();
    });
  });
}

function historyOf(stores: SessionStores) {
  return stores.get(MAIN_AGENT_ID)?.getState().history ?? [];
}

function toolResultTexts(stores: SessionStores): string[] {
  return historyOf(stores)
    .filter((entry) => entry.message.role === 'tool')
    .map((entry) => extractText(entry.message));
}

function toolResultIsErrors(stores: SessionStores): boolean[] {
  return historyOf(stores)
    .filter((entry) => entry.message.role === 'tool')
    .map((entry) => (entry.meta as ToolMeta | undefined)?.isError === true);
}

function asyncToolTexts(stores: SessionStores): string[] {
  return historyOf(stores)
    .filter((entry) => entry.meta?.source === 'async-tool')
    .map((entry) => extractText(entry.message));
}

function detachStep(description?: string): ScriptStep[] {
  return [
    {
      toolCall: {
        name: 'TestBg',
        arguments: JSON.stringify(description === undefined ? {} : { description }),
      },
    },
    { text: 'done' },
  ];
}

async function detachOne(env: TaskTestEnv, description?: string): Promise<string> {
  queue = detachStep(description);
  await env.runTurn();
  const taskId = [...env.bg.keys()].at(-1);
  expect(taskId).toBeDefined();
  return taskId as string;
}

describe('task feature', () => {
  it('records a detached tool call through settlement and keeps the machine notification intact', async () => {
    const env = await startTaskTest();
    const started: TaskStartedEvent[] = [];
    const settled: TaskSettledEvent[] = [];
    env.session.on(env.taskFeature, 'task.started', (event) => {
      started.push(event);
    });
    env.session.on(env.taskFeature, 'task.settled', (event) => {
      settled.push(event);
    });

    const taskId = await detachOne(env, 'test task');
    const running = env.tasks().records.value.get(taskId);
    expect(running).toMatchObject({
      taskId,
      toolName: 'TestBg',
      description: 'test task',
      detachText: `bg ack ${taskId}`,
      status: 'running',
    });
    expect(running?.startedAt).toBeGreaterThan(0);
    expect(started.map((event) => event.record.taskId)).toEqual([taskId]);
    expect(toolResultTexts(env.stores).at(-1)).toBe(`bg ack ${taskId}`);

    const notified = nextTurnDone(env.main());
    env.bg.get(taskId)?.settle('bg output text');
    await notified;
    await env.stores.flush();

    const done = env.tasks().records.value.get(taskId);
    expect(done).toMatchObject({ status: 'completed', output: 'bg output text' });
    expect(done?.endedAt).toBeGreaterThanOrEqual(done?.startedAt ?? 0);
    expect(settled.map((event) => [event.record.taskId, event.record.status])).toEqual([
      [taskId, 'completed'],
    ]);
    const notification = asyncToolTexts(env.stores).at(-1) ?? '';
    expect(notification).toContain(`[async tool completed] TestBg (tool_call_id=${taskId})`);
    expect(notification).toContain('bg output text');
    await env.dispose();
  });

  it('TaskList reports running and terminal tasks with plain-object formatting', async () => {
    const env = await startTaskTest();
    const taskId = await detachOne(env, 'list task');

    queue = [{ toolCall: { name: 'TaskList', arguments: '{}' } }, { text: 'done' }];
    await env.runTurn();
    const running = toolResultTexts(env.stores).at(-1) ?? '';
    expect(running).toContain('active_background_tasks: 1\n');
    expect(running).toContain(`task_id: ${taskId}\n`);
    expect(running).toContain('tool: TestBg\n');
    expect(running).toContain('description: list task\n');
    expect(running).toContain('status: running\n');
    expect(running).toMatch(/started_at: \d+/);
    expect(running).not.toContain('ended_at');

    const notified = nextTurnDone(env.main());
    env.bg.get(taskId)?.settle('listed output');
    await notified;

    queue = [
      { toolCall: { name: 'TaskList', arguments: JSON.stringify({ active_only: false }) } },
      { text: 'done' },
    ];
    await env.runTurn();
    const all = toolResultTexts(env.stores).at(-1) ?? '';
    expect(all).toContain('background_tasks: 1\n');
    expect(all).toContain('status: completed\n');
    expect(all).toMatch(/ended_at: \d+/);

    queue = [{ toolCall: { name: 'TaskList', arguments: '{}' } }, { text: 'done' }];
    await env.runTurn();
    expect(toolResultTexts(env.stores).at(-1)).toBe(
      'active_background_tasks: 0\nNo background tasks found.',
    );
    await env.dispose();
  });

  it('TaskOutput returns metadata and output, not_ready for running tasks, and Task not found for unknown ids', async () => {
    const env = await startTaskTest();
    const taskId = await detachOne(env, 'output task');

    queue = [
      { toolCall: { name: 'TaskOutput', arguments: JSON.stringify({ task_id: taskId }) } },
      { text: 'done' },
    ];
    await env.runTurn();
    const running = toolResultTexts(env.stores).at(-1) ?? '';
    expect(running).toContain('retrieval_status: not_ready\n');
    expect(running).toContain(`task_id: ${taskId}\n`);
    expect(running).toContain('status: running\n');
    expect(running).toContain('[output]\n[no output available]');

    queue = [
      { toolCall: { name: 'TaskOutput', arguments: JSON.stringify({ task_id: 'nope' }) } },
      { text: 'done' },
    ];
    await env.runTurn();
    expect(toolResultTexts(env.stores).at(-1)).toBe('Task not found: nope');
    expect(toolResultIsErrors(env.stores).at(-1)).toBe(true);

    const notified = nextTurnDone(env.main());
    env.bg.get(taskId)?.settle('final output text');
    await notified;

    queue = [
      { toolCall: { name: 'TaskOutput', arguments: JSON.stringify({ task_id: taskId }) } },
      { text: 'done' },
    ];
    await env.runTurn();
    const done = toolResultTexts(env.stores).at(-1) ?? '';
    expect(done).toContain('retrieval_status: success\n');
    expect(done).toContain('status: completed\n');
    expect(done).toMatch(/output_size_bytes: \d+\n/);
    expect(done).toContain('[output]\nfinal output text');
    expect(done).not.toContain('terminal_reason');
    await env.dispose();
  });

  it('records a failed background tool with its error and keeps the failure notification intact', async () => {
    const env = await startTaskTest();
    const taskId = await detachOne(env, 'failing task');

    const notified = nextTurnDone(env.main());
    env.bg.get(taskId)?.fail(new Error('boom'));
    await notified;
    await env.stores.flush();

    expect(env.tasks().records.value.get(taskId)).toMatchObject({
      status: 'failed',
      stopReason: 'boom',
      output: 'boom',
    });
    const notification = asyncToolTexts(env.stores).at(-1) ?? '';
    expect(notification).toContain(`[async tool failed] TestBg (tool_call_id=${taskId})`);
    expect(notification).toContain('boom');

    queue = [
      { toolCall: { name: 'TaskOutput', arguments: JSON.stringify({ task_id: taskId }) } },
      { text: 'done' },
    ];
    await env.runTurn();
    const output = toolResultTexts(env.stores).at(-1) ?? '';
    expect(output).toContain('status: failed\n');
    expect(output).toContain('stop_reason: boom\n');
    expect(output).toContain('terminal_reason: failed\n');
    expect(output).toContain('[output]\nboom');
    await env.dispose();
  });

  it('TaskStop aborts a running task, records the kill, and reports terminal state on repeat', async () => {
    const env = await startTaskTest();
    const taskId = await detachOne(env, 'stoppable task');

    queue = [
      {
        toolCall: { name: 'TaskStop', arguments: JSON.stringify({ task_id: taskId, reason: 'too slow' }) },
      },
      { text: 'done' },
    ];
    await env.runTurn();
    expect(toolResultTexts(env.stores).at(-1)).toBe(
      `task_id: ${taskId}\nstatus: killed\nreason: too slow`,
    );
    expect(env.tasks().records.value.get(taskId)).toMatchObject({ status: 'killed', stopReason: 'too slow' });
    expect(env.bg.get(taskId)?.signal.aborted).toBe(true);
    await vi.waitFor(async () => {
      await env.stores.flush();
      const notifications = asyncToolTexts(env.stores);
      expect(
        notifications.some((text) =>
          text.includes(`[async tool aborted] TestBg (tool_call_id=${taskId})`),
        ),
      ).toBe(true);
    });

    queue = [
      { toolCall: { name: 'TaskStop', arguments: JSON.stringify({ task_id: taskId }) } },
      { text: 'done' },
    ];
    await env.runTurn();
    expect(toolResultTexts(env.stores).at(-1)).toBe(
      `task_id: ${taskId}\nstatus: killed\nreason: too slow`,
    );
    expect(toolResultIsErrors(env.stores).at(-1)).toBe(false);

    const second = await detachOne(env);
    queue = [
      { toolCall: { name: 'TaskStop', arguments: JSON.stringify({ task_id: second }) } },
      { text: 'done' },
    ];
    await env.runTurn();
    expect(toolResultTexts(env.stores).at(-1)).toBe(
      `task_id: ${second}\nstatus: killed\nreason: Stopped by TaskStop`,
    );

    queue = [
      { toolCall: { name: 'TaskStop', arguments: JSON.stringify({ task_id: 'nope' }) } },
      { text: 'done' },
    ];
    await env.runTurn();
    expect(toolResultTexts(env.stores).at(-1)).toBe('Task not found: nope');
    expect(toolResultIsErrors(env.stores).at(-1)).toBe(true);
    await env.dispose();
  });

  it('marks tasks from a previous mount as lost on remount', async () => {
    const env = await startTaskTest();
    const taskId = await detachOne(env, 'orphaned task');
    expect(env.tasks().records.value.get(taskId)?.status).toBe('running');

    await env.remount();
    await vi.waitFor(() => {
      expect(env.tasks().records.value.get(taskId)?.status).toBe('lost');
    });
    const lost = env.tasks().records.value.get(taskId);
    expect(lost?.endedAt).toBeGreaterThanOrEqual(lost?.startedAt ?? 0);

    queue = [
      { toolCall: { name: 'TaskList', arguments: JSON.stringify({ active_only: false }) } },
      { text: 'done' },
    ];
    await env.runTurn();
    const all = toolResultTexts(env.stores).at(-1) ?? '';
    expect(all).toContain('background_tasks: 1\n');
    expect(all).toContain('status: lost\n');

    queue = [{ toolCall: { name: 'TaskList', arguments: '{}' } }, { text: 'done' }];
    await env.runTurn();
    expect(toolResultTexts(env.stores).at(-1)).toBe(
      'active_background_tasks: 0\nNo background tasks found.',
    );
    await env.dispose();
  });

  it('records a foreground tool detached through the agent command and settles it in the background', async () => {
    const fg = new Map<string, (text: string) => void>();
    const fgTool: ToolDefinition = {
      name: 'TestFg',
      description: 'test foreground tool',
      parameters: {
        type: 'object',
        properties: { description: { type: 'string' } },
        additionalProperties: false,
      },
      execute: ({ toolCall }) =>
        new Promise<ToolResult>((resolve) => {
          fg.set(toolCall.id, (text) => {
            resolve({ content: [{ type: 'text', text }] });
          });
        }),
    };
    const fgFeature = createFeature('test-fg', {
      agent() {
        useAgentTools(fgTool);
      },
    });
    const backend = new MemoryBackend();
    const trees = await Trees.open(backend.trees, {});
    const tree = await trees.tree('sess-fg');
    const stores = await openSessionStores(tree, openBlobs(backend.blobs));
    const taskFeature = createTask();
    const app = createHarness({
      features: [taskFeature, bindTestLlm(createMockRequester()), fgFeature],
    });
    await app.ready();
    const session = await app.create({ sessionId: 'sess-fg', stores });
    const main = await session.create({ agentId: MAIN_AGENT_ID, systemPrompt: 'main-host' });
    await main.ready();
    const started: TaskStartedEvent[] = [];
    session.on(taskFeature, 'task.started', (event) => {
      started.push(event);
    });

    queue = [
      {
        toolCall: { name: 'TestFg', arguments: JSON.stringify({ description: 'fg task' }) },
      },
      { text: 'done' },
    ];
    const spawned = main.wait('turn.spawn_tools', {
      match: (event) => event.toolCalls.some((call) => call.name === 'TestFg'),
    });
    const firstTurn = nextTurnDone(main);
    main.submit(createUserMessage('go'));
    const taskId = (await spawned).toolCalls[0]?.id as string;
    main.detachTool(taskId);
    await firstTurn;
    await stores.flush();

    const tasks = main.resolve(TaskRef);
    const record = tasks.records.value.get(taskId);
    expect(record).toMatchObject({
      taskId,
      toolName: 'TestFg',
      description: 'fg task',
      status: 'running',
    });
    expect(record?.detachText).toBe(
      `moved to background by the user: TestFg (tool_call_id=${taskId})`,
    );
    expect(started.map((event) => event.record.taskId)).toEqual([taskId]);

    const alreadyBackground = await tasks.detach(taskId);
    expect(alreadyBackground).toMatchObject({
      detached: false,
      record: { taskId, status: 'running' },
    });
    expect(await tasks.detach('task_unknown')).toBeUndefined();

    const notified = nextTurnDone(main);
    fg.get(taskId)?.('fg output');
    await notified;
    await stores.flush();
    expect(tasks.records.value.get(taskId)).toMatchObject({
      status: 'completed',
      output: 'fg output',
    });
    const afterSettled = await tasks.detach(taskId);
    expect(afterSettled).toMatchObject({ detached: false, record: { status: 'completed' } });

    await app.disposeAsync();
    await stores.dispose();
  });
});
