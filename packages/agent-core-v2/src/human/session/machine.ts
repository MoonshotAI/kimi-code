import {
  assign,
  emit,
  sendTo,
  setup,
  type ActorRefFrom,
  type ActorRefFromLogic,
  type AnyActorLogic,
  type DoneActorEvent,
  type InputFrom,
} from '#/xstate2';

import type { createAgentMachine, AgentEvent, AgentInput } from '#/agent/machine';
import type { LlmRequestConfig } from '#/llm/requester/requester';
import type { TurnLlmEvent, TurnToolEvent } from '#/agent/turn';
import type { ToolUpdate } from '#/tool/executor';

export interface SessionInput {
  request: LlmRequestConfig;
}

export type AgentLogic = ReturnType<typeof createAgentMachine>;

export type AgentActorRef = ActorRefFrom<AgentLogic>;

export interface AgentEntry {
  ref: AgentActorRef;
  logic: AgentLogic;
  input: AgentInput;
  pendingRestart?: boolean;
}

export type SessionEvent =
  | TurnLlmEvent
  | TurnToolEvent
  | { type: 'tool.update'; toolCallId: string; update: ToolUpdate }
  | { type: 'agent.create'; agentId?: string; logic: AgentLogic; input: AgentInput }
  | { type: 'agent.fork'; sourceId: string; agentId?: string; logic: AgentLogic; input: AgentInput }
  | { type: 'agent.restart'; agentId: string }
  | { type: 'agent.send'; agentId: string; event: AgentEvent }
  | { type: 'agent.stop'; agentId: string }
  | DoneActorEvent;

export type SessionEmitted =
  | { type: 'agent.created'; agentId: string; branchId: string; ref: AgentActorRef }
  | { type: 'agent.forked'; sourceId: string; agentId: string; branchId: string; ref: AgentActorRef }
  | { type: 'agent.restarted'; agentId: string; ref: AgentActorRef }
  | { type: 'agent.stopped'; agentId: string }
  | { type: 'agent.failed'; agentId: string; error: string };

export interface SessionMachineContext {
  input: SessionInput;
  agents: Record<string, AgentEntry>;
  anonymousCount: number;
}

function nextAnonymousCount(context: SessionMachineContext): number {
  let count = context.anonymousCount + 1;
  while (context.agents[`agent-${count}`] !== undefined) {
    count += 1;
  }
  return count;
}

type SpawnChild = <TLogic extends AnyActorLogic>(
  logic: TLogic,
  options: { id: string; input: InputFrom<TLogic> },
) => ActorRefFromLogic<TLogic>;

export function createSessionMachine() {
  return setup({
    types: {
      input: {} as SessionInput,
      context: {} as SessionMachineContext,
      events: {} as SessionEvent,
      emitted: {} as SessionEmitted,
    },
  }).createMachine({
    id: 'session',
    initial: 'active',
    context: ({ input }) => ({
      input,
      agents: {},
      anonymousCount: 0,
    }),
    on: {
      'llm.sent': {},
      'llm.streaming.*': {},
      'llm.done': {},
      'llm.failed.syntax': {},
      'llm.failed.remote': {},
      'llm.retrying': {},
      'tool.detached': {},
      'tool.update': {},
      'tool.done': {},
      'tool.failed': {},
      'tool.aborted': {},
      'context.reset': {},
      'store.reset': {},
      'store.error': {},
      'xstate.done.actor.*': [
        {
          guard: ({ context, event }) => context.agents[event.actorId]?.pendingRestart === true,
          actions: [
            assign(({ context, event, spawn }) => {
              const entry = context.agents[event.actorId] as AgentEntry;
              const ref = (spawn as unknown as SpawnChild)(entry.logic, {
                id: event.actorId,
                input: entry.input,
              });
              return {
                agents: {
                  ...context.agents,
                  [event.actorId]: { ref, logic: entry.logic, input: entry.input },
                },
              };
            }),
            emit(({ context, event }) => ({
              type: 'agent.restarted' as const,
              agentId: event.actorId,
              ref: (context.agents[event.actorId] as AgentEntry).ref,
            })),
          ],
        },
        {
          guard: ({ context, event }) => context.agents[event.actorId] !== undefined,
          actions: [
            assign(({ context, event }) => {
              const agents = { ...context.agents };
              delete agents[event.actorId];
              return { agents };
            }),
            emit(({ event }) => ({ type: 'agent.stopped' as const, agentId: event.actorId })),
          ],
        },
      ],
    },
    states: {
      active: {
        on: {
          'agent.create': [
            {
              guard: ({ context, event }) =>
                event.agentId !== undefined && context.agents[event.agentId] !== undefined,
              actions: emit(({ event }) => ({
                type: 'agent.failed' as const,
                agentId: event.agentId as string,
                error: `duplicate agent id: '${event.agentId}'`,
              })),
            },
            {
              actions: [
                assign(({ context, event, spawn }) => {
                  const anonymousCount =
                    event.agentId === undefined
                      ? nextAnonymousCount(context)
                      : context.anonymousCount;
                  const agentId = event.agentId ?? `agent-${anonymousCount}`;
                  const ref = (spawn as unknown as SpawnChild)(event.logic, {
                    id: agentId,
                    input: event.input,
                  });
                  return {
                    agents: {
                      ...context.agents,
                      [agentId]: { ref, logic: event.logic, input: event.input },
                    },
                    anonymousCount,
                  };
                }),
                emit(({ context, event }) => {
                  const agentId = event.agentId ?? `agent-${context.anonymousCount}`;
                  const entry = context.agents[agentId] as AgentEntry;
                  return {
                    type: 'agent.created' as const,
                    agentId,
                    branchId: event.input.store?.ref.branch ?? 'main',
                    ref: entry.ref,
                  };
                }),
              ],
            },
          ],
          'agent.fork': [
            {
              guard: ({ context, event }) =>
                context.agents[event.sourceId] === undefined ||
                (event.agentId !== undefined && context.agents[event.agentId] !== undefined),
              actions: emit(({ context, event }) => ({
                type: 'agent.failed' as const,
                agentId: event.agentId ?? event.sourceId,
                error:
                  context.agents[event.sourceId] === undefined
                    ? `unknown agent: '${event.sourceId}'`
                    : `duplicate agent id: '${event.agentId}'`,
              })),
            },
            {
              actions: [
                assign(({ context, event, spawn }) => {
                  const source = (context.agents[event.sourceId] as AgentEntry).ref.getSnapshot();
                  const anonymousCount =
                    event.agentId === undefined
                      ? nextAnonymousCount(context)
                      : context.anonymousCount;
                  const agentId = event.agentId ?? `agent-${anonymousCount}`;
                  const input: AgentInput = {
                    ...event.input,
                    request: event.input.request ?? source.context.input.request,
                  };
                  const ref = (spawn as unknown as SpawnChild)(event.logic, { id: agentId, input });
                  return {
                    agents: { ...context.agents, [agentId]: { ref, logic: event.logic, input } },
                    anonymousCount,
                  };
                }),
                emit(({ context, event }) => {
                  const agentId = event.agentId ?? `agent-${context.anonymousCount}`;
                  const entry = context.agents[agentId] as AgentEntry;
                  return {
                    type: 'agent.forked' as const,
                    sourceId: event.sourceId,
                    agentId,
                    branchId: event.input.store?.ref.branch ?? 'main',
                    ref: entry.ref,
                  };
                }),
              ],
            },
          ],
          'agent.send': [
            {
              guard: ({ context, event }) => context.agents[event.agentId] === undefined,
              actions: emit(({ event }) => ({
                type: 'agent.failed' as const,
                agentId: event.agentId,
                error: `unknown agent: '${event.agentId}'`,
              })),
            },
            {
              actions: sendTo(
                ({ context, event }) => (context.agents[event.agentId] as AgentEntry).ref,
                ({ event }) => event.event,
              ),
            },
          ],
          'agent.restart': [
            {
              guard: ({ context, event }) => {
                const entry = context.agents[event.agentId];
                return entry === undefined || entry.pendingRestart === true;
              },
              actions: emit(({ context, event }) => ({
                type: 'agent.failed' as const,
                agentId: event.agentId,
                error:
                  context.agents[event.agentId] === undefined
                    ? `unknown agent: '${event.agentId}'`
                    : `agent '${event.agentId}' restart already pending`,
              })),
            },
            {
              actions: [
                assign(({ context, event }) => {
                  const entry = context.agents[event.agentId] as AgentEntry;
                  return {
                    agents: {
                      ...context.agents,
                      [event.agentId]: { ...entry, pendingRestart: true },
                    },
                  };
                }),
                sendTo(
                  ({ context, event }) => (context.agents[event.agentId] as AgentEntry).ref,
                  { type: 'input.close' as const },
                ),
              ],
            },
          ],
          'agent.stop': [
            {
              guard: ({ context, event }) => context.agents[event.agentId] === undefined,
              actions: emit(({ event }) => ({
                type: 'agent.failed' as const,
                agentId: event.agentId,
                error: `unknown agent: '${event.agentId}'`,
              })),
            },
            {
              actions: [
                assign(({ context, event }) => {
                  const entry = context.agents[event.agentId] as AgentEntry;
                  return {
                    agents: {
                      ...context.agents,
                      [event.agentId]: { ...entry, pendingRestart: undefined },
                    },
                  };
                }),
                sendTo(
                  ({ context, event }) => (context.agents[event.agentId] as AgentEntry).ref,
                  { type: 'input.close' as const },
                ),
              ],
            },
          ],
        },
      },
    },
  });
}
