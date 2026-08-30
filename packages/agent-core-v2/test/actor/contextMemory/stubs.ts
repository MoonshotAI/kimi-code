import { Event } from '#/_base/event';
import { buildContextCompactionShape } from '#/actor/contextMemory/compactionHandoff';
import {
  ContextMemoryRuntime,
  type ContextCompactionInput,
  type ContextCompactionResult,
} from '#/actor/contextMemory/contextMemoryAgentRuntime';
import { computeUndoCut } from '#/actor/contextMemory/contextOps';
import { ContextSpliced } from '#/actor/contextMemory/contextEvents';
import type { ContextMessage } from '#/actor/contextMemory/types';
import { IEventBus, type ISessionEventBus } from '#/app/event/eventBus';

import { stubAgentContext } from '../../agent/agentContext/stubs';

export interface StubContextMemory extends ContextMemoryRuntime {
  readonly messages: readonly ContextMessage[];
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
  const runtime = {
    onDidChange: Event.None,
    get: () => [...messages],
    append: (...inserted: readonly ContextMessage[]) => {
      const start = messages.length;
      messages.push(...inserted);
      publishSplice(eventBus, { start, deleteCount: 0, messages: [...inserted] });
      return Promise.resolve();
    },
    publishTrailingRemoval: () => false,
    clear: () => {
      const deleteCount = messages.length;
      if (deleteCount === 0) return Promise.resolve();
      messages.splice(0, deleteCount);
      publishSplice(eventBus, { start: 0, deleteCount, messages: [] });
      return Promise.resolve();
    },
    undo: (count: number) => {
      const cut = computeUndoCut(messages, count);
      if (cut.cutIndex >= 0 && cut.removedCount >= count) {
        const deleteCount = messages.length - cut.cutIndex;
        messages.splice(cut.cutIndex, deleteCount);
        publishSplice(eventBus, { start: cut.cutIndex, deleteCount, messages: [] });
        return Promise.resolve(true);
      }
      return Promise.resolve(false);
    },
    applyCompaction: (input: ContextCompactionInput): Promise<ContextCompactionResult> => {
      const shape = buildContextCompactionShape(messages, input);
      const previousLength = messages.length;
      messages.splice(0, previousLength, ...shape.messages);
      publishSplice(eventBus, {
        start: 0,
        deleteCount: previousLength,
        messages: [...shape.messages],
        tokens: shape.tokensAfter,
      });
      const { messages: _messages, ...result } = shape;
      void _messages;
      return Promise.resolve(result);
    },
  } as unknown as ContextMemoryRuntime;
  return Object.assign(runtime, {
    get messages() {
      return messages;
    },
  });
}
