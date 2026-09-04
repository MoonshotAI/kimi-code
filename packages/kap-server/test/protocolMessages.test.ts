import { describe, expect, it } from 'vitest';

import {
  ackMessageSchema,
  assistantDeltaMessageSchema,
  assistantMessageSchema,
  capabilityMessageSchema,
  clientMessageSchema,
  configMessageSchema,
  configWarningMessageSchema,
  errorMessageSchema,
  helloMessageSchema,
  historyQuerySchema,
  historyResponseSchema,
  interactionMessageSchema,
  modelCatalogMessageSchema,
  pluginMessageSchema,
  serverMessageSchema,
  sessionMessageSchema,
  sessionStateMessageSchema,
  stepMessageSchema,
  subscribeMessageSchema,
  systemMessageSchema,
  taskMessageSchema,
  thinkingDeltaMessageSchema,
  thinkingMessageSchema,
  todoMessageSchema,
  toolCallDeltaMessageSchema,
  toolCallMessageSchema,
  toolProgressMessageSchema,
  turnMessageSchema,
  unsubscribeMessageSchema,
  userMessageSchema,
  workspaceMessageSchema,
} from '../src/protocol/messages';

const TS = '2026-09-04T08:00:00.000Z';

const timeline = {
  session_id: 'sess_1',
  agent_id: 'agent_1',
  timestamp: TS,
};

const sessionScope = {
  session_id: 'sess_1',
  timestamp: TS,
};

const globalScope = {
  timestamp: TS,
};

const sessionInfo = {
  id: 'sess_1',
  workspace_id: 'wd_example_0123456789ab',
  title: 'demo',
  created_at: TS,
  updated_at: TS,
  busy: false,
  metadata: { cwd: '/repo' },
  agent_config: { model: 'kimi-k2' },
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    context_tokens: 0,
  },
  permission_rules: [],
  message_count: 0,
  last_seq: 0,
};

const turn = {
  type: 'turn',
  ...timeline,
  turn_id: 't1',
  ordinal: 0,
  state: 'running',
  origin: { kind: 'user' },
};

const step = {
  type: 'step',
  ...timeline,
  step_id: 't1.0',
  turn_id: 't1',
  ordinal: 0,
  state: 'running',
};

const user = {
  type: 'user',
  ...timeline,
  message_id: 't1.u0',
  turn_id: 't1',
  text: 'hello',
  status: 'running',
  created_at: TS,
};

const assistant = {
  type: 'assistant',
  ...timeline,
  message_id: 't1.0.a0',
  turn_id: 't1',
  step_id: 't1.0',
  status: 'streaming',
  text: 'partial',
};

const assistantDelta = {
  type: 'assistant.delta',
  ...timeline,
  message_id: 't1.0.a0',
  text: ' chunk',
};

const thinking = {
  type: 'thinking',
  ...timeline,
  message_id: 't1.0.a1',
  turn_id: 't1',
  step_id: 't1.0',
  status: 'completed',
  text: 'reasoning',
};

const thinkingDelta = {
  type: 'thinking.delta',
  ...timeline,
  message_id: 't1.0.a1',
  text: ' bit',
};

const toolCall = {
  type: 'tool_call',
  ...timeline,
  tool_call_id: 'tc1',
  turn_id: 't1',
  step_id: 't1.0',
  name: 'Bash',
  state: 'running',
};

const toolCallDelta = {
  type: 'tool_call.delta',
  ...timeline,
  tool_call_id: 'tc1',
  input_text: '{"command":"ls',
};

const toolProgress = {
  type: 'tool.progress',
  ...timeline,
  tool_call_id: 'tc1',
  progress: { kind: 'stdout', text: 'line' },
};

const systemUndo = {
  type: 'system',
  ...timeline,
  system_id: 'sys1',
  subtype: 'undo',
  payload: { removed_ids: ['t1'] },
};

const systemNotice = {
  type: 'system',
  ...timeline,
  system_id: 'sys2',
  subtype: 'notice',
  payload: { text: 'heads up' },
};

const interactionApproval = {
  type: 'interaction',
  ...timeline,
  interaction_id: 'ia1',
  kind: 'approval',
  state: 'pending',
  tool_call_id: 'tc1',
  request: { tool_name: 'Bash', action: 'run command', tool_input_display: { command: 'ls' } },
};

const interactionQuestion = {
  type: 'interaction',
  ...timeline,
  interaction_id: 'ia2',
  kind: 'question',
  state: 'pending',
  request: {
    questions: [
      {
        id: 'q_0',
        question: 'pick one',
        options: [
          { id: 'opt_0_0', label: 'a' },
          { id: 'opt_0_1', label: 'b' },
          { id: 'opt_0_2', label: 'c' },
          { id: 'opt_0_3', label: 'd' },
          { id: 'opt_0_4', label: 'e' },
        ],
      },
    ],
  },
};

const task = {
  type: 'task',
  ...timeline,
  task_id: 'task1',
  kind: 'shell',
  state: 'running',
  detached: true,
  output_tail: 'tail',
};

const todo = {
  type: 'todo',
  ...timeline,
  todo_id: 'todo1',
  items: [{ title: 'write tests', status: 'in_progress' }],
};

const sessionState = {
  type: 'session.state',
  ...sessionScope,
  busy: true,
  main_turn_active: true,
  activity: 'turn',
  phase: { kind: 'running', turn_id: 1, step: 0, step_id: 't1.0', since: 1756963200000 },
};

const session = {
  type: 'session',
  ...globalScope,
  subtype: 'created',
  session: sessionInfo,
};

const workspace = {
  type: 'workspace',
  ...globalScope,
  subtype: 'updated',
  workspace: {
    id: 'wd_example_0123456789ab',
    root: '/repo',
    name: 'repo',
    created_at: TS,
    last_opened_at: TS,
    session_count: 1,
  },
};

const config = {
  type: 'config',
  ...globalScope,
  config: { model: 'kimi-k2' },
};

const configWarning = {
  type: 'config.warning',
  ...globalScope,
  warnings: ['deprecated key'],
};

const modelCatalog = {
  type: 'model_catalog',
  ...globalScope,
};

const plugin = {
  type: 'plugin',
  ...globalScope,
};

const capability = {
  type: 'capability',
  ...globalScope,
  capability_id: 'cap1',
};

const hello = {
  type: 'hello',
  protocol_version: '3',
  server_id: 'srv1',
  capabilities: ['step_replay_v1'],
};

const ack = {
  type: 'ack',
  id: 1,
  code: 0,
};

const error = {
  type: 'error',
  code: 40001,
  msg: 'validation failed',
};

const subscribe = {
  type: 'subscribe',
  id: 1,
  session_id: 'sess_1',
};

const unsubscribe = {
  type: 'unsubscribe',
  id: 2,
  session_id: 'sess_1',
};

const serverCases = [
  ['turn', turnMessageSchema, turn],
  ['step', stepMessageSchema, step],
  ['user', userMessageSchema, user],
  ['assistant', assistantMessageSchema, assistant],
  ['assistant.delta', assistantDeltaMessageSchema, assistantDelta],
  ['thinking', thinkingMessageSchema, thinking],
  ['thinking.delta', thinkingDeltaMessageSchema, thinkingDelta],
  ['tool_call', toolCallMessageSchema, toolCall],
  ['tool_call.delta', toolCallDeltaMessageSchema, toolCallDelta],
  ['tool.progress', toolProgressMessageSchema, toolProgress],
  ['system(undo)', systemMessageSchema, systemUndo],
  ['system(notice)', systemMessageSchema, systemNotice],
  ['interaction(approval)', interactionMessageSchema, interactionApproval],
  ['interaction(question)', interactionMessageSchema, interactionQuestion],
  ['task', taskMessageSchema, task],
  ['todo', todoMessageSchema, todo],
  ['session.state', sessionStateMessageSchema, sessionState],
  ['session', sessionMessageSchema, session],
  ['workspace', workspaceMessageSchema, workspace],
  ['config', configMessageSchema, config],
  ['config.warning', configWarningMessageSchema, configWarning],
  ['model_catalog', modelCatalogMessageSchema, modelCatalog],
  ['plugin', pluginMessageSchema, plugin],
  ['capability', capabilityMessageSchema, capability],
  ['hello', helloMessageSchema, hello],
  ['ack', ackMessageSchema, ack],
  ['error', errorMessageSchema, error],
] as const;

const serverNegativeCases = [
  ['turn missing origin', turnMessageSchema, { ...turn, origin: undefined }],
  ['step bad state', stepMessageSchema, { ...step, state: 'cancelled' }],
  ['user missing created_at', userMessageSchema, { ...user, created_at: undefined }],
  ['assistant missing text', assistantMessageSchema, { ...assistant, text: undefined }],
  ['assistant.delta missing text', assistantDeltaMessageSchema, { ...assistantDelta, text: undefined }],
  ['thinking bad status', thinkingMessageSchema, { ...thinking, status: 'done' }],
  ['thinking.delta missing message_id', thinkingDeltaMessageSchema, { ...thinkingDelta, message_id: undefined }],
  ['tool_call missing name', toolCallMessageSchema, { ...toolCall, name: undefined }],
  ['tool_call.delta missing input_text', toolCallDeltaMessageSchema, { ...toolCallDelta, input_text: undefined }],
  ['tool.progress bad kind', toolProgressMessageSchema, { ...toolProgress, progress: { kind: 'unknown' } }],
  ['system undo missing payload', systemMessageSchema, { ...systemUndo, payload: undefined }],
  ['interaction wrong kind', interactionMessageSchema, { ...interactionApproval, kind: 'command' }],
  ['task missing output_tail', taskMessageSchema, { ...task, output_tail: undefined }],
  ['todo bad item status', todoMessageSchema, { ...todo, items: [{ title: 'x', status: 'doing' }] }],
  ['session.state missing activity', sessionStateMessageSchema, { ...sessionState, activity: undefined }],
  ['session bad subtype', sessionMessageSchema, { ...session, subtype: 'renamed' }],
  ['workspace bad id', workspaceMessageSchema, { ...workspace, workspace: { ...workspace.workspace, id: 'ws_1' } }],
  ['config missing config', configMessageSchema, { ...config, config: undefined }],
  ['config.warning missing warnings', configWarningMessageSchema, { ...configWarning, warnings: undefined }],
  ['model_catalog missing timestamp', modelCatalogMessageSchema, { ...modelCatalog, timestamp: undefined }],
  ['plugin missing timestamp', pluginMessageSchema, { ...plugin, timestamp: undefined }],
  ['capability bad capability_id', capabilityMessageSchema, { ...capability, capability_id: 7 }],
  ['hello missing capabilities', helloMessageSchema, { ...hello, capabilities: undefined }],
  ['ack bad code', ackMessageSchema, { ...ack, code: '0' }],
  ['error missing msg', errorMessageSchema, { ...error, msg: undefined }],
] as const;

describe('serverMessageSchema', () => {
  it.each(serverCases)('accepts %s', (_label, schema, message) => {
    expect(schema.safeParse(message).success).toBe(true);
    const parsed = serverMessageSchema.safeParse(message);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe(message.type);
    }
  });

  it.each(serverNegativeCases)('rejects %s', (_label, schema, message) => {
    expect(schema.safeParse(message).success).toBe(false);
    expect(serverMessageSchema.safeParse(message).success).toBe(false);
  });

  it('rejects unknown message types', () => {
    expect(serverMessageSchema.safeParse({ type: 'future.message', ...globalScope }).success).toBe(false);
  });

  it('rejects messages without a type discriminator', () => {
    expect(serverMessageSchema.safeParse({ ...globalScope }).success).toBe(false);
  });

  it('tolerates unknown fields for open evolution', () => {
    const evolved = {
      ...turn,
      future_field: 1,
      origin: { kind: 'user', future_flag: true },
      usage: { input_tokens: 3, future_counter: 9 },
    };
    const parsed = serverMessageSchema.safeParse(evolved);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect('future_field' in parsed.data).toBe(false);
      expect('future_counter' in (parsed.data as { usage?: object }).usage!).toBe(false);
    }
  });
});

describe('clientMessageSchema', () => {
  it('accepts subscribe and unsubscribe', () => {
    expect(clientMessageSchema.safeParse(subscribe).success).toBe(true);
    expect(clientMessageSchema.safeParse(unsubscribe).success).toBe(true);
    expect(subscribeMessageSchema.safeParse({ ...subscribe, agent_ids: ['a1'], omit: ['assistant.delta'] }).success).toBe(true);
  });

  it('rejects entity and server-only control messages', () => {
    expect(clientMessageSchema.safeParse(turn).success).toBe(false);
    expect(clientMessageSchema.safeParse(hello).success).toBe(false);
    expect(clientMessageSchema.safeParse(ack).success).toBe(false);
  });

  it('rejects malformed subscriptions', () => {
    expect(subscribeMessageSchema.safeParse({ ...subscribe, id: '1' }).success).toBe(false);
    expect(subscribeMessageSchema.safeParse({ ...subscribe, session_id: undefined }).success).toBe(false);
    expect(unsubscribeMessageSchema.safeParse({ ...unsubscribe, session_id: '' }).success).toBe(false);
  });
});

describe('systemMessageSchema payload discrimination', () => {
  it('requires removed_ids for undo and clear', () => {
    expect(systemMessageSchema.safeParse(systemUndo).success).toBe(true);
    expect(systemMessageSchema.safeParse({ ...systemUndo, subtype: 'clear' }).success).toBe(true);
    expect(systemMessageSchema.safeParse({ ...systemUndo, payload: {} }).success).toBe(false);
    expect(systemMessageSchema.safeParse({ ...systemUndo, payload: { removed_ids: 't1' } }).success).toBe(false);
  });

  it('allows arbitrary payloads for open subtypes', () => {
    expect(systemMessageSchema.safeParse(systemNotice).success).toBe(true);
    expect(systemMessageSchema.safeParse({ ...systemNotice, payload: undefined }).success).toBe(true);
    expect(systemMessageSchema.safeParse({ ...systemNotice, subtype: 'interruption', payload: { reason: 'aborted' } }).success).toBe(true);
  });

  it('rejects unknown subtypes', () => {
    expect(systemMessageSchema.safeParse({ ...systemNotice, subtype: 'explosion' }).success).toBe(false);
  });
});

describe('interactionMessageSchema kind discrimination', () => {
  it('binds request and response shapes to kind', () => {
    expect(interactionMessageSchema.safeParse(interactionApproval).success).toBe(true);
    expect(interactionMessageSchema.safeParse(interactionQuestion).success).toBe(true);
    expect(
      interactionMessageSchema.safeParse({ ...interactionApproval, request: interactionQuestion.request }).success,
    ).toBe(false);
    expect(
      interactionMessageSchema.safeParse({ ...interactionQuestion, request: interactionApproval.request }).success,
    ).toBe(false);
    expect(
      interactionMessageSchema.safeParse({
        ...interactionQuestion,
        state: 'answered',
        response: { answers: { q_0: { kind: 'single', option_id: 'opt_0_0' } } },
      }).success,
    ).toBe(true);
    expect(
      interactionMessageSchema.safeParse({
        ...interactionApproval,
        state: 'approved',
        response: { answers: {} },
      }).success,
    ).toBe(false);
  });
});

describe('historyResponseSchema', () => {
  it('accepts a timeline entity page with in_flight marker', () => {
    const page = {
      messages: [turn, step, user, assistant, thinking, toolCall, systemUndo, interactionApproval, task, todo],
      in_flight: { turn_id: 't2', step_id: 't2.0' },
    };
    expect(historyResponseSchema.safeParse(page).success).toBe(true);
    expect(historyResponseSchema.safeParse({ messages: [] }).success).toBe(true);
  });

  it('rejects volatile and non-persisted entities in history', () => {
    expect(historyResponseSchema.safeParse({ messages: [assistantDelta] }).success).toBe(false);
    expect(historyResponseSchema.safeParse({ messages: [toolProgress] }).success).toBe(false);
  });

  it('validates cursor query params', () => {
    expect(historyQuerySchema.safeParse({ before_turn: 't4', page_size: 50 }).success).toBe(true);
    expect(historyQuerySchema.safeParse({ after_step: 't4.2' }).success).toBe(true);
    expect(historyQuerySchema.safeParse({}).success).toBe(true);
    expect(historyQuerySchema.safeParse({ page_size: 0 }).success).toBe(false);
    expect(historyQuerySchema.safeParse({ page_size: 1.5 }).success).toBe(false);
  });
});

describe('timestamp contract', () => {
  it('rejects non-ISO-8601 timestamps', () => {
    expect(turnMessageSchema.safeParse({ ...turn, timestamp: 'not-a-date' }).success).toBe(false);
    expect(turnMessageSchema.safeParse({ ...turn, timestamp: 1756963200000 }).success).toBe(false);
  });

  it('normalizes offset timestamps to UTC', () => {
    const parsed = turnMessageSchema.safeParse({ ...turn, timestamp: '2026-09-04T16:00:00+08:00' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.timestamp).toBe(TS);
    }
  });
});
