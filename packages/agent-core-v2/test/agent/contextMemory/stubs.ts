import type { ServiceRegistration } from '#/_base/di/test';
import { buildContextCompactionShape, type ContextCompactionShape, type ContextCompactionShapeInput } from '#/agent/contextMemory/compactionHandoff';
import { ContextApplyCompaction, ContextSpliced } from '#/agent/contextMemory/contextEvents';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { contextFromHistoryEntry, historyFromContext } from '#/agent/loop/history';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IEventBus, type ISessionEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { IWireService } from '#/wire/wire';
import type { HistoryMessage } from '@moonshot-ai/core/history/history';
import type { IEventDispatcher } from '#/state/eventDispatcher';
import { TokenCountingRebased } from '#/agent/tokenCounting/tokenCountingOps';

import { stubAgentWire } from '../../wire/stubs';
import { stubAgentContext } from '../agentContext/stubs';
import { stubLoopWithHooks, type StubLoop } from '../loop/stubs';

export function appendContext(loop: IAgentLoopService, ...messages: readonly ContextMessage[]): void {
  loop.remind(...historyFromContext(messages));
  loop.flushReminders();
}

export function compactContext(
  loop: IAgentLoopService,
  input: ContextCompactionShapeInput,
  effects?: { readonly dispatcher: IEventDispatcher },
): Omit<ContextCompactionShape, 'messages'> {
  const shape = buildContextCompactionShape(loop.history(), input);
  const { messages: _messages, ...result } = shape;
  void _messages;
  loop.replaceHistory(historyFromContext(shape.messages), 'compaction', () => {
    if (effects === undefined) return;
    void effects.dispatcher.dispatch(new ContextApplyCompaction({ agentId: 'main', ...result }));
    void effects.dispatcher.dispatch(new TokenCountingRebased({
      agentId: 'main',
      length: shape.messages.length,
      tokens: result.tokensAfter,
      measured: false,
    }));
  });
  return result;
}

export interface StubContextMemory extends StubLoop {
  readonly messages: readonly ContextMessage[];
  beginTurn(): void;
  undo(count: number): { readonly cutIndex: number; readonly removedCount: number; readonly stoppedAtCompaction: boolean };
}

function publishSplice(
  eventBus: IEventBus | undefined,
  input: {
    start: number;
    deleteCount: number;
    messages: readonly ContextMessage[];
    tokens?: number;
  },
): void {
  if (eventBus === undefined) return;
  const sessionBus = eventBus as Partial<ISessionEventBus>;
  if (typeof sessionBus.activateAgent === 'function') {
    const context = stubAgentContext('main', 1);
    sessionBus.activateAgent(context);
    sessionBus.publish?.(new ContextSpliced({ agentId: 'main', ...input }), context);
    return;
  }
  eventBus.publish(new ContextSpliced({ agentId: 'main', ...input }));
}

export function stubContextMemory(eventBus?: IEventBus): StubContextMemory {
  const messages: ContextMessage[] = [];
  const turnStarts: number[] = [];
  let revision = 0;
  const base = stubLoopWithHooks();
  const replaceHistory = (entries: readonly HistoryMessage[]): boolean => {
    const previousLength = messages.length;
    const next = entries.map((entry) => contextFromHistoryEntry(entry));
    messages.splice(0, messages.length, ...next);
    turnStarts.length = 0;
    revision += 1;
    publishSplice(eventBus, { start: 0, deleteCount: previousLength, messages: [...next] });
    return true;
  };
  return {
    ...base,
    get messages() {
      return messages;
    },
    history: () => messages,
    historyRevision: () => revision,
    replaceHistory,
    initializeHistory: async (entries) => {
      replaceHistory(entries);
    },
    beginTurn: () => {
      turnStarts.push(messages.length);
    },
    remind: (...entries) => {
      const start = messages.length;
      const inserted = entries.map((entry) => contextFromHistoryEntry(entry));
      messages.push(...inserted);
      publishSplice(eventBus, { start, deleteCount: 0, messages: inserted });
    },
    undo: (count) => {
      const cutIndex = turnStarts[turnStarts.length - count] ?? -1;
      if (cutIndex >= 0) {
        const deleteCount = messages.length - cutIndex;
        messages.splice(cutIndex, deleteCount);
        turnStarts.splice(turnStarts.length - count, count);
        revision += 1;
        publishSplice(eventBus, { start: cutIndex, deleteCount, messages: [] });
      }
      return {
        cutIndex,
        removedCount: cutIndex < 0 ? turnStarts.length : count,
        stoppedAtCompaction: false,
      };
    },
  };
}

export function registerContextMemoryServices(reg: ServiceRegistration): void {
  reg.defineInstance(IWireService, stubAgentWire());
  reg.define(IEventBus, EventBusService);
  reg.defineInstance(IAgentLoopService, stubContextMemory());
}
