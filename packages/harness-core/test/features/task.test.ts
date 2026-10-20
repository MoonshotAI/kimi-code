import { describe, expect, it, vi } from 'vitest';

import { createFeature, type Feature } from '@moonshot-ai/agent-core/app/index';
import { createUserEntry, type ToolMeta, type UserMeta } from '@moonshot-ai/agent-core/history/index';
import { useInject, type ShallowRef } from '@moonshot-ai/agent-core/kernel/index';
import { createAssistantMessage, createUserMessage, extractText, type ToolCall } from '@moonshot-ai/agent-core/llm/message';
import type { LlmRequest } from '@moonshot-ai/agent-core/llm/request';
import type { LlmOutcome } from '@moonshot-ai/agent-core/llm/response';
import type { LoopLlmRequester } from '@moonshot-ai/agent-core/loop/index';
import { MAIN_AGENT_ID, type Agent, type Session } from '@moonshot-ai/agent-core/session/index';
import type { ToolDefinition, ToolResult } from '@moonshot-ai/agent-core/tool/index';

import {
  createTask,
  TaskRef,
  type TaskEvent,
  type TaskFace,
  type TaskSettledEvent,
  type TaskStartedEvent,
} from '#/features/task/index';
import {
  createHarness,
  harnessInternals,
  memoryHarnessSpace,
  useAgentTools,
  type Harness,
} from '#/runtime/index';

type ScriptStep = { text: string } | { toolCall: { name: string; arguments: string } };

let queue: ScriptStep[] = [];
let callSeq = 0;

function textOutcome(text: string, toolCalls: ToolCall[] = []): LlmOutcome {
  return { type: 'done', message: createAssistantMessage([{ type: 'text', text }], toolCalls) };
}

function createMockRequester(): LoopLlmRequester {
  const self: LoopLlmRequester = {
    with: () => self,
    request: (part) => part as unknown as LlmRequest,
    generate: async () => {
      const out = queue.shift() ?? { text: 'done' };
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
    },
  };
  return self;
}

function setRequester(harness: Harness, sessionId: string, agentId: string, requester: LoopLlmRequester): void {
  const session = harness.app.sessions.get(sessionId);
  const runtime = session !== undefined ? harnessInternals(harness.app).agents.get(session)?.get(agentId) : undefined;
  if (runtime === undefined) throw new Error(`no runtime for agent '${agentId}'`);
  runtime.requester = requester;
}

function user(text: string) {
  return createUserEntry(createUserMessage(text), { source: 'input' });
}

interface BgHandle {
  readonly signal: AbortSignal;
  settle(text: string): void;
  fail(error: unknown): void;
}

function bindTestBgTool(bg: Map<string, BgHandle>): Feature<void> {
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

function bindTestFgTool(fg: Map<string, (text: string) => void>): Feature<void> {
  const tool: ToolDefinition = {
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
  return createFeature('test-fg', {
    agent() {
      useAgentTools(tool);
    },
  });
}

function captureTask(): { feature: Feature<void>; face(): TaskFace | undefined } {
  let exposed: Readonly<ShallowRef<TaskFace | undefined>> | undefined;
  const feature = createFeature('task-probe', {
    agent: () => {
      exposed = useInject(TaskRef);
    },
  });
  return { feature, face: () => exposed?.value };
}

interface TaskTestEnv {
  readonly harness: Harness;
  readonly session: Session;
  readonly taskFeature: Feature<void, TaskEvent>;
  readonly bg: Map<string, BgHandle>;
  main(): Agent;
  tasks(): TaskFace;
  runTurn(text?: string): Promise<void>;
  remount(): Promise<void>;
  dispose(): Promise<void>;
}

async function startTaskTest(options?: {
  readonly fg?: Map<string, (text: string) => void>;
}): Promise<TaskTestEnv> {
  const taskFeature = createTask();
  const probe = captureTask();
  const bg = new Map<string, BgHandle>();
  const harness = createHarness({ space: memoryHarnessSpace() });
  await harness.app.features.add(taskFeature);
  await harness.app.features.add(probe.feature);
  await harness.app.features.add(bindTestBgTool(bg));
  if (options?.fg !== undefined) await harness.app.features.add(bindTestFgTool(options.fg));
  const session = await harness.app.create({ sessionId: 'sess' });
  let main = await harness.ensureAgent(session, MAIN_AGENT_ID, { systemPrompt: 'main-host' });
  setRequester(harness, 'sess', MAIN_AGENT_ID, createMockRequester());
  const tasks = (): TaskFace => {
    const face = probe.face();
    if (face === undefined) throw new Error('task facade was not captured');
    return face;
  };
  const runTurn = async (text = 'go'): Promise<void> => {
    await main.loop.runTurn(user(text));
    await main.flush();
  };
  const remount = async (): Promise<void> => {
    await session.close(MAIN_AGENT_ID);
    main = await harness.ensureAgent(session, MAIN_AGENT_ID, { systemPrompt: 'main-host' });
  };
  const dispose = async (): Promise<void> => {
    await harness.close();
  };
  return {
    harness,
    session,
    taskFeature,
    bg,
    main: () => main,
    tasks,
    runTurn,
    remount,
    dispose,
  };
}

function nextTurnDone(agent: Agent): Promise<unknown> {
  return agent.loop.wait('turn.ended');
}

function historyOf(agent: Agent) {
  return agent.view.getState().messages;
}

function toolResultTexts(agent: Agent): string[] {
  return historyOf(agent)
    .filter((entry) => entry.message.role === 'tool')
    .map((entry) => extractText(entry.message));
}

function toolResultIsErrors(agent: Agent): boolean[] {
  return historyOf(agent)
    .filter((entry) => entry.message.role === 'tool')
    .map((entry) => (entry.meta as ToolMeta | undefined)?.isError === true);
}

function asyncToolTexts(agent: Agent): string[] {
  return historyOf(agent)
    .filter((entry) => (entry.meta as UserMeta | undefined)?.source === 'async-tool')
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
    env.harness.app.on(env.taskFeature, 'task.started', (event) => {
      started.push(event);
    });
    env.harness.app.on(env.taskFeature, 'task.settled', (event) => {
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
    expect(toolResultTexts(env.main()).at(-1)).toBe(`bg ack ${taskId}`);

    const notified = nextTurnDone(env.main());
    env.bg.get(taskId)?.settle('bg output text');
    await notified;
    await env.main().flush();

    const done = env.tasks().records.value.get(taskId);
    expect(done).toMatchObject({ status: 'completed', output: 'bg output text' });
    expect(done?.endedAt).toBeGreaterThanOrEqual(done?.startedAt ?? 0);
    expect(settled.map((event) => [event.record.taskId, event.record.status])).toEqual([
      [taskId, 'completed'],
    ]);
    const notification = asyncToolTexts(env.main()).at(-1) ?? '';
    expect(notification).toContain(`[async tool completed] TestBg (tool_call_id=${taskId})`);
    expect(notification).toContain('bg output text');
    await env.dispose();
  });

  it('TaskList reports running and terminal tasks with plain-object formatting', async () => {
    const env = await startTaskTest();
    const taskId = await detachOne(env, 'list task');

    queue = [{ toolCall: { name: 'TaskList', arguments: '{}' } }, { text: 'done' }];
    await env.runTurn();
    const running = toolResultTexts(env.main()).at(-1) ?? '';
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
    const all = toolResultTexts(env.main()).at(-1) ?? '';
    expect(all).toContain('background_tasks: 1\n');
    expect(all).toContain('status: completed\n');
    expect(all).toMatch(/ended_at: \d+/);

    queue = [{ toolCall: { name: 'TaskList', arguments: '{}' } }, { text: 'done' }];
    await env.runTurn();
    expect(toolResultTexts(env.main()).at(-1)).toBe(
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
    const running = toolResultTexts(env.main()).at(-1) ?? '';
    expect(running).toContain('retrieval_status: not_ready\n');
    expect(running).toContain(`task_id: ${taskId}\n`);
    expect(running).toContain('status: running\n');
    expect(running).toContain('[output]\n[no output available]');

    queue = [
      { toolCall: { name: 'TaskOutput', arguments: JSON.stringify({ task_id: 'nope' }) } },
      { text: 'done' },
    ];
    await env.runTurn();
    expect(toolResultTexts(env.main()).at(-1)).toBe('Task not found: nope');
    expect(toolResultIsErrors(env.main()).at(-1)).toBe(true);

    const notified = nextTurnDone(env.main());
    env.bg.get(taskId)?.settle('final output text');
    await notified;

    queue = [
      { toolCall: { name: 'TaskOutput', arguments: JSON.stringify({ task_id: taskId }) } },
      { text: 'done' },
    ];
    await env.runTurn();
    const done = toolResultTexts(env.main()).at(-1) ?? '';
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
    await env.main().flush();

    expect(env.tasks().records.value.get(taskId)).toMatchObject({
      status: 'failed',
      stopReason: 'boom',
      output: 'boom',
    });
    const notification = asyncToolTexts(env.main()).at(-1) ?? '';
    expect(notification).toContain(`[async tool failed] TestBg (tool_call_id=${taskId})`);
    expect(notification).toContain('boom');

    queue = [
      { toolCall: { name: 'TaskOutput', arguments: JSON.stringify({ task_id: taskId }) } },
      { text: 'done' },
    ];
    await env.runTurn();
    const output = toolResultTexts(env.main()).at(-1) ?? '';
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
    expect(toolResultTexts(env.main()).at(-1)).toBe(
      `task_id: ${taskId}\nstatus: killed\nreason: too slow`,
    );
    expect(env.tasks().records.value.get(taskId)).toMatchObject({ status: 'killed', stopReason: 'too slow' });
    expect(env.bg.get(taskId)?.signal.aborted).toBe(true);
    await vi.waitFor(async () => {
      await env.main().flush();
      const notifications = asyncToolTexts(env.main());
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
    expect(toolResultTexts(env.main()).at(-1)).toBe(
      `task_id: ${taskId}\nstatus: killed\nreason: too slow`,
    );
    expect(toolResultIsErrors(env.main()).at(-1)).toBe(false);

    const second = await detachOne(env);
    queue = [
      { toolCall: { name: 'TaskStop', arguments: JSON.stringify({ task_id: second }) } },
      { text: 'done' },
    ];
    await env.runTurn();
    expect(toolResultTexts(env.main()).at(-1)).toBe(
      `task_id: ${second}\nstatus: killed\nreason: Stopped by TaskStop`,
    );

    queue = [
      { toolCall: { name: 'TaskStop', arguments: JSON.stringify({ task_id: 'nope' }) } },
      { text: 'done' },
    ];
    await env.runTurn();
    expect(toolResultTexts(env.main()).at(-1)).toBe('Task not found: nope');
    expect(toolResultIsErrors(env.main()).at(-1)).toBe(true);
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
    const all = toolResultTexts(env.main()).at(-1) ?? '';
    expect(all).toContain('background_tasks: 1\n');
    expect(all).toContain('status: lost\n');

    queue = [{ toolCall: { name: 'TaskList', arguments: '{}' } }, { text: 'done' }];
    await env.runTurn();
    expect(toolResultTexts(env.main()).at(-1)).toBe(
      'active_background_tasks: 0\nNo background tasks found.',
    );
    await env.dispose();
  });

  it('records a foreground tool detached through the agent command and settles it in the background', async () => {
    const fg = new Map<string, (text: string) => void>();
    const env = await startTaskTest({ fg });
    const started: TaskStartedEvent[] = [];
    env.harness.app.on(env.taskFeature, 'task.started', (event) => {
      started.push(event);
    });

    queue = [
      {
        toolCall: { name: 'TestFg', arguments: JSON.stringify({ description: 'fg task' }) },
      },
      { text: 'done' },
    ];
    const main = env.main();
    const spawned = main.loop.wait('tool.started', {
      match: (event) => event.toolCall.name === 'TestFg',
    });
    const firstTurn = main.loop.runTurn(user('go'));
    const taskId = (await spawned).toolCall.id;
    main.loop.detachTool(taskId);
    await firstTurn;
    await main.flush();

    const tasks = env.tasks();
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
    await main.flush();
    expect(tasks.records.value.get(taskId)).toMatchObject({
      status: 'completed',
      output: 'fg output',
    });
    const afterSettled = await tasks.detach(taskId);
    expect(afterSettled).toMatchObject({ detached: false, record: { status: 'completed' } });

    await env.dispose();
  });
});
