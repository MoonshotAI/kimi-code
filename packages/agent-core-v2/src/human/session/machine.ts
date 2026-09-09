import { assign, emit, sendTo, setup, stopChild, type ActorRefFrom } from '#/xstate2';

import type { createAgentMachine, AgentEvent } from '#/agent/machine';
import type { AgentEventStore } from '#/agent/slices';
import type { LlmRequestConfig } from '#/llm/requester/requester';
import type { TurnLlmEvent, TurnToolEvent } from '#/agent/turn';
import type { ToolUpdate } from '#/tool/executor';

export interface SessionInput {
  request: LlmRequestConfig;
}

export type AgentActorRef = ActorRefFrom<ReturnType<typeof createAgentMachine>>;

export interface AgentEntry {
  ref: AgentActorRef;
}

export type SessionEvent =
  | TurnLlmEvent
  | TurnToolEvent
  | { type: 'tool.update'; toolCallId: string; update: ToolUpdate }
  | {
      type: 'agent.create';
      agentId?: string;
      input: { request?: LlmRequestConfig; store: AgentEventStore };
    }
  | { type: 'agent.fork'; sourceId: string; agentId?: string; store: AgentEventStore }
  | { type: 'agent.send'; agentId: string; event: AgentEvent }
  | { type: 'agent.stop'; agentId: string };

export type SessionEmitted =
  | { type: 'agent.created'; agentId: string; branchId: string; ref: AgentActorRef }
  | { type: 'agent.forked'; sourceId: string; agentId: string; branchId: string; ref: AgentActorRef }
  | { type: 'agent.stopped'; agentId: string }
  | { type: 'agent.failed'; agentId: string; error: string };

export interface SessionMachineContext {
  input: SessionInput;
  agents: Record<string, AgentEntry>;
  anonymousCount: number;
}

export interface CreateSessionMachineOptions {
  agent: ReturnType<typeof createAgentMachine>;
}

function nextAnonymousCount(context: SessionMachineContext): number {
  let count = context.anonymousCount + 1;
  while (context.agents[`agent-${count}`] !== undefined) {
    count += 1;
  }
  return count;
}

export function createSessionMachine({ agent }: CreateSessionMachineOptions) {
  return setup({
    types: {
      input: {} as SessionInput,
      context: {} as SessionMachineContext,
      events: {} as SessionEvent,
      emitted: {} as SessionEmitted,
    },
    actors: {
      agentActor: agent,
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
                  const ref = spawn('agentActor', {
                    id: agentId,
                    input: {
                      request: event.input.request ?? context.input.request,
                      store: event.input.store,
                    },
                  });
                  return {
                    agents: { ...context.agents, [agentId]: { ref } },
                    anonymousCount,
                  };
                }),
                emit(({ context, event }) => {
                  const agentId = event.agentId ?? `agent-${context.anonymousCount}`;
                  const entry = context.agents[agentId] as AgentEntry;
                  return {
                    type: 'agent.created' as const,
                    agentId,
                    branchId: event.input.store.ref.branch,
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
                  const ref = spawn('agentActor', {
                    id: agentId,
                    input: {
                      request: source.context.input.request,
                      store: event.store,
                    },
                  });
                  return {
                    agents: { ...context.agents, [agentId]: { ref } },
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
                    branchId: event.store.ref.branch,
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
                stopChild(({ event }) => event.agentId),
                assign(({ context, event }) => {
                  const agents = { ...context.agents };
                  delete agents[event.agentId];
                  return { agents };
                }),
                emit(({ event }) => ({ type: 'agent.stopped' as const, agentId: event.agentId })),
              ],
            },
          ],
        },
      },
    },
  });
}
