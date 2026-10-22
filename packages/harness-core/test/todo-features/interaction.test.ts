import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createFeature,
  useAgent,
  useSession,
  type Feature,
  createApp,
  type App,
} from '#/app/index';
import { createUserEntry, type UserMeta } from '@moonshot-ai/agent-core/history/index';
import { useInject, type ShallowRef } from '#/kernel/index';
import { createAssistantMessage, createUserMessage, extractText } from '@moonshot-ai/agent-core/llm/message';
import type { LlmRequest } from '@moonshot-ai/agent-core/llm/request';
import type { LlmOutcome } from '@moonshot-ai/agent-core/llm/response';
import type { LoopLlmRequester } from '@moonshot-ai/agent-core/loop/index';
import { memorySessionSpace, type Agent } from '@moonshot-ai/agent-core/session/index';
import type { ToolDefinition, ToolExecuteInput, ToolResult } from '@moonshot-ai/agent-core/tool/index';

import {
  AUTO_MODE_ASK_USER_QUESTION_DISABLED,
  INTERACTION_TAG_AGENT_ID,
  INTERACTION_TAG_TOOL_CALL_ID,
  INTERACTION_TAG_TURN_ID,
  InteractionRef,
  interaction,
  isInteractionCancellation,
  PERMISSION_MODE_REMINDER_ENV,
  PERMISSION_REMIND_KEY,
  type Interaction,
  type InteractionEvent,
  type Interactions,
} from '#/todo-features/interaction/index';
import {
  createPermission,
  PermissionRef,
  type PermissionFace,
} from '#/todo-features/permission/index';
import { createTask, TaskRef, type TaskFace } from '#/todo-features/task/index';
import {
  createTelemetry,
  useTelemetryAppender,
  type TelemetryAppenderRecord,
} from '#/todo-features/telemetry/index';

type GenerateRest = Parameters<LoopLlmRequester['generate']>[0];

function textOutcome(text: string): LlmOutcome {
  return { type: 'done', message: createAssistantMessage([{ type: 'text', text }]) };
}

function echoRequester(): LoopLlmRequester {
  const self: LoopLlmRequester = {
    with: () => self,
    request: (part) => part as unknown as LlmRequest,
    generate: async (rest: GenerateRest) => {
      const messages = rest.content?.messages ?? [];
      const last = messages.at(-1);
      const text = last !== undefined && last.role === 'user' ? extractText(last) : '';
      return textOutcome(`echo:${text}`);
    },
  };
  return self;
}

function user(text: string, meta: UserMeta = {}) {
  return createUserEntry(createUserMessage(text), { source: 'input', ...meta });
}

function setRequester(harness: App, sessionId: string, agentId: string, requester: LoopLlmRequester): void {
  const session = harness.sessions.get(sessionId);
  const runtime = session !== undefined ? session.agentRuntime(agentId) : undefined;
  if (runtime === undefined) throw new Error(`no runtime for agent '${agentId}'`);
  runtime.requester = requester;
}

type InteractionRefs = Map<string, Readonly<ShallowRef<Interactions | undefined>>>;

function captureInteractions(): { feature: Feature; refs: InteractionRefs } {
  const refs: InteractionRefs = new Map();
  const feature = createFeature('interaction-capture', {
    session: () => {
      refs.set(useSession().id, useInject(InteractionRef));
    },
  });
  return { feature, refs };
}

function interactionsOf(refs: InteractionRefs, sessionId: string): Interactions {
  const interactions = refs.get(sessionId)?.value;
  if (interactions === undefined) throw new Error(`no interactions captured for session '${sessionId}'`);
  return interactions;
}

async function start(sessionIds: readonly string[]): Promise<{ harness: App; refs: InteractionRefs }> {
  const harness = createApp({ space: memorySessionSpace() });
  const { feature, refs } = captureInteractions();
  harness.features.add(interaction);
  harness.features.add(feature);
  for (const sessionId of sessionIds) await harness.open(sessionId);
  return { harness, refs };
}

function liveSession(harness: App, sessionId: string) {
  const session = harness.sessions.get(sessionId);
  if (session === undefined) throw new Error(`session '${sessionId}' is not live`);
  return session;
}

describe('interaction feature', () => {
  it('emits interaction.requested with the full interaction on enqueue', async () => {
    const { harness, refs } = await start(['s1']);
    const events: InteractionEvent[] = [];
    harness.on(interaction, 'interaction.requested', (event) => events.push(event));
    harness.on(interaction, 'interaction.resolved', (event) => events.push(event));
    const interactions = interactionsOf(refs, 's1');
    const item = interactions.enqueue({
      kind: 'question',
      payload: { prompt: 'continue?' },
      tags: { [INTERACTION_TAG_AGENT_ID]: 'main' },
    });
    expect(item.id).toBe('main:interaction-0');
    expect(item.createdAt).toBeGreaterThan(0);
    expect(events).toHaveLength(1);
    const requested = events[0];
    if (requested?.type !== 'interaction.requested') throw new Error('expected interaction.requested');
    expect(requested.interaction).toEqual(item);
    expect(requested['sessionId']).toBe('s1');
    expect(interactions.respond(item.id, 'yes')).toBe(true);
    expect(events).toHaveLength(2);
    const resolved = events[1];
    if (resolved?.type !== 'interaction.resolved') throw new Error('expected interaction.resolved');
    expect(resolved.id).toBe(item.id);
    expect(resolved.response).toBe('yes');
    expect(resolved.interaction).toEqual(item);
    await harness.close();
  });

  it('resolves request promises through respond and keeps records queryable', async () => {
    const { harness, refs } = await start(['s1']);
    const interactions = interactionsOf(refs, 's1');
    const promise = interactions.request<{ command: string }, string>({
      kind: 'approval',
      payload: { command: 'rm -rf build' },
    });
    const pending = interactions.findAll({ resolved: false });
    const record = pending[0];
    if (record === undefined) throw new Error('expected a pending interaction');
    expect(record.kind).toBe('approval');
    expect(interactions.respond(record.id, 'approved')).toBe(true);
    await expect(promise).resolves.toBe('approved');
    expect(interactions.respond(record.id, 'again')).toBe(false);
    expect(interactions.respond('interaction-missing', 'x')).toBe(false);
    expect(interactions.findOne({ id: record.id })?.kind).toBe('approval');
    expect(interactions.findAll({ resolved: true })).toHaveLength(1);
    expect(interactions.findAll({ resolved: false })).toHaveLength(0);
    await harness.close();
  });

  it('keeps a pending interaction unresolved across turn boundaries', async () => {
    const { harness, refs } = await start(['s1']);
    const session = liveSession(harness, 's1');
    const { agent } = await session.ensureAgent('main');
    setRequester(harness, 's1', 'main', echoRequester());
    const interactions = interactionsOf(refs, 's1');
    const promise = interactions.request<unknown, string>({
      kind: 'question',
      payload: { prompt: 'answer later' },
      tags: { [INTERACTION_TAG_AGENT_ID]: 'main' },
    });
    const outcome = await agent.loop.runTurn(user('hello'));
    expect(outcome.type).toBe('done');
    await agent.flush();
    const replies = agent.view
      .getState()
      .messages.filter((entry) => entry.message.role === 'assistant')
      .map((entry) => extractText(entry.message));
    expect(replies).toEqual(['echo:hello']);
    const stillPending = interactions.findAll({ resolved: false });
    const record = stillPending[0];
    if (record === undefined || stillPending.length !== 1) throw new Error('turn end cancelled the interaction');
    expect(interactions.respond(record.id, 'late-answer')).toBe(true);
    await expect(promise).resolves.toBe('late-answer');
    await harness.close();
  });

  it('cancels only the closed agent pending interactions with agent_closed', async () => {
    const { harness, refs } = await start(['s1']);
    const session = liveSession(harness, 's1');
    await session.ensureAgent('main');
    await session.ensureAgent('sub');
    const resolved: Array<{ id: string; response: unknown }> = [];
    harness.on(interaction, 'interaction.resolved', (event) => {
      resolved.push({ id: event.id, response: event.response });
    });
    const interactions = interactionsOf(refs, 's1');
    const mainPending = interactions.request<unknown, unknown>({
      kind: 'question',
      payload: {},
      tags: { [INTERACTION_TAG_AGENT_ID]: 'main' },
    });
    const subPending = interactions.request<unknown, unknown>({
      kind: 'question',
      payload: {},
      tags: { [INTERACTION_TAG_AGENT_ID]: 'sub' },
    });
    await session.closeAgent('main');
    const mainResponse = await mainPending;
    if (!isInteractionCancellation(mainResponse)) throw new Error('expected a cancellation');
    expect(mainResponse.reason).toBe('agent_closed');
    expect(interactions.findAll({ resolved: false })).toHaveLength(1);
    await session.closeAgent('sub');
    const subResponse = await subPending;
    if (!isInteractionCancellation(subResponse)) throw new Error('expected a cancellation');
    expect(subResponse.reason).toBe('agent_closed');
    expect(resolved).toHaveLength(2);
    expect(resolved.every((event) => isInteractionCancellation(event.response))).toBe(true);
    await harness.close();
  });

  it('keeps an independent registry per session', async () => {
    const { harness, refs } = await start(['s1', 's2']);
    const requested: Array<{ sessionId: unknown; id: string }> = [];
    harness.on(interaction, 'interaction.requested', (event) => {
      requested.push({ sessionId: event['sessionId'], id: event.interaction.id });
    });
    const first = interactionsOf(refs, 's1');
    const second = interactionsOf(refs, 's2');
    expect(first).not.toBe(second);
    const pending = first.request<unknown, unknown>({ kind: 'approval', payload: {} });
    expect(first.findAll()).toHaveLength(1);
    expect(second.findAll()).toHaveLength(0);
    expect(requested).toEqual([{ sessionId: 's1', id: 'interaction-0' }]);
    const other = second.request<unknown, string>({ kind: 'approval', payload: {} });
    await harness.close('s1');
    const response = await pending;
    if (!isInteractionCancellation(response)) throw new Error('expected a cancellation');
    expect(response.reason).toBe('agent_closed');
    expect(second.respond('interaction-0', 'ok')).toBe(true);
    await expect(other).resolves.toBe('ok');
    await harness.close();
  });
});

type TaskRefs = Map<string, Readonly<ShallowRef<TaskFace | undefined>>>;

function captureTasks(): { feature: Feature; refs: TaskRefs } {
  const refs: TaskRefs = new Map();
  const feature = createFeature('task-capture', {
    agent() {
      refs.set(useAgent().id, useInject(TaskRef));
    },
  });
  return { feature, refs };
}

function captureTelemetry(): { feature: Feature; records: TelemetryAppenderRecord[] } {
  const records: TelemetryAppenderRecord[] = [];
  const feature = createFeature('telemetry-capture', {
    app() {
      useTelemetryAppender({
        track: (record) => {
          records.push(record);
        },
      });
    },
  });
  return { feature, records };
}

interface AskEnv {
  readonly harness: App;
  readonly agent: Agent;
  readonly interactions: Interactions;
  readonly tool: ToolDefinition;
  readonly telemetryRecords: TelemetryAppenderRecord[];
  readonly taskRefs: TaskRefs;
}

async function startAskEnv(options: { task?: boolean } = {}): Promise<AskEnv> {
  const harness = createApp({ space: memorySessionSpace() });
  const capture = captureInteractions();
  const telemetry = captureTelemetry();
  const tasks = captureTasks();
  harness.features.add(createTelemetry());
  harness.features.add(telemetry.feature);
  harness.features.add(interaction);
  harness.features.add(capture.feature);
  if (options.task === true) harness.features.add(createTask());
  harness.features.add(tasks.feature);
  await harness.open('s1');
  const session = liveSession(harness, 's1');
  const { agent } = await session.ensureAgent('main');
  const tool = session.agentRuntime('main')?.tools.get('AskUserQuestion');
  if (tool === undefined) throw new Error('AskUserQuestion tool is not registered');
  return {
    harness,
    agent,
    interactions: interactionsOf(capture.refs, 's1'),
    tool,
    telemetryRecords: telemetry.records,
    taskRefs: tasks.refs,
  };
}

function questionItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    question: 'Which database?',
    header: 'Storage',
    options: [
      { label: 'Postgres', description: 'Relational storage' },
      { label: 'SQLite', description: 'Embedded storage' },
    ],
    multi_select: false,
    ...overrides,
  };
}

function askArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { questions: [questionItem()], ...overrides };
}

function execInput(
  args: Record<string, unknown>,
  options: {
    signal?: AbortSignal;
    turnId?: number;
    id?: string;
    detach?: (text: string) => void;
  } = {},
): ToolExecuteInput {
  return {
    toolCall: {
      type: 'function',
      id: options.id ?? 'call-1',
      name: 'AskUserQuestion',
      arguments: JSON.stringify(args),
    },
    signal: options.signal ?? new AbortController().signal,
    turnId: options.turnId ?? 0,
    detach: options.detach,
  };
}

function resultText(result: ToolResult): string {
  return result.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

async function pendingQuestion(interactions: Interactions): Promise<Interaction> {
  return vi.waitFor(() => {
    const pending = interactions.findAll({ kind: 'question', resolved: false })[0];
    if (pending === undefined) throw new Error('no pending question yet');
    return pending;
  });
}

type ScriptStep = { text: string } | { toolCall: { name: string; arguments: string } };

function scriptedRequester(queue: ScriptStep[]): LoopLlmRequester {
  let callSeq = 0;
  const self: LoopLlmRequester = {
    with: () => self,
    request: (part) => part as unknown as LlmRequest,
    generate: async () => {
      const step = queue.shift() ?? { text: 'done' };
      if ('toolCall' in step) {
        return {
          type: 'done',
          message: createAssistantMessage([{ type: 'text', text: '' }], [
            {
              type: 'function',
              id: `call-${(callSeq += 1)}`,
              name: step.toolCall.name,
              arguments: step.toolCall.arguments,
            },
          ]),
        } satisfies LlmOutcome;
      }
      return textOutcome(step.text);
    },
  };
  return self;
}

describe('AskUserQuestion tool', () => {
  it('rejects duplicate question texts across questions at execution', async () => {
    const env = await startAskEnv();
    const duplicated = { questions: [questionItem(), questionItem()] };
    const result = await env.tool.execute(execInput(duplicated));
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('duplicate question text');
    expect(env.interactions.findAll({ kind: 'question' })).toHaveLength(0);
    await env.harness.close();
  });

  it('rejects duplicate option labels within one question at execution', async () => {
    const env = await startAskEnv();
    const duplicated = {
      questions: [
        questionItem({
          options: [
            { label: 'Postgres', description: 'Relational storage' },
            { label: 'Postgres', description: 'Same label again' },
          ],
        }),
      ],
    };
    const result = await env.tool.execute(execInput(duplicated));
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('duplicate option label');
    expect(env.interactions.findAll({ kind: 'question' })).toHaveLength(0);
    await env.harness.close();
  });

  it('allows the same option label to appear in different questions', async () => {
    const env = await startAskEnv();
    const promise = env.tool.execute(
      execInput({ questions: [questionItem(), questionItem({ question: 'Which cache?' })] }),
    );
    const pending = await pendingQuestion(env.interactions);
    env.interactions.respond(pending.id, {
      answers: { 'Which database?': 'Postgres', 'Which cache?': 'Postgres' },
    });
    const result = await promise;
    expect(result.isError).toBeUndefined();
    expect(resultText(result)).toBe(
      JSON.stringify({ answers: { 'Which database?': 'Postgres', 'Which cache?': 'Postgres' } }),
    );
    await env.harness.close();
  });

  it('dispatches questions through the interactions facade with wire payload and tags', async () => {
    const env = await startAskEnv();
    const promise = env.tool.execute(
      execInput({ questions: [questionItem({ multi_select: true })] }, { turnId: 7, id: 'call-q' }),
    );
    const pending = await pendingQuestion(env.interactions);
    expect(pending.tags).toMatchObject({
      [INTERACTION_TAG_AGENT_ID]: 'main',
      sessionId: 's1',
      [INTERACTION_TAG_TOOL_CALL_ID]: 'call-q',
      [INTERACTION_TAG_TURN_ID]: 7,
    });
    const payload = pending.payload as {
      toolCallId: string;
      questions: Array<{
        id: string;
        question: string;
        header: string;
        multi_select: boolean;
        allow_other: boolean;
        options: Array<{ id: string; label: string; description: string }>;
      }>;
    };
    expect(payload.toolCallId).toBe('call-q');
    expect(payload.questions).toHaveLength(1);
    expect(payload.questions[0]).toMatchObject({
      id: 'q_0',
      question: 'Which database?',
      header: 'Storage',
      multi_select: true,
      allow_other: true,
    });
    expect(payload.questions[0]?.options).toEqual([
      { id: 'opt_0_0', label: 'Postgres', description: 'Relational storage' },
      { id: 'opt_0_1', label: 'SQLite', description: 'Embedded storage' },
    ]);
    env.interactions.respond(pending.id, { answers: { 'Which database?': 'Postgres' } });
    const result = await promise;
    expect(resultText(result)).toBe(JSON.stringify({ answers: { 'Which database?': 'Postgres' } }));
    await env.harness.close();
  });

  it('tracks the answer method without leaking it into output', async () => {
    const env = await startAskEnv();
    const promise = env.tool.execute(execInput(askArgs()));
    const pending = await pendingQuestion(env.interactions);
    env.interactions.respond(pending.id, {
      answers: { 'Which database?': 'SQLite' },
      method: 'number_key',
    });
    const result = await promise;
    expect(resultText(result)).toBe(JSON.stringify({ answers: { 'Which database?': 'SQLite' } }));
    const record = env.telemetryRecords.find((r) => r.event === 'question_answered');
    expect(record?.properties).toMatchObject({ answered: 1, method: 'number_key' });
    await env.harness.close();
  });

  it('returns a dismissed result and tracks question_dismissed when dismissed', async () => {
    const env = await startAskEnv();
    const promise = env.tool.execute(execInput(askArgs()));
    const pending = await pendingQuestion(env.interactions);
    env.interactions.respond(pending.id, null);
    const result = await promise;
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(resultText(result))).toEqual({
      answers: {},
      note: 'User dismissed the question without answering.',
    });
    expect(env.telemetryRecords.some((r) => r.event === 'question_dismissed')).toBe(true);
    await env.harness.close();
  });

  it('treats an empty answers object as dismissed', async () => {
    const env = await startAskEnv();
    const promise = env.tool.execute(execInput(askArgs()));
    const pending = await pendingQuestion(env.interactions);
    env.interactions.respond(pending.id, { answers: {} });
    const result = await promise;
    expect(JSON.parse(resultText(result))).toEqual({
      answers: {},
      note: 'User dismissed the question without answering.',
    });
    expect(env.telemetryRecords.some((r) => r.event === 'question_dismissed')).toBe(true);
    await env.harness.close();
  });

  it('resolves dismissed when the waiting question is aborted', async () => {
    const env = await startAskEnv();
    const controller = new AbortController();
    const promise = env.tool.execute(execInput(askArgs(), { signal: controller.signal }));
    const pending = await pendingQuestion(env.interactions);
    controller.abort();
    const result = await promise;
    expect(JSON.parse(resultText(result))).toEqual({
      answers: {},
      note: 'User dismissed the question without answering.',
    });
    expect(env.interactions.findOne({ id: pending.id, resolved: true })).toBeDefined();
    await env.harness.close();
  });

  it('resolves dismissed when the agent is closed while waiting', async () => {
    const env = await startAskEnv();
    const promise = env.tool.execute(execInput(askArgs()));
    await pendingQuestion(env.interactions);
    env.interactions.cancelAgent('main', 'agent_closed');
    const result = await promise;
    expect(JSON.parse(resultText(result))).toEqual({
      answers: {},
      note: 'User dismissed the question without answering.',
    });
    await env.harness.close();
  });

  it('detaches a background question without the task feature', async () => {
    const env = await startAskEnv();
    let ack: string | undefined;
    const promise = env.tool.execute(
      execInput(
        { ...askArgs(), background: true },
        {
          id: 'call-bg',
          detach: (text) => {
            ack = text;
          },
        },
      ),
    );
    expect(ack).toBe(
      [
        'task_id: call-bg',
        'status: running',
        'next_step: Continue your work; the answer arrives automatically in a later message. Use TaskStop only to cancel the question.',
      ].join('\n'),
    );
    const pending = await pendingQuestion(env.interactions);
    expect(pending.tags[INTERACTION_TAG_TURN_ID]).toBeUndefined();
    env.interactions.respond(pending.id, { answers: { 'Which database?': 'Postgres' } });
    const result = await promise;
    expect(resultText(result)).toBe(JSON.stringify({ answers: { 'Which database?': 'Postgres' } }));
    await env.harness.close();
  });

  it('exposes background mode in description and parameters by default', async () => {
    const env = await startAskEnv();
    const params = env.tool.parameters as { properties: { background?: { type?: string } } };
    expect(params.properties.background?.type).toBe('boolean');
    expect(env.tool.description).toContain('background=true');
    expect(env.tool.description).toContain('task_id');
    await env.harness.close();
  });

  it('detaches a background question and settles the task with the answer', async () => {
    const env = await startAskEnv({ task: true });
    const queue: ScriptStep[] = [
      {
        toolCall: {
          name: 'AskUserQuestion',
          arguments: JSON.stringify({ ...askArgs(), background: true }),
        },
      },
      { text: 'done' },
    ];
    setRequester(env.harness, 's1', 'main', scriptedRequester(queue));
    const outcome = await env.agent.loop.runTurn(user('ask'));
    expect(outcome.type).toBe('done');
    const pending = await pendingQuestion(env.interactions);
    expect(pending.tags[INTERACTION_TAG_TURN_ID]).toBeUndefined();
    const taskId = String(pending.tags[INTERACTION_TAG_TOOL_CALL_ID]);
    const face = env.taskRefs.get('main')?.value;
    expect(face?.records.value.get(taskId)?.status).toBe('running');
    await env.agent.flush();
    const toolMessage = env.agent.view
      .getState()
      .messages.find((entry) => entry.message.role === 'tool');
    expect(extractText(toolMessage!.message)).toContain(`task_id: ${taskId}`);
    env.interactions.respond(pending.id, { answers: { 'Which database?': 'Postgres' } });
    await vi.waitFor(() => {
      expect(face?.records.value.get(taskId)?.status).toBe('completed');
    });
    expect(face?.records.value.get(taskId)?.output).toBe(
      JSON.stringify({ answers: { 'Which database?': 'Postgres' } }),
    );
    await env.harness.close();
  });

  it('settles the background question task with a dismissed output on TaskStop', async () => {
    const env = await startAskEnv({ task: true });
    const queue: ScriptStep[] = [
      {
        toolCall: {
          name: 'AskUserQuestion',
          arguments: JSON.stringify({ ...askArgs(), background: true }),
        },
      },
      { text: 'done' },
    ];
    setRequester(env.harness, 's1', 'main', scriptedRequester(queue));
    const outcome = await env.agent.loop.runTurn(user('ask'));
    expect(outcome.type).toBe('done');
    const pending = await pendingQuestion(env.interactions);
    const taskId = String(pending.tags[INTERACTION_TAG_TOOL_CALL_ID]);
    const face = env.taskRefs.get('main')?.value;
    if (face === undefined) throw new Error('no task facade');
    await vi.waitFor(() => {
      expect(face.records.value.get(taskId)?.status).toBe('running');
    });
    await face.stop(taskId, 'test stop');
    await vi.waitFor(() => {
      expect(face.records.value.get(taskId)?.status).toBe('completed');
    });
    expect(face.records.value.get(taskId)?.output).toBe(
      JSON.stringify({ answers: {}, note: 'User dismissed the question without answering.' }),
    );
    await env.harness.close();
  });
});

function capturePermission(): { feature: Feature; face(sessionId: string): PermissionFace } {
  const refs = new Map<string, Readonly<ShallowRef<PermissionFace | undefined>>>();
  const feature = createFeature('permission-capture', {
    session: () => {
      refs.set(useSession().id, useInject(PermissionRef));
    },
  });
  return {
    feature,
    face: (sessionId) => {
      const face = refs.get(sessionId)?.value;
      if (face === undefined) {
        throw new Error(`no permission facade captured for session '${sessionId}'`);
      }
      return face;
    },
  };
}

describe('AskUserQuestion auto permission mode', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function startAutoModeEnv() {
    const harness = createApp({ space: memorySessionSpace() });
    const capture = captureInteractions();
    const permissionProbe = capturePermission();
    harness.features.add(interaction);
    harness.features.add(createPermission());
    harness.features.add(capture.feature);
    harness.features.add(permissionProbe.feature);
    await harness.open('s1');
    const session = liveSession(harness, 's1');
    const { agent } = await session.ensureAgent('main');
    const interactions = interactionsOf(capture.refs, 's1');
    const face = permissionProbe.face('s1');
    const reminders = (): string[] =>
      agent.view
        .getState()
        .messages.filter(
          (entry) => entry.meta?.source === 'reminder' && entry.meta?.key === PERMISSION_REMIND_KEY,
        )
        .map((entry) => extractText(entry.message));
    const runTurn = async (queue: ScriptStep[], text: string) => {
      setRequester(harness, 's1', 'main', scriptedRequester(queue));
      const outcome = await agent.loop.runTurn(user(text));
      expect(outcome.type).toBe('done');
      await agent.flush();
    };
    return { harness, agent, interactions, face, reminders, runTurn };
  }

  it('blocks the tool while auto mode is active and reminds on enter and exit', async () => {
    const env = await startAutoModeEnv();
    const toolResults = (): string[] =>
      env.agent.view
        .getState()
        .messages.filter((entry) => entry.message.role === 'tool')
        .map((entry) => extractText(entry.message));

    await env.face.setMode('auto');
    await env.runTurn(
      [
        { toolCall: { name: 'AskUserQuestion', arguments: JSON.stringify(askArgs()) } },
        { text: 'done' },
      ],
      'ask',
    );
    expect(env.interactions.findAll({ kind: 'question' })).toHaveLength(0);
    expect(toolResults().at(-1)).toBe(AUTO_MODE_ASK_USER_QUESTION_DISABLED);
    expect(env.reminders()).toHaveLength(1);
    expect(env.reminders()[0]).toContain('Auto permission mode is active.');

    await env.face.setMode('manual');
    setRequester(
      env.harness,
      's1',
      'main',
      scriptedRequester([
        { toolCall: { name: 'AskUserQuestion', arguments: JSON.stringify(askArgs()) } },
        { text: 'done' },
      ]),
    );
    const allowed = env.agent.loop.runTurn(user('ask again'));
    const pending = await pendingQuestion(env.interactions);
    env.interactions.respond(pending.id, { answers: { 'Which database?': 'Postgres' } });
    expect((await allowed).type).toBe('done');
    await env.agent.flush();
    expect(env.reminders()).toHaveLength(2);
    expect(env.reminders()[1]).toContain('Auto permission mode is no longer active.');
    await env.harness.close();
  });

  it('dedups the reminder across steps and honors the env switch', async () => {
    const env = await startAutoModeEnv();
    await env.face.setMode('auto');
    await env.runTurn([{ text: 'ok' }], 'go');
    expect(env.reminders()).toHaveLength(1);
    await env.runTurn([{ text: 'ok' }], 'go again');
    expect(env.reminders()).toHaveLength(1);
    await env.face.setMode('manual');
    await env.runTurn([{ text: 'ok' }], 'once more');
    expect(env.reminders()).toHaveLength(2);
    expect(env.reminders()[1]).toContain('Auto permission mode is no longer active.');
    await env.harness.close();

    vi.stubEnv(PERMISSION_MODE_REMINDER_ENV, 'false');
    const off = await startAutoModeEnv();
    await off.face.setMode('auto');
    await off.runTurn([{ text: 'ok' }], 'go');
    expect(off.reminders()).toHaveLength(0);
    await off.harness.close();
  });
});
