import {
  IAgentActivityView,
  IAgentGoalService,
  IAgentInteractionService,
  IAgentLifecycleService,
  IAgentLoopService,
  IAgentPermissionModeService,
  IAgentProfileService,
  IAgentPromptService,
  IAgentScopeContext,
  IAgentStateService,
  IAgentTaskService,
  IAgentTodoService,
  IEventBus,
  ISessionActivityView,
  ISessionTokenCountingService,
  ISessionUsageService,
  makeAgentScopeContext,
  type AgentContext,
  type Event2,
  type Interaction,
  type ISessionScopeHandle,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { Emitter, Event } from '@moonshot-ai/agent-core-v2/_base/event';
import { describe, expect, it, vi } from 'vitest';

import { serverMessageSchema, type ServerMessage } from '../../src/protocol/messages';
import { AgentMessageProjector } from '../../src/services/projection/agentProjector';
import type { ProjectionBusEvent } from '../../src/services/projection/events';
import { foldWireTurn, type ContextRecord } from '../../src/services/projection/heal';
import { SessionProjection } from '../../src/services/projection/sessionProjection';
import { SessionStateAggregator } from '../../src/services/projection/sessionState';

const SESSION = 's1';
const T0 = 1_700_000_000_000;

function ev(payload: Record<string, unknown>): ProjectionBusEvent {
  return { time: T0, ...payload } as unknown as ProjectionBusEvent;
}

function feed(
  projector: AgentMessageProjector,
  event: ProjectionBusEvent,
  sink: ServerMessage[],
): void {
  for (const message of projector.map(event)) {
    sink.push(serverMessageSchema.parse(message));
  }
}

function feedAll(
  projector: AgentMessageProjector,
  events: readonly ProjectionBusEvent[],
): ServerMessage[] {
  const sink: ServerMessage[] = [];
  for (const event of events) feed(projector, event, sink);
  return sink;
}

function ofType<T extends ServerMessage['type']>(
  messages: readonly ServerMessage[],
  type: T,
): Extract<ServerMessage, { type: T }>[] {
  return messages.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
}

function makeProjector(agentId = 'main'): AgentMessageProjector {
  return new AgentMessageProjector(agentId, SESSION, new Map());
}

function runFullTurn(projector: AgentMessageProjector, sink: ServerMessage[]): void {
  feed(
    projector,
    ev({ type: 'turn.started', turnId: 1, promptId: 'p1', origin: { kind: 'user' }, prompt: 'fix the bug' }),
    sink,
  );
  feed(projector, ev({ type: 'turn.step.started', turnId: 1, step: 1 }), sink);
  feed(projector, ev({ type: 'assistant.delta', turnId: 1, delta: 'Hello' }), sink);
  feed(projector, ev({ type: 'assistant.delta', turnId: 1, delta: ' world' }), sink);
  feed(
    projector,
    ev({ type: 'tool.call.delta', turnId: 1, toolCallId: 'call_1', name: 'Bash', argumentsPart: '{"command":"ls"}' }),
    sink,
  );
  feed(
    projector,
    ev({
      type: 'tool.call.started',
      turnId: 1,
      toolCallId: 'call_1',
      name: 'Bash',
      args: '{"command":"ls"}',
      display: { kind: 'command', command: 'ls' },
    }),
    sink,
  );
  feed(projector, ev({ type: 'tool.result', turnId: 1, toolCallId: 'call_1', output: 'file.txt' }), sink);
  feed(
    projector,
    ev({
      type: 'turn.step.completed',
      turnId: 1,
      step: 1,
      usage: { inputOther: 10, output: 5, inputCacheRead: 2, inputCacheCreation: 1 },
      finishReason: 'stop',
      llmFirstTokenLatencyMs: 100,
      llmStreamDurationMs: 900,
    }),
    sink,
  );
  feed(projector, ev({ type: 'turn.ended', turnId: 1, reason: 'completed', durationMs: 1500 }), sink);
}

describe('AgentMessageProjector', () => {
  it('projects a full turn lifecycle into flat entity messages', () => {
    const projector = makeProjector();
    const messages = feedAll(projector, []);
    runFullTurn(projector, messages);

    const turn = ofType(messages, 'turn')[0]!;
    expect(turn).toMatchObject({
      turn_id: 't1',
      ordinal: 1,
      state: 'running',
      origin: { kind: 'user' },
      user_message_id: 't1.u0',
    });
    const user = ofType(messages, 'user')[0]!;
    expect(user).toMatchObject({ message_id: 't1.u0', turn_id: 't1', text: 'fix the bug', status: 'running' });

    const step = ofType(messages, 'step')[0]!;
    expect(step).toMatchObject({ step_id: 't1.1', turn_id: 't1', ordinal: 1, state: 'running' });

    const assistantOpen = ofType(messages, 'assistant')[0]!;
    expect(assistantOpen).toMatchObject({ message_id: 't1.1.a1', status: 'streaming', text: '' });
    const deltas = ofType(messages, 'assistant.delta');
    expect(deltas.map((d) => d.text)).toEqual(['Hello', ' world']);
    const assistantFinal = ofType(messages, 'assistant').at(-1)!;
    expect(assistantFinal).toMatchObject({ message_id: 't1.1.a1', status: 'completed', text: 'Hello world' });

    const toolRunning = ofType(messages, 'tool_call')[0]!;
    expect(toolRunning).toMatchObject({
      tool_call_id: 'call_1',
      step_id: 't1.1',
      name: 'Bash',
      state: 'running',
      input_text: '{"command":"ls"}',
    });
    const toolDeltas = ofType(messages, 'tool_call.delta');
    expect(toolDeltas.map((d) => d.input_text)).toEqual(['{"command":"ls"}']);
    const toolDone = ofType(messages, 'tool_call').at(-1)!;
    expect(toolDone).toMatchObject({
      state: 'done',
      input: { command: 'ls' },
      output: 'file.txt',
      display: { kind: 'command', command: 'ls' },
    });

    const stepDone = ofType(messages, 'step').at(-1)!;
    expect(stepDone).toMatchObject({
      state: 'completed',
      usage: { input_other: 10, output: 5, input_cache_read: 2, input_cache_creation: 1 },
      finish_reason: 'stop',
      timing: { llm_first_token_ms: 100, llm_stream_duration_ms: 900 },
    });

    const turnDone = ofType(messages, 'turn').at(-1)!;
    expect(turnDone).toMatchObject({
      state: 'completed',
      duration_ms: 1500,
      usage: { input_tokens: 11, output_tokens: 5, cached_tokens: 2 },
    });
    const userDone = ofType(messages, 'user').at(-1)!;
    expect(userDone.status).toBe('completed');
    expect(typeof userDone.finished_at).toBe('string');
    expect(projector.takeEndedTurnOrdinals()).toEqual([1]);
  });

  it('folds a step retry into the retry field of the same running step', () => {
    const projector = makeProjector();
    const messages = feedAll(projector, [
      ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' }, prompt: 'go' }),
      ev({ type: 'turn.step.started', turnId: 1, step: 1 }),
      ev({
        type: 'turn.step.retrying',
        turnId: 1,
        step: 1,
        failedAttempt: 1,
        nextAttempt: 2,
        maxAttempts: 3,
        delayMs: 1000,
        errorName: 'RateLimitError',
        errorMessage: 'slow down',
        statusCode: 429,
      }),
    ]);
    const step = ofType(messages, 'step').at(-1)!;
    expect(step).toMatchObject({
      step_id: 't1.1',
      state: 'running',
      retry: {
        failed_attempt: 1,
        next_attempt: 2,
        max_attempts: 3,
        delay_ms: 1000,
        error_name: 'RateLimitError',
        error_message: 'slow down',
        status_code: 429,
      },
    });
  });

  it('marks the open step interrupted and emits system(interruption) on user cancel', () => {
    const projector = makeProjector();
    const messages = feedAll(projector, [
      ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' }, prompt: 'go' }),
      ev({ type: 'turn.step.started', turnId: 1, step: 1 }),
      ev({ type: 'assistant.delta', turnId: 1, delta: 'partial' }),
      ev({ type: 'turn.ended', turnId: 1, reason: 'cancelled', interruptReason: 'user_cancelled' }),
    ]);
    const step = ofType(messages, 'step').at(-1)!;
    expect(step.state).toBe('interrupted');
    const turn = ofType(messages, 'turn').at(-1)!;
    expect(turn.state).toBe('completed');
    const interruption = ofType(messages, 'system').find((m) => m.subtype === 'interruption');
    expect(interruption).toMatchObject({
      subtype: 'interruption',
      payload: { turn_id: 't1', reason: 'user_cancelled' },
    });
    const assistant = ofType(messages, 'assistant').at(-1)!;
    expect(assistant).toMatchObject({ status: 'completed', text: 'partial' });
  });

  it('links approvals to their tool call and projects pending then resolved interactions', () => {
    const projector = makeProjector();
    const sink: ServerMessage[] = [];
    feed(projector, ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' }, prompt: 'go' }), sink);
    feed(projector, ev({ type: 'turn.step.started', turnId: 1, step: 1 }), sink);
    feed(
      projector,
      ev({ type: 'tool.call.started', turnId: 1, toolCallId: 'call_1', name: 'Bash', args: '{"command":"ls"}' }),
      sink,
    );
    sink.push(
      ...projector.interactionRequested({
        id: 'apr-1',
        kind: 'approval',
        payload: { toolCallId: 'call_1', toolName: 'Bash', action: 'Run ls', display: { kind: 'command' } },
        origin: { agentId: 'main', turnId: 1 },
        createdAt: T0,
      }),
    );
    const pending = ofType(sink, 'interaction').at(-1)!;
    expect(pending).toMatchObject({
      interaction_id: 'apr-1',
      kind: 'approval',
      state: 'pending',
      tool_call_id: 'call_1',
      request: { tool_name: 'Bash', action: 'Run ls', tool_input_display: { kind: 'command' } },
    });
    const toolLinked = ofType(sink, 'tool_call').at(-1)!;
    expect(toolLinked.approval_id).toBe('apr-1');

    sink.push(...projector.interactionResolved('apr-1', { decision: 'approved', scope: 'session' }));
    const resolved = ofType(sink, 'interaction').at(-1)!;
    expect(resolved).toMatchObject({
      state: 'approved',
      response: { decision: 'approved', scope: 'session' },
    });
  });

  it('attaches steer user messages to the running step and buffers them between steps', () => {
    const projector = makeProjector();
    const messages = feedAll(projector, [
      ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' }, prompt: 'do A' }),
      ev({ type: 'turn.step.started', turnId: 1, step: 1 }),
      ev({ type: 'turn.steer', turnId: 1, input: [{ type: 'text', text: 'also B' }], origin: { kind: 'user' } }),
      ev({ type: 'turn.step.completed', turnId: 1, step: 1 }),
      ev({ type: 'turn.steer', turnId: 1, input: [{ type: 'text', text: 'and C' }], origin: { kind: 'user' } }),
      ev({ type: 'turn.step.started', turnId: 1, step: 2 }),
    ]);
    const users = ofType(messages, 'user');
    const steerInStep = users.find((u) => u.message_id === 't1.1.u1');
    expect(steerInStep).toMatchObject({
      turn_id: 't1',
      step_id: 't1.1',
      text: 'also B',
      status: 'running',
    });
    expect(typeof steerInStep?.steered_at).toBe('string');
    const buffered = users.find((u) => u.message_id === 't1.2.u1');
    expect(buffered).toMatchObject({ step_id: 't1.2', text: 'and C' });
  });

  it('maps cron turns and busy cron steers to the cron user origin', () => {
    const projector = makeProjector();
    const messages = feedAll(projector, [
      ev({
        type: 'turn.started',
        turnId: 1,
        origin: { kind: 'cron_job', jobId: 'job-1', cron: '*/5 * * * *', recurring: true, coalescedCount: 0, stale: false },
        prompt: 'check the queue',
      }),
    ]);
    const turn = ofType(messages, 'turn')[0]!;
    expect(turn.origin).toEqual({ kind: 'cron' });
    const user = ofType(messages, 'user')[0]!;
    expect(user).toMatchObject({
      text: 'check the queue',
      origin: { kind: 'cron', cron_id: 'job-1', schedule: '*/5 * * * *' },
    });

    feed(projector, ev({ type: 'turn.step.started', turnId: 1, step: 1 }), messages);
    feed(
      projector,
      ev({
        type: 'turn.steer',
        turnId: 1,
        input: [{ type: 'text', text: 'fire now' }],
        origin: { kind: 'cron_job', jobId: 'job-2', cron: '0 * * * *', recurring: false, coalescedCount: 1, stale: false },
      }),
      messages,
    );
    const steered = ofType(messages, 'user').at(-1)!;
    expect(steered).toMatchObject({
      message_id: 't1.1.u1',
      origin: { kind: 'cron', cron_id: 'job-2', schedule: '0 * * * *' },
    });
    expect(typeof steered.steered_at).toBe('string');

    feed(
      projector,
      ev({
        type: 'turn.started',
        turnId: 2,
        origin: { kind: 'cron_missed', count: 3 },
        prompt: 'missed cron runs',
      }),
      messages,
    );
    const missedTurn = ofType(messages, 'turn').at(-1)!;
    expect(missedTurn.origin).toEqual({ kind: 'cron' });
    const missedUser = ofType(messages, 'user').at(-1)!;
    expect(missedUser).toMatchObject({ text: 'missed cron runs', origin: { kind: 'cron' } });
    expect(missedUser.origin).not.toHaveProperty('cron_id');
  });

  it('covers the three subagent wait modes around the parent tool call', () => {
    const projector = makeProjector();
    const sink: ServerMessage[] = [];
    feed(projector, ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' }, prompt: 'go' }), sink);
    feed(projector, ev({ type: 'turn.step.started', turnId: 1, step: 1 }), sink);
    feed(
      projector,
      ev({ type: 'tool.call.started', turnId: 1, toolCallId: 'call_a', name: 'Agent', args: '{}' }),
      sink,
    );
    feed(
      projector,
      ev({ type: 'subagent.spawned', subagentId: 'sub-a', parentToolCallId: 'call_a', runInBackground: false }),
      sink,
    );
    const toolA = ofType(sink, 'tool_call').at(-1)!;
    expect(toolA.agent_refs).toEqual([{ agent_id: 'sub-a', role: 'child' }]);
    expect(ofType(sink, 'task')).toHaveLength(0);
    feed(
      projector,
      ev({ type: 'subagent.completed', subagentId: 'sub-a', resultSummary: 'done' }),
      sink,
    );
    expect(ofType(sink, 'task')).toHaveLength(0);

    feed(
      projector,
      ev({ type: 'tool.call.started', turnId: 1, toolCallId: 'call_b', name: 'Agent', args: '{}' }),
      sink,
    );
    feed(
      projector,
      ev({
        type: 'subagent.spawned',
        subagentId: 'sub-b',
        parentToolCallId: 'call_b',
        runInBackground: true,
        taskId: 'task-b',
        description: 'watch logs',
      }),
      sink,
    );
    const taskB = ofType(sink, 'task').at(-1)!;
    expect(taskB).toMatchObject({
      task_id: 'task-b',
      kind: 'subagent',
      state: 'running',
      detached: true,
      child_agent_id: 'sub-b',
      description: 'watch logs',
    });
    const toolB = ofType(sink, 'tool_call').at(-1)!;
    expect(toolB.task_id).toBe('task-b');
    feed(
      projector,
      ev({ type: 'subagent.completed', subagentId: 'sub-b', resultSummary: 'tail', usage: { inputOther: 1, output: 2, inputCacheRead: 0, inputCacheCreation: 0 } }),
      sink,
    );
    const taskBDone = ofType(sink, 'task').at(-1)!;
    expect(taskBDone).toMatchObject({ state: 'completed', result_summary: 'tail' });

    feed(
      projector,
      ev({ type: 'tool.call.started', turnId: 1, toolCallId: 'call_c', name: 'Agent', args: '{}' }),
      sink,
    );
    feed(
      projector,
      ev({ type: 'subagent.spawned', subagentId: 'sub-c', parentToolCallId: 'call_c', runInBackground: false }),
      sink,
    );
    feed(
      projector,
      ev({
        type: 'task.started',
        info: {
          taskId: 'task-c',
          kind: 'agent',
          agentId: 'sub-c',
          parentToolCallId: 'call_c',
          status: 'running',
          description: 'detached mid-flight',
          detached: true,
          startedAt: T0 + 5000,
          endedAt: null,
        },
      }),
      sink,
    );
    const taskC = ofType(sink, 'task').at(-1)!;
    expect(taskC).toMatchObject({
      task_id: 'task-c',
      kind: 'subagent',
      detached: true,
      child_agent_id: 'sub-c',
      started_at: new Date(T0).toISOString(),
    });
    const toolC = ofType(sink, 'tool_call').at(-1)!;
    expect(toolC.task_id).toBe('task-c');
  });

  it('drives todo entities from the todo emitter and links TodoList tool calls', () => {
    const projector = makeProjector();
    const sink: ServerMessage[] = [];
    feed(projector, ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' }, prompt: 'go' }), sink);
    feed(projector, ev({ type: 'turn.step.started', turnId: 1, step: 1 }), sink);
    feed(
      projector,
      ev({
        type: 'tool.call.started',
        turnId: 1,
        toolCallId: 'call_1',
        name: 'TodoList',
        args: '{"todos":[{"title":"write tests","status":"in_progress"}]}',
      }),
      sink,
    );
    const tool = ofType(sink, 'tool_call').at(-1)!;
    expect(tool.todo_id).toBe('todo');
    sink.push(...projector.todoChanged([{ title: 'write tests', status: 'in_progress' }]));
    const todo = ofType(sink, 'todo').at(-1)!;
    expect(todo).toMatchObject({
      todo_id: 'todo',
      items: [{ title: 'write tests', status: 'in_progress' }],
    });
    expect(typeof todo.updated_at).toBe('string');
  });

  it('truncates the timeline on context.undone with removed top-level ids', () => {
    const projector = makeProjector();
    const messages = feedAll(projector, [
      ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' }, prompt: 'one' }),
      ev({ type: 'turn.ended', turnId: 1, reason: 'completed' }),
      ev({ type: 'turn.started', turnId: 2, origin: { kind: 'user' }, prompt: 'two' }),
      ev({ type: 'turn.ended', turnId: 2, reason: 'completed' }),
      ev({ type: 'skill.activated', activationId: 'sk-1', skillName: 'review', trigger: 'user-slash' }),
      ev({ type: 'context.undone', turns: 1, fromTurnId: 2 }),
    ]);
    const undo = ofType(messages, 'system').find((m) => m.subtype === 'undo');
    expect(undo).toBeDefined();
    const payload = undo!.payload as { removed_ids: string[] };
    expect(payload.removed_ids[0]).toBe('t2');
    expect(payload.removed_ids.some((id) => id.startsWith('sys_'))).toBe(true);
    expect(payload.removed_ids).not.toContain('t1');

    const fold = {
      steps: new Map([[1, { state: 'completed' as const }]]),
      texts: new Map([[1, { assistant: 'answer', thinking: '', first: 'assistant' as const }]]),
      tools: new Map(),
    };
    expect(projector.healTurn(2, fold)).toEqual([]);
    expect(projector.healTurn(1, fold).length).toBeGreaterThan(0);
  });

  it('settles a full-cut splice as system(clear) unless a context.undone follows', () => {
    const projector = makeProjector();
    const before = feedAll(projector, [
      ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' }, prompt: 'one' }),
      ev({ type: 'turn.ended', turnId: 1, reason: 'completed' }),
    ]);
    expect(ofType(before, 'system')).toHaveLength(0);
    const after = feedAll(projector, [
      ev({ type: 'context.spliced', start: 0, deleteCount: 4, messages: [] }),
      ev({ type: 'turn.started', turnId: 2, origin: { kind: 'user' }, prompt: 'fresh' }),
    ]);
    const clear = ofType(after, 'system').find((m) => m.subtype === 'clear');
    expect(clear).toMatchObject({ subtype: 'clear', payload: { removed_ids: ['t1'] } });

    const projector2 = makeProjector();
    feedAll(projector2, [
      ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' }, prompt: 'one' }),
      ev({ type: 'turn.ended', turnId: 1, reason: 'completed' }),
    ]);
    const undoOnly = feedAll(projector2, [
      ev({ type: 'context.spliced', start: 0, deleteCount: 4, messages: [] }),
      ev({ type: 'context.undone', turns: 1, fromTurnId: 1 }),
    ]);
    expect(ofType(undoOnly, 'system').some((m) => m.subtype === 'clear')).toBe(false);
    expect(ofType(undoOnly, 'system').some((m) => m.subtype === 'undo')).toBe(true);
  });

  it('replays in-flight entities plus state entities as recovery payload', () => {
    const projector = makeProjector();
    const sink: ServerMessage[] = [];
    feed(projector, ev({ type: 'turn.started', turnId: 1, promptId: 'p1', origin: { kind: 'user' }, prompt: 'go' }), sink);
    feed(projector, ev({ type: 'turn.step.started', turnId: 1, step: 1 }), sink);
    feed(projector, ev({ type: 'assistant.delta', turnId: 1, delta: 'Hello' }), sink);
    feed(
      projector,
      ev({ type: 'tool.call.started', turnId: 1, toolCallId: 'call_1', name: 'Bash', args: '{"command":"ls"}' }),
      sink,
    );
    sink.push(
      ...projector.interactionRequested({
        id: 'apr-1',
        kind: 'approval',
        payload: { toolCallId: 'call_1', toolName: 'Bash', action: 'Run ls' },
        origin: {},
        createdAt: T0,
      }),
    );
    sink.push(
      ...projector.seedTask({
        taskId: 'task-1',
        kind: 'process',
        status: 'running',
        description: 'dev server',
        detached: true,
        startedAt: T0,
        endedAt: null,
        command: 'pnpm dev',
        pid: 1,
        exitCode: null,
      } as never),
    );
    sink.push(
      ...projector.seedTask({
        taskId: 'task-2',
        kind: 'process',
        status: 'running',
        description: 'watcher',
        startedAt: T0,
        endedAt: null,
      } as never),
    );
    sink.push(...projector.seedTodo([{ title: 'write tests', status: 'pending' }]));
    feed(projector, ev({ type: 'tool.result', turnId: 1, toolCallId: 'call_1', output: 'file.txt' }), sink);
    feed(
      projector,
      ev({ type: 'tool.call.started', turnId: 1, toolCallId: 'call_2', name: 'Bash', args: '{"command":"pwd"}' }),
      sink,
    );

    const recovery = projector.recoveryMessages().map((m) => serverMessageSchema.parse(m));
    const turn = ofType(recovery, 'turn')[0]!;
    expect(turn).toMatchObject({ turn_id: 't1', state: 'running', user_message_id: 't1.u0' });
    const step = ofType(recovery, 'step')[0]!;
    expect(step).toMatchObject({ step_id: 't1.1', state: 'running' });
    const assistant = ofType(recovery, 'assistant')[0]!;
    expect(assistant).toMatchObject({ message_id: 't1.1.a1', status: 'streaming', text: 'Hello' });
    const tools = ofType(recovery, 'tool_call');
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ tool_call_id: 'call_1', state: 'done', output: 'file.txt' });
    expect(tools[1]).toMatchObject({ tool_call_id: 'call_2', state: 'running' });
    const interaction = ofType(recovery, 'interaction')[0]!;
    expect(interaction).toMatchObject({ interaction_id: 'apr-1', state: 'pending' });
    const tasks = ofType(recovery, 'task');
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({ task_id: 'task-1', kind: 'shell', state: 'running', detached: true });
    expect(tasks[1]).toMatchObject({ task_id: 'task-2', kind: 'shell', state: 'running', detached: false });
    const todo = ofType(recovery, 'todo')[0]!;
    expect(todo.items).toEqual([{ title: 'write tests', status: 'pending' }]);
    expect(ofType(recovery, 'user')).toHaveLength(0);
  });

  it('emits a reserved user message for queued prompts and converges on dequeue or abort', () => {
    const projector = makeProjector();
    const sink: ServerMessage[] = [];
    feed(projector, ev({ type: 'turn.started', turnId: 0, origin: { kind: 'user' }, prompt: 'first' }), sink);
    feed(
      projector,
      ev({
        type: 'prompt.submitted',
        promptId: 'q1',
        userMessageId: 'q1',
        status: 'queued',
        content: [{ type: 'text', text: 'second' }],
        createdAt: new Date(T0).toISOString(),
      }),
      sink,
    );
    feed(
      projector,
      ev({ type: 'prompt.queued', promptId: 'q1', content: [{ type: 'text', text: 'second' }], queueLength: 1 }),
      sink,
    );
    const queued = ofType(sink, 'user').at(-1)!;
    expect(queued).toMatchObject({ message_id: 't1.u0', turn_id: 't1', text: 'second', status: 'running' });
    expect(queued.step_id).toBeUndefined();
    expect([...new Set(ofType(sink, 'turn').map((t) => t.turn_id))]).toEqual(['t0']);

    feed(
      projector,
      ev({ type: 'prompt.queued', promptId: 'q2', content: [{ type: 'text', text: 'third' }], queueLength: 2 }),
      sink,
    );
    expect(ofType(sink, 'user').at(-1)).toMatchObject({ message_id: 't2.u0', status: 'running' });

    feed(projector, ev({ type: 'prompt.aborted', promptId: 'q2', abortedAt: new Date(T0 + 1).toISOString() }), sink);
    expect(ofType(sink, 'user').at(-1)).toMatchObject({ message_id: 't2.u0', status: 'completed' });

    feed(projector, ev({ type: 'turn.ended', turnId: 0, reason: 'completed' }), sink);
    feed(
      projector,
      ev({ type: 'turn.started', turnId: 1, promptId: 'q1', origin: { kind: 'user' }, prompt: 'second' }),
      sink,
    );
    const dequeued = ofType(sink, 'user').at(-1)!;
    expect(dequeued).toMatchObject({ message_id: 't1.u0', turn_id: 't1', text: 'second', status: 'running' });
    expect([...new Set(ofType(sink, 'turn').map((t) => t.turn_id))]).toEqual(['t0', 't1']);
  });

  it('does not masquerade goal continuation turns as user messages', () => {
    const projector = makeProjector();
    const messages = feedAll(projector, [
      ev({
        type: 'turn.started',
        turnId: 1,
        origin: { kind: 'system_trigger', name: 'goal_continuation' },
        prompt: 'continue the goal',
      }),
    ]);
    const turn = ofType(messages, 'turn')[0]!;
    expect(turn).toMatchObject({ turn_id: 't1', origin: { kind: 'goal' } });
    expect(ofType(messages, 'user')).toHaveLength(0);
  });

  it('dedupes the turn-opening steer that repeats the prompt input', () => {
    const projector = makeProjector();
    const messages = feedAll(projector, [
      ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' }, prompt: 'hello' }),
      ev({ type: 'turn.steer', turnId: 1, input: [{ type: 'text', text: 'hello' }], origin: { kind: 'user' } }),
      ev({ type: 'turn.step.started', turnId: 1, step: 1 }),
    ]);
    const users = ofType(messages, 'user');
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ message_id: 't1.u0', text: 'hello' });
  });

  it('settles a full-cut splice as system(clear) after a bounded wait when no undo follows', () => {
    vi.useFakeTimers();
    try {
      const deferred: ServerMessage[] = [];
      const projector = new AgentMessageProjector('main', SESSION, new Map(), undefined, {
        onDeferred: (messages) => deferred.push(...messages),
      });
      const before = feedAll(projector, [
        ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' }, prompt: 'one' }),
        ev({ type: 'turn.ended', turnId: 1, reason: 'completed' }),
        ev({ type: 'context.spliced', start: 0, deleteCount: 4, messages: [] }),
      ]);
      expect(ofType(before, 'system')).toHaveLength(0);
      expect(deferred).toHaveLength(0);
      vi.advanceTimersByTime(150);
      const clear = ofType(deferred, 'system').find((m) => m.subtype === 'clear');
      expect(serverMessageSchema.parse(clear)).toMatchObject({
        subtype: 'clear',
        payload: { removed_ids: ['t1'] },
      });
      projector.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts undo anchors instead of timeline turns when fromTurnId is missing', () => {
    const projector = makeProjector();
    const messages = feedAll(projector, [
      ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' }, prompt: 'one' }),
      ev({ type: 'turn.ended', turnId: 1, reason: 'completed' }),
      ev({ type: 'turn.started', turnId: 2, origin: { kind: 'user' }, prompt: 'two' }),
      ev({ type: 'turn.ended', turnId: 2, reason: 'completed' }),
      ev({
        type: 'turn.started',
        turnId: 3,
        origin: { kind: 'cron_job', jobId: 'j1', cron: '* * * * *' },
        prompt: 'cron',
      }),
      ev({ type: 'turn.ended', turnId: 3, reason: 'completed' }),
      ev({ type: 'context.undone', turns: 1 }),
    ]);
    const undo = ofType(messages, 'system').find((m) => m.subtype === 'undo')!;
    expect(undo.payload).toEqual({ removed_ids: ['t2', 't3'] });
  });

  it('extends undo removal to turns and counters seeded from the wire at bind', () => {
    const projector = makeProjector();
    projector.applyTimelineSeed({
      timelineIds: ['t0', 't1'],
      systemCounts: new Map([['goal', 1]]),
      anchorTurnOrdinals: [0, 1],
      nextTurnId: 2,
    });
    const messages = feedAll(projector, [
      ev({ type: 'turn.started', turnId: 2, origin: { kind: 'user' }, prompt: 'live' }),
      ev({ type: 'turn.ended', turnId: 2, reason: 'completed' }),
      ev({
        type: 'goal.updated',
        snapshot: { objective: 'g', status: 'active', tokensUsed: 0, budget: { tokenBudget: null } },
      }),
      ev({ type: 'context.undone', turns: 1 }),
    ]);
    const undo = ofType(messages, 'system').find((m) => m.subtype === 'undo')!;
    expect(undo.payload).toEqual({ removed_ids: ['t2', 'sys_goal_2'] });
  });
});

describe('foldWireTurn + healTurn', () => {
  const stepBegin = { type: 'step.begin', uuid: 'u1', turnId: '3', step: 1 };
  const records: ContextRecord[] = [
    { type: 'context.append_loop_event', event: stepBegin, time: T0 },
    { type: 'context.append_loop_event', event: { type: 'content.part', stepUuid: 'u1', part: { type: 'think', think: 'hmm' } }, time: T0 + 1 },
    { type: 'context.append_loop_event', event: { type: 'content.part', stepUuid: 'u1', part: { type: 'text', text: 'Hello world' } }, time: T0 + 2 },
    { type: 'context.append_loop_event', event: { type: 'tool.call', stepUuid: 'u1', toolCallId: 'call_1', name: 'Bash', args: '{"command":"ls"}' }, time: T0 + 3 },
    { type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: 'call_1', result: { output: 'interrupted before result', isError: true } }, time: T0 + 4 },
    { type: 'context.append_loop_event', event: { type: 'step.end', uuid: 'u1', finishReason: 'tool_calls', usage: { inputOther: 3, output: 1, inputCacheRead: 0, inputCacheCreation: 0 } }, time: T0 + 5 },
  ];

  it('folds loop-event records into per-turn step, text and tool facts', () => {
    const fold = foldWireTurn(records, 3);
    expect(fold.steps.get(1)).toMatchObject({ state: 'completed', finishReason: 'tool_calls' });
    expect(fold.texts.get(1)).toEqual({ assistant: 'Hello world', thinking: 'hmm', first: 'thinking' });
    expect(fold.tools.get('call_1')).toMatchObject({
      step: 1,
      name: 'Bash',
      output: 'interrupted before result',
      isError: true,
    });
    expect(foldWireTurn(records, 4).steps.size).toBe(0);
  });

  it('overrides only divergent domains: missing tool outcome and truncated live text', () => {
    const projector = makeProjector();
    const sink: ServerMessage[] = [];
    feed(projector, ev({ type: 'turn.started', turnId: 3, origin: { kind: 'user' }, prompt: 'go' }), sink);
    feed(projector, ev({ type: 'turn.step.started', turnId: 3, step: 1 }), sink);
    feed(projector, ev({ type: 'assistant.delta', turnId: 3, delta: 'Hello' }), sink);
    feed(
      projector,
      ev({ type: 'tool.call.started', turnId: 3, toolCallId: 'call_1', name: 'Bash', args: '{"command":"ls"}' }),
      sink,
    );
    feed(projector, ev({ type: 'turn.ended', turnId: 3, reason: 'cancelled', interruptReason: 'aborted' }), sink);

    const healed = projector.healTurn(3, foldWireTurn(records, 3)).map((m) => serverMessageSchema.parse(m));
    const tool = ofType(healed, 'tool_call').at(-1)!;
    expect(tool).toMatchObject({
      tool_call_id: 'call_1',
      state: 'error',
      output: 'interrupted before result',
      error: 'interrupted before result',
      input: { command: 'ls' },
    });
    const assistant = ofType(healed, 'assistant').at(-1)!;
    expect(assistant).toMatchObject({ message_id: 't3.1.a1', status: 'completed', text: 'Hello world' });
    expect(ofType(healed, 'step')).toHaveLength(0);
  });

  it('rebuilds steps the live projection never saw', () => {
    const projector = makeProjector();
    const sink: ServerMessage[] = [];
    feed(projector, ev({ type: 'turn.started', turnId: 3, origin: { kind: 'user' }, prompt: 'go' }), sink);
    feed(projector, ev({ type: 'turn.ended', turnId: 3, reason: 'completed' }), sink);
    const healed = projector.healTurn(3, foldWireTurn(records, 3)).map((m) => serverMessageSchema.parse(m));
    const step = ofType(healed, 'step')[0]!;
    expect(step).toMatchObject({ step_id: 't3.1', state: 'completed', finish_reason: 'tool_calls' });
    const assistant = ofType(healed, 'assistant')[0]!;
    expect(assistant).toMatchObject({ step_id: 't3.1', status: 'completed', text: 'Hello world' });
    const tool = ofType(healed, 'tool_call')[0]!;
    expect(tool).toMatchObject({ tool_call_id: 'call_1', step_id: 't3.1', state: 'error' });
  });
});

describe('SessionStateAggregator', () => {
  it('aggregates session.state slices and dedupes identical emissions', () => {
    const agg = new SessionStateAggregator();
    agg.feedSessionActivity({ busy: true, mainTurnActive: true, pendingInteraction: 'approval' });
    agg.feedSeed({ model: 'kimi-k2', contextTokens: 500, maxContextTokens: 1000, permission: 'yolo' });
    agg.feedMainStatus({ thinkingEffort: 'on', usage: { currentTurn: { inputOther: 1, output: 2, inputCacheRead: 0, inputCacheCreation: 0 } } });
    agg.feedMainActivity({
      lifecycle: 'ready',
      turn: {
        turnId: 2,
        origin: { kind: 'user' },
        phase: 'running',
        step: 1,
        ending: false,
        pendingApprovals: [],
        activeToolCalls: [],
        since: T0,
      },
      background: [],
    });
    const first = agg.changed(SESSION)!;
    expect(first).toMatchObject({
      type: 'session.state',
      busy: true,
      main_turn_active: true,
      pending_interaction: 'approval',
      activity: 'turn',
      model: 'kimi-k2',
      thinking_effort: 'on',
      permission: 'yolo',
      context_tokens: 500,
      max_context_tokens: 1000,
      context_usage: 0.5,
      phase: { kind: 'running', turn_id: 2, step: 1, step_id: 't2.1', since: T0 },
    });
    serverMessageSchema.parse(first);
    expect(agg.changed(SESSION)).toBeUndefined();
    agg.feedMainStatus({ model: 'kimi-k2-turbo' });
    const second = agg.changed(SESSION)!;
    expect(second.model).toBe('kimi-k2-turbo');
    expect(agg.snapshot(SESSION).busy).toBe(true);

    agg.feedSessionActivity({ busy: false, mainTurnActive: false, pendingInteraction: 'none', lastTurnReason: 'failed' });
    expect(agg.changed(SESSION)!.last_turn_reason).toBe('failed');
    agg.feedMainActivity({
      lifecycle: 'ready',
      lastTurn: { turnId: 3, reason: 'blocked', at: T0 },
      background: [],
    });
    const blocked = agg.changed(SESSION)!;
    expect(blocked.last_turn_reason).toBe('blocked');
    expect(serverMessageSchema.parse(blocked).type).toBe('session.state');
    agg.feedMainActivity({ lifecycle: 'ready', background: [] });
    expect(agg.changed(SESSION)!.last_turn_reason).toBe('failed');
  });
});

describe('SessionProjection', () => {
  class FakeBus {
    private readonly handlers = new Set<(event: Event2<any>) => void>();
    subscribe(cb: (event: Event2<any>) => void): { dispose: () => void } {
      this.handlers.add(cb);
      return { dispose: () => this.handlers.delete(cb) };
    }
    emit(event: Event2<any>): void {
      for (const cb of this.handlers) cb(event);
    }
  }

  interface FakeAgent {
    readonly id: string;
    readonly bus: FakeBus;
    readonly todoEmitter: Emitter<readonly { title: string; status: 'pending' | 'in_progress' | 'done' }[]>;
    readonly interactionEmitter: Emitter<{ pending: readonly string[] }>;
    readonly resolveEmitter: Emitter<{ id: string; response: unknown }>;
    pendings: Interaction[];
    planActive: boolean;
    swarmTrigger: string | null;
    readonly accessor: { get: (token: unknown) => unknown };
  }

  function makeAgent(id: string): FakeAgent {
    const bus = new FakeBus();
    const scope = makeAgentScopeContext({ agentId: id, agentScope: `agents/${id}`, generation: 1 });
    const todoEmitter = new Emitter<readonly { title: string; status: 'pending' | 'in_progress' | 'done' }[]>();
    const interactionEmitter = new Emitter<{ pending: readonly string[] }>();
    const resolveEmitter = new Emitter<{ id: string; response: unknown }>();
    const agent: FakeAgent = {
      id,
      bus,
      todoEmitter,
      interactionEmitter,
      resolveEmitter,
      pendings: [],
      planActive: false,
      swarmTrigger: null,
      accessor: {
        get: (token: unknown) => {
          if (token === IEventBus) return bus;
          if (token === IAgentScopeContext) {
            return {
              ...scope,
              scope: (subKey?: string) => {
                if (subKey === 'boom') throw new Error('scope boom');
                return scope.scope(subKey);
              },
            };
          }
          if (token === IAgentLoopService) return { status: () => ({ state: 'idle' }) };
          if (token === IAgentPromptService) return { list: () => ({ active: undefined, pending: [] }) };
          if (token === IAgentTaskService) {
            return { list: () => [], readOutput: async () => 'task tail window' };
          }
          if (token === IAgentTodoService) {
            return { get: () => [], onDidChange: todoEmitter.event };
          }
          if (token === IAgentStateService) {
            return {
              has: (key: { name: string }) => key.name === 'plan' || key.name === 'swarm',
              get: (key: { name: string }) =>
                key.name === 'plan' ? { active: agent.planActive } : agent.swarmTrigger,
            };
          }
          if (token === IAgentInteractionService) {
            return {
              listPending: () => agent.pendings,
              onDidChangePending: interactionEmitter.event,
              onDidResolve: resolveEmitter.event,
            };
          }
          if (token === IAgentActivityView) return { state: () => ({ lifecycle: 'ready', background: [] }) };
          if (token === IAgentPermissionModeService) {
            return { mode: 'manual', onDidChangeMode: Event.None };
          }
          if (token === IAgentProfileService) {
            return {
              getModel: () => 'kimi-k2',
              getEffectiveThinkingLevel: () => 'on',
              getModelCapabilities: () => ({ max_input_tokens: 100_000 }),
            };
          }
          if (token === ISessionUsageService) return { status: () => ({}) };
          if (token === ISessionTokenCountingService) return { statusSize: () => 500 };
          if (token === IAgentGoalService) return { getGoal: () => ({ goal: null }) };
          return undefined;
        },
      },
    };
    return agent;
  }

  function makeSession(agent: FakeAgent): {
    session: ISessionScopeHandle;
    core: Scope;
    activityEmitter: Emitter<{ state: { busy: boolean; mainTurnActive: boolean; pendingInteraction: 'none' | 'approval' | 'question' }; cause: string }>;
  } {
    const manager = {
      list: () => [agent.accessor.get(IAgentScopeContext) as { agentContext: AgentContext }],
      get: (agentId: string) =>
        agentId === agent.id
          ? (agent.accessor.get(IAgentScopeContext) as { agentContext: AgentContext }).agentContext
          : undefined,
      handleOf: (agentId: string) =>
        agentId === agent.id ? { id: agent.id, accessor: agent.accessor } : undefined,
      onDidCreate: Event.None,
      onDidClose: Event.None,
    };
    const agents = {
      ...manager,
      list: () => [(agent.accessor.get(IAgentScopeContext) as { agentContext: AgentContext }).agentContext],
    };
    const activityEmitter = new Emitter<{
      state: { busy: boolean; mainTurnActive: boolean; pendingInteraction: 'none' | 'approval' | 'question' };
      cause: string;
    }>();
    const session = {
      accessor: {
        get: (token: unknown) => {
          if (token === IAgentLifecycleService) return agents;
          if (token === ISessionActivityView) {
            return {
              state: () => ({ busy: false, mainTurnActive: false, pendingInteraction: 'none' }),
              onDidChange: activityEmitter.event,
            };
          }
          return undefined;
        },
      },
    } as unknown as ISessionScopeHandle;
    const core = {
      accessor: {
        get: (token: unknown) => {
          if (token === IAgentLifecycleService) {
            throw new Error('strict DI: IAgentLifecycleService is not registered at app scope');
          }
          return undefined;
        },
      },
    } as unknown as Scope;
    return { session, core, activityEmitter };
  }

  function makeProjection(agent: FakeAgent): {
    projection: SessionProjection;
    received: ServerMessage[];
    logger: { warn: ReturnType<typeof vi.fn> };
    activityEmitter: Emitter<{ state: { busy: boolean; mainTurnActive: boolean; pendingInteraction: 'none' | 'approval' | 'question' }; cause: string }>;
  } {
    const { session, core, activityEmitter } = makeSession(agent);
    const received: ServerMessage[] = [];
    const logger = { warn: vi.fn() };
    const projection = new SessionProjection(SESSION, session, {
      homeDir: '/nonexistent',
      core,
      logger,
    });
    projection.onMessage((message) => received.push(message));
    return { projection, received, logger, activityEmitter };
  }

  it('streams validated timeline messages and session.state through one sequence', async () => {
    const agent = makeAgent('main');
    const { projection, received, logger } = makeProjection(agent);
    agent.bus.emit(ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' }, prompt: 'go' }) as Event2<any>);
    agent.bus.emit(ev({ type: 'turn.step.started', turnId: 1, step: 1 }) as Event2<any>);
    agent.bus.emit(ev({ type: 'assistant.delta', turnId: 1, delta: 'Hi' }) as Event2<any>);
    agent.bus.emit(ev({ type: 'agent.status.updated', agentId: 'main', model: 'kimi-k2' }) as Event2<any>);
    agent.bus.emit(ev({ type: 'agent.status.updated', agentId: 'main', planMode: true }) as Event2<any>);
    agent.bus.emit(
      ev({ type: 'plan.revision', agentId: 'main', id: 'r0', version: 1, key: 'boom', sha256: 'x', bytes: 1 }) as Event2<any>,
    );
    agent.bus.emit(
      ev({ type: 'plan.revision', agentId: 'main', id: 'r1', version: 2, key: 'plan/x.md', sha256: 'abc', bytes: 10 }) as Event2<any>,
    );
    agent.bus.emit(ev({ type: 'turn.ended', turnId: 1, reason: 'completed' }) as Event2<any>);
    agent.bus.emit(
      ev({
        type: 'task.started',
        info: { taskId: 'task-1', kind: 'process', status: 'running', description: 'dev', startedAt: T0, endedAt: null },
      }) as Event2<any>,
    );
    agent.bus.emit(
      ev({
        type: 'task.terminated',
        info: { taskId: 'task-1', kind: 'process', status: 'completed', startedAt: T0, endedAt: T0 + 1 },
      }) as Event2<any>,
    );

    expect(ofType(received, 'turn')[0]).toMatchObject({ turn_id: 't1', state: 'running' });
    expect(ofType(received, 'system').some((m) => m.subtype === 'plan.enter')).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const revision = ofType(received, 'system').find((m) => m.subtype === 'plan.revision');
    expect(revision).toMatchObject({
      subtype: 'plan.revision',
      payload: { id: 'r1', version: 2, path: 'agents/main/plan/x.md' },
    });
    const states = ofType(received, 'session.state');
    expect(states.length).toBeGreaterThan(0);
    expect(states.at(-1)).toMatchObject({
      model: 'kimi-k2',
      context_tokens: 500,
      modes: { plan: { review_path: 'agents/main/plan/x.md', version: 2 } },
    });
    await vi.waitFor(() => {
      expect(ofType(received, 'task').at(-1)).toMatchObject({
        task_id: 'task-1',
        state: 'completed',
        output_tail: 'task tail window',
      });
    });
    const recovery = projection.recoveryMessages();
    expect(recovery[0]!.type).toBe('session.state');
    projection.dispose();
  });

  it('emits the interaction lifecycle and drops outbound messages that fail schema validation', () => {
    const agent = makeAgent('main');
    const { projection, received, logger } = makeProjection(agent);
    agent.pendings = [
      {
        id: 'q-1',
        kind: 'question',
        payload: {
          questions: [
            {
              question: 'pick many',
              options: [{ label: 42 }],
            },
          ],
        },
        origin: { agentId: 'main' },
        createdAt: T0,
      },
    ];
    agent.interactionEmitter.fire({ pending: ['q-1'] });
    expect(ofType(received, 'interaction')).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalled();

    agent.bus.emit(ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' }, prompt: 'go' }) as Event2<any>);
    agent.pendings = [
      {
        id: 'apr-1',
        kind: 'approval',
        payload: { toolCallId: 'call_1', toolName: 'Bash', action: 'Run ls' },
        origin: { agentId: 'main', turnId: 1 },
        createdAt: T0,
      },
    ];
    agent.interactionEmitter.fire({ pending: ['apr-1'] });
    const pending = ofType(received, 'interaction').at(-1)!;
    expect(pending).toMatchObject({ interaction_id: 'apr-1', state: 'pending', kind: 'approval' });

    agent.pendings = [];
    agent.resolveEmitter.fire({ id: 'apr-1', response: { decision: 'rejected', feedback: 'no' } });
    const resolved = ofType(received, 'interaction').at(-1)!;
    expect(resolved).toMatchObject({
      state: 'rejected',
      response: { decision: 'rejected', feedback: 'no' },
    });
    projection.dispose();
  });

  it('seeds plan and swarm modes from agent state at bind without re-emitting enter', () => {
    const agent = makeAgent('main');
    agent.planActive = true;
    agent.swarmTrigger = 'tool';
    const { projection, received } = makeProjection(agent);
    const recovery = projection.recoveryMessages();
    const state = ofType(recovery, 'session.state')[0]!;
    expect(state.modes).toEqual({ plan: {}, swarm: {} });
    expect(
      ofType(received, 'system').filter(
        (m) => m.subtype === 'plan.enter' || m.subtype === 'swarm.enter',
      ),
    ).toHaveLength(0);

    agent.bus.emit(ev({ type: 'agent.status.updated', agentId: 'main', planMode: false, swarmMode: false }) as Event2<any>);
    const subtypes = ofType(received, 'system').map((m) => m.subtype);
    expect(subtypes).not.toContain('plan.exit');
    expect(subtypes).toContain('swarm.exit');

    agent.bus.emit(ev({ type: 'agent.status.updated', agentId: 'main', planMode: true }) as Event2<any>);
    agent.bus.emit(ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' }, prompt: 'go' }) as Event2<any>);
    agent.bus.emit(ev({ type: 'turn.step.started', turnId: 1, step: 1 }) as Event2<any>);
    agent.bus.emit(
      ev({ type: 'tool.call.started', turnId: 1, toolCallId: 'call_plan', name: 'ExitPlanMode', args: '{}' }) as Event2<any>,
    );
    agent.pendings = [
      {
        id: 'apr-plan',
        kind: 'approval',
        payload: { toolCallId: 'call_plan', toolName: 'ExitPlanMode', action: 'review plan' },
        origin: { agentId: 'main', turnId: 1 },
        createdAt: T0,
      },
    ];
    agent.interactionEmitter.fire({ pending: ['apr-plan'] });
    agent.pendings = [];
    agent.resolveEmitter.fire({ id: 'apr-plan', response: { decision: 'rejected', feedback: 'revise' } });
    agent.bus.emit(ev({ type: 'agent.status.updated', agentId: 'main', planMode: false }) as Event2<any>);
    expect(ofType(received, 'system').map((m) => m.subtype)).not.toContain('plan.exit');

    agent.bus.emit(ev({ type: 'agent.status.updated', agentId: 'main', planMode: true }) as Event2<any>);
    agent.pendings = [
      {
        id: 'apr-plan-2',
        kind: 'approval',
        payload: { toolCallId: 'call_plan', toolName: 'ExitPlanMode', action: 'review plan' },
        origin: { agentId: 'main', turnId: 1 },
        createdAt: T0,
      },
    ];
    agent.interactionEmitter.fire({ pending: ['apr-plan-2'] });
    agent.pendings = [];
    agent.resolveEmitter.fire({ id: 'apr-plan-2', response: { decision: 'approved' } });
    agent.bus.emit(ev({ type: 'agent.status.updated', agentId: 'main', planMode: false }) as Event2<any>);
    expect(ofType(received, 'system').map((m) => m.subtype)).toContain('plan.exit');
    projection.dispose();
  });
});
