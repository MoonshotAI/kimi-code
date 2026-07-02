import {
  Disposable,
} from "#/_base/di";
import { OrderedHookSlot } from '#/hooks';
import { IAgentReplayBuilderService } from '#/agent/replayBuilder';
import { IAgentRecordService, type AgentRecord } from '#/agent/record';
import { IAgentContextMemoryService } from './contextMemory';
import { ensureMessageId } from './messageId';
import type { ContextMessage } from './types';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

declare module '#/agent/wireRecord' {
  interface WireRecordMap {
    'context.splice': {
      start: number;
      deleteCount: number;
      messages: readonly ContextMessage[];
      tokens?: number;
    };
  }
}

export class AgentContextMemoryService extends Disposable implements IAgentContextMemoryService {
  declare readonly _serviceBrand: undefined;
  private readonly history: ContextMessage[] = [];

  readonly hooks = {
    onSpliced: new OrderedHookSlot<{
      start: number;
      deleteCount: number;
      messages: ContextMessage[];
      tokens?: number;
    }>(),
  };

  constructor(
    @IAgentRecordService private readonly record: IAgentRecordService,
    @IAgentReplayBuilderService private readonly replayBuilder: IAgentReplayBuilderService,
  ) {
    super();
    this._register(
      record.define('context.splice', {
        resume: (r) => {
          this.applySplice(r);
        },
        blobs: (r) =>
          r.messages.map((message, index) => ({
            parts: message.content,
            replace: (current, content) => ({
              ...current,
              messages: current.messages.map((item, itemIndex) =>
                itemIndex === index ? { ...item, content: [...content] } : item,
              ),
            }),
          })),
      }),
    );
  }

  get(): readonly ContextMessage[] {
    return [...this.history];
  }

  splice(
    start: number,
    deleteCount: number,
    messages: readonly ContextMessage[],
    tokens?: number,
  ): void {
    const stamped = messages.map(ensureMessageId);
    const record: AgentRecord<'context.splice'> = {
      type: 'context.splice',
      start,
      deleteCount,
      messages: stamped,
      tokens,
    };
    this.record.append(record);
    this.applySplice(record);
  }

  private applySplice(record: AgentRecord<'context.splice'>): void {
    const removedMessages =
      record.deleteCount > 0 && record.start > 0
        ? this.history.slice(record.start, record.start + record.deleteCount)
        : [];
    const messages = record.messages.map(ensureMessageId);
    this.history.splice(record.start, record.deleteCount, ...messages);
    this.replayBuilder.removeLastMessages(new Set(removedMessages));
    for (const message of messages) {
      this.replayBuilder.push({ type: 'message', message });
    }
    void this.hooks.onSpliced.run({
      start: record.start,
      deleteCount: record.deleteCount,
      messages,
      tokens: record.tokens,
    });
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentContextMemoryService,
  AgentContextMemoryService,
  InstantiationType.Delayed,
  'contextMemory',
);
