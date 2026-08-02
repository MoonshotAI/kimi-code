import { describe, expectTypeOf, it } from 'vitest';

import type { GoalSnapshot } from '@moonshot-ai/protocol';

import type { ApprovalRequest, ApprovalResponse, Event, QuestionRequest } from '#/index';

type EventByType<T extends Event['type']> = Extract<Event, { readonly type: T }>;

describe('Event public types', () => {
  it('narrows engine turn lifecycle events by type', () => {
    expectTypeOf<EventByType<'session.turn.started'>['turn_id']>().toEqualTypeOf<number>();
    expectTypeOf<EventByType<'session.turn.ended'>['turn_id']>().toEqualTypeOf<number>();
    expectTypeOf<EventByType<'session.turn.ended'>['stop_reason']>().toEqualTypeOf<string>();
    expectTypeOf<EventByType<'session.turn.ended'>['steps']>().toEqualTypeOf<number>();
  });

  it('narrows llm stream events by type', () => {
    expectTypeOf<EventByType<'llm.step.begin'>['model']>().toEqualTypeOf<string>();
    expectTypeOf<EventByType<'llm.delta'>['part']['type']>().toEqualTypeOf<'text' | 'think'>();
    expectTypeOf<EventByType<'llm.delta'>['part']['text']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<EventByType<'llm.delta'>['part']['think']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<EventByType<'llm.step.end'>['content']>().toEqualTypeOf<string>();
  });

  it('narrows hook results by type', () => {
    expectTypeOf<EventByType<'session.hook.result'>['hook_event']>().toEqualTypeOf<string>();
    expectTypeOf<EventByType<'session.hook.result'>['content']>().toEqualTypeOf<string>();
    expectTypeOf<EventByType<'session.hook.result'>['blocked']>().toEqualTypeOf<boolean>();
  });

  it('narrows tool calls by type', () => {
    expectTypeOf<EventByType<'session.tool.started'>['tool_call_id']>().toEqualTypeOf<string>();
    expectTypeOf<EventByType<'session.tool.started'>['tool_name']>().toEqualTypeOf<string>();
    expectTypeOf<EventByType<'session.tool.started'>['arguments']>().toEqualTypeOf<unknown>();
    expectTypeOf<EventByType<'session.tool.settled'>['tool_call_id']>().toEqualTypeOf<string>();
    expectTypeOf<EventByType<'session.tool.settled'>['content']>().toEqualTypeOf<string>();
    expectTypeOf<EventByType<'session.tool.settled'>['is_error']>().toEqualTypeOf<boolean>();
  });

  it('exposes usage accounting on engine usage events', () => {
    expectTypeOf<EventByType<'session.usage.updated'>['turn_id']>().toEqualTypeOf<number>();
    expectTypeOf<EventByType<'session.usage.updated'>['input_tokens']>().toEqualTypeOf<number>();
    expectTypeOf<EventByType<'session.usage.updated'>['output_tokens']>().toEqualTypeOf<number>();
    expectTypeOf<EventByType<'session.usage.updated'>['total_tokens']>().toEqualTypeOf<number>();
  });

  it('narrows task lifecycle events by type', () => {
    expectTypeOf<EventByType<'session.task.started'>['task_id']>().toEqualTypeOf<string>();
    expectTypeOf<EventByType<'session.task.started'>['description']>().toEqualTypeOf<string>();
    expectTypeOf<EventByType<'session.task.started'>['kind']>().toEqualTypeOf<string>();
    expectTypeOf<EventByType<'session.task.started'>['started_at_ms']>().toEqualTypeOf<number>();
    expectTypeOf<EventByType<'session.task.terminated'>['task_id']>().toEqualTypeOf<string>();
    expectTypeOf<EventByType<'session.task.terminated'>['status']>().toEqualTypeOf<string>();
  });

  it('narrows engine shell output and compaction events by type', () => {
    expectTypeOf<EventByType<'session.shell.output'>['command_id']>().toEqualTypeOf<string>();
    expectTypeOf<EventByType<'session.shell.output'>['chunk']>().toEqualTypeOf<string>();
    expectTypeOf<EventByType<'session.compaction.started'>['source']>().toEqualTypeOf<string>();
    expectTypeOf<EventByType<'session.compaction.started'>['tokens_before']>().toEqualTypeOf<number>();
  });

  it('narrows goal updates by type', () => {
    expectTypeOf<EventByType<'session.goal.updated'>['status']>().toEqualTypeOf<string>();
    expectTypeOf<EventByType<'session.goal.updated'>['snapshot']>().toEqualTypeOf<GoalSnapshot | null>();
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
        case 'error':
        case 'warning':
        case 'agent.status.updated':
        case 'event.session.created':
        case 'event.session.status_changed':
        case 'event.session.work_changed':
        case 'event.workspace.created':
        case 'event.workspace.updated':
        case 'event.workspace.deleted':
        case 'event.config.changed':
        case 'event.model_catalog.changed':
        case 'session.turn.started':
        case 'session.turn.ended':
        case 'llm.step.begin':
        case 'llm.delta':
        case 'llm.step.end':
        case 'session.tool.started':
        case 'session.tool.settled':
        case 'session.goal.updated':
        case 'session.task.started':
        case 'session.task.terminated':
        case 'session.usage.updated':
        case 'session.hook.result':
        case 'session.compaction.started':
        case 'session.shell.output':
        case 'session.meta.updated':
        case 'config.update':
        case 'permission.set_mode':
        case 'turn.steer':
        case 'session.closed':
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
