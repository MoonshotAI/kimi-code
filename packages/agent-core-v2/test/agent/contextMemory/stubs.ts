/**
 * `contextMemory` test stubs — shared doubles for `IAgentContextMemoryService` and its
 * collaborator (`IWireService`).
 *
 * Lives under `test/` (not `src/`) so test-support code stays out of the
 * production tree. Import from a relative path (`./stubs` or
 * `../contextMemory/stubs`).
 */

import type { ServiceRegistration } from '#/_base/di/test';
import { buildContextCompactionShape } from '#/agent/contextMemory/compactionHandoff';
import {
  IAgentContextMemoryService,
  type ContextCompactionInput,
  type ContextCompactionResult,
} from '#/agent/contextMemory/contextMemory';
import type { LoopRecordedEvent } from '#/agent/contextMemory/loopEventFold';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { IWireService } from '#/wire/wire';

import { stubAgentWire } from '../../wire/stubs';

export interface StubContextMemory extends IAgentContextMemoryService {
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
  eventBus?.publish({ type: 'context.spliced', ...input });
}

export function stubContextMemory(eventBus?: IEventBus): StubContextMemory {
  const messages: ContextMessage[] = [];
  return {
    _serviceBrand: undefined,
    get messages() {
      return messages;
    },
    get: () => [...messages],
    append: (...inserted) => {
      const start = messages.length;
      messages.push(...inserted);
      publishSplice(eventBus, { start, deleteCount: 0, messages: [...inserted] });
    },
    appendLoopEvent: () => {},
    clear: () => {
      const deleteCount = messages.length;
      if (deleteCount === 0) return;
      messages.splice(0, deleteCount);
      publishSplice(eventBus, { start: 0, deleteCount, messages: [] });
    },
    applyCompaction: (input: ContextCompactionInput): ContextCompactionResult => {
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
      return result;
    },
  };
}

class StubContextMemoryService implements IAgentContextMemoryService {
  declare readonly _serviceBrand: undefined;
  private readonly impl: StubContextMemory;
  constructor(@IEventBus eventBus: IEventBus) {
    this.impl = stubContextMemory(eventBus);
  }
  get messages(): readonly ContextMessage[] {
    return this.impl.messages;
  }
  get(): readonly ContextMessage[] {
    return this.impl.get();
  }
  append(...messages: readonly ContextMessage[]): void {
    this.impl.append(...messages);
  }
  clear(): void {
    this.impl.clear();
  }
  appendLoopEvent(event: LoopRecordedEvent): void {
    this.impl.appendLoopEvent(event);
  }
  applyCompaction(input: ContextCompactionInput): ContextCompactionResult {
    return this.impl.applyCompaction(input);
  }
}

export function registerContextMemoryServices(reg: ServiceRegistration): void {
  reg.defineInstance(IWireService, stubAgentWire());
  reg.define(IEventBus, EventBusService);
  reg.define(IAgentContextMemoryService, StubContextMemoryService);
}
