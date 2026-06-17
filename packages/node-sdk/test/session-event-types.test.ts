import { describe, expectTypeOf, it } from 'vitest';

import type { ApprovalRequest, ApprovalResponse, Event, QuestionRequest } from '#/index';

type EventByType<T extends Event['type']> = Extract<Event, { readonly type: T }>;

describe('Event public types', () => {
  it('narrows assistant deltas by type', () => {
    expectTypeOf<EventByType<'assistant.delta'>['delta']>().toEqualTypeOf<string>();
  });

  it('narrows hook results by type', () => {
    expectTypeOf<EventByType<'hook.result'>['hookEvent']>().toEqualTypeOf<string>();
    expectTypeOf<EventByType<'hook.result'>['content']>().toEqualTypeOf<string>();
    expectTypeOf<EventByType<'hook.result'>['blocked']>().toEqualTypeOf<boolean | undefined>();
  });

  it('narrows tool calls by type', () => {
    expectTypeOf<EventByType<'tool.call.started'>['toolCallId']>().toEqualTypeOf<string>();
    expectTypeOf<EventByType<'tool.call.started'>['name']>().toEqualTypeOf<string>();
    expectTypeOf<EventByType<'tool.call.started'>['args']>().toEqualTypeOf<unknown>();
  });

  it('exposes LLM stream timing on step completion events', () => {
    expectTypeOf<EventByType<'turn.step.completed'>['llmFirstTokenLatencyMs']>().toEqualTypeOf<
      number | undefined
    >();
    expectTypeOf<EventByType<'turn.step.completed'>['llmStreamDurationMs']>().toEqualTypeOf<
      number | undefined
    >();
  });

  it('narrows subagent lifecycle events by type', () => {
    expectTypeOf<EventByType<'subagent.spawned'>['subagentId']>().toEqualTypeOf<string>();
    expectTypeOf<EventByType<'subagent.spawned'>['runInBackground']>().toEqualTypeOf<boolean>();
    expectTypeOf<EventByType<'subagent.suspended'>['reason']>().toEqualTypeOf<string>();
  });

  it('narrows cron fired events by type', () => {
    expectTypeOf<EventByType<'cron.fired'>['prompt']>().toEqualTypeOf<string>();
    expectTypeOf<EventByType<'cron.fired'>['origin']['kind']>().toEqualTypeOf<'cron_job'>();
  });

  it('narrows review events by type', () => {
    expectTypeOf<EventByType<'review.started'>['intensity']>().toEqualTypeOf<
      'standard' | 'thorough' | 'deep'
    >();
    expectTypeOf<EventByType<'review.started'>['agentSwarm']>().toEqualTypeOf<
      { readonly toolCallId: string; readonly args: Record<string, unknown> } | undefined
    >();
    expectTypeOf<EventByType<'review.assignment.progress'>['progress']['status']>()
      .toEqualTypeOf<'active' | 'complete' | 'blocked'>();
    expectTypeOf<EventByType<'review.completed'>['comments'][number]['title']>()
      .toEqualTypeOf<string>();
  });

  it('exposes approval and question reverse-RPC requests', () => {
    expectTypeOf<ApprovalRequest['turnId']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<ApprovalRequest['toolName']>().toEqualTypeOf<string>();
    expectTypeOf<QuestionRequest['questions'][number]['question']>().toEqualTypeOf<string>();
  });

  it('exposes optional session scope on approval responses', () => {
    expectTypeOf<ApprovalResponse['scope']>().toEqualTypeOf<'session' | undefined>();
  });

  it('covers every event in exhaustive switches', () => {
    function handle(event: Event): void {
      switch (event.type) {
        case 'agent.status.updated':
        case 'session.meta.updated':
        case 'goal.updated':
        case 'review.started':
        case 'review.assignment.started':
        case 'review.assignment.progress':
        case 'review.comment.added':
        case 'review.comment.merged':
        case 'review.comment.dismissed':
        case 'review.comment.rejected':
        case 'review.completed':
        case 'review.cancelled':
        case 'review.failed':
        case 'skill.activated':
        case 'error':
        case 'warning':
        case 'turn.started':
        case 'turn.ended':
        case 'turn.step.started':
        case 'turn.step.completed':
        case 'turn.step.retrying':
        case 'turn.step.interrupted':
        case 'assistant.delta':
        case 'hook.result':
        case 'thinking.delta':
        case 'tool.call.delta':
        case 'tool.call.started':
        case 'tool.progress':
        case 'tool.result':
        case 'tool.list.updated':
        case 'mcp.server.status':
        case 'subagent.spawned':
        case 'subagent.started':
        case 'subagent.suspended':
        case 'subagent.completed':
        case 'subagent.failed':
        case 'compaction.started':
        case 'compaction.blocked':
        case 'compaction.cancelled':
        case 'compaction.completed':
        case 'background.task.started':
        case 'background.task.terminated':
        case 'cron.fired':
          return;
        default:
          assertNever(event);
      }
    }

    expectTypeOf(handle).toEqualTypeOf<(event: Event) => void>();
  });
});

function assertNever(value: never): never {
  throw new Error(String(value));
}
