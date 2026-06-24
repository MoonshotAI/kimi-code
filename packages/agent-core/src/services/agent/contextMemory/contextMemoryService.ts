import { Disposable, registerSingleton, SyncDescriptor } from '../../../di';
import { OrderedHookSlot } from '../hooks';
import { IReplayBuilderService } from '../replayBuilder/replayBuilder';
import type { ContextMessage, WireRecord } from '../types';
import { IWireRecord } from '../wireRecord/wireRecord';
import { IContextMemory } from './contextMemory';

declare module '../types' {
  interface WireRecordMap {
    'context.splice': {
      start: number;
      deleteCount: number;
      messages: ContextMessage[];
    };
  }
}

export class ContextMemoryService extends Disposable implements IContextMemory {
  private readonly history: ContextMessage[] = [];

  readonly hooks = {
    onSpliced: new OrderedHookSlot<{
      start: number;
      deleteCount: number;
      messages: ContextMessage[];
    }>(),
  };

  constructor(
    @IWireRecord private readonly wireRecord: IWireRecord,
    @IReplayBuilderService private readonly replayBuilder: IReplayBuilderService,
  ) {
    super();
    this._register(
      wireRecord.register(
        'context.splice',
        (record) => {
          this.applySplice(record);
        },
        {
          blobs: (record) => record.messages.map((message, index) => ({
            parts: message.content,
            replace: (current, content) => ({
              ...current,
              messages: current.messages.map((item, itemIndex) =>
                itemIndex === index ? { ...item, content: [...content] } : item,
              ),
            }),
          })),
        },
      ),
    );
  }

  getHistory(): readonly ContextMessage[] {
    return [...this.history];
  }

  spliceHistory(start: number, deleteCount: number, ...messages: ContextMessage[]): void {
    const record: WireRecord<'context.splice'> = {
      type: 'context.splice',
      start,
      deleteCount,
      messages,
    };
    this.wireRecord.append(record);
    this.applySplice(record);
  }

  private applySplice(record: WireRecord<'context.splice'>): void {
    const messages = [...record.messages];
    // A splice that deletes the whole history mirrors `context.clear`: prior
    // messages stay in the replay (as a boundary) and must not be removed.
    // Only a partial delete (old `context.undo`) drops the deleted messages
    // from the replay, symmetric to the insert `push` below.
    const clearsHistory = record.start === 0 && record.deleteCount >= this.history.length;
    const removedMessages = clearsHistory
      ? []
      : this.history.slice(record.start, record.start + record.deleteCount);
    this.history.splice(record.start, record.deleteCount, ...messages);
    if (removedMessages.length > 0) {
      this.replayBuilder.removeLastMessages(new Set(removedMessages));
    }
    for (const message of messages) {
      this.replayBuilder.push({ type: 'message', message });
    }
    const context = {
      start: record.start,
      deleteCount: record.deleteCount,
      messages,
    };
    void this.hooks.onSpliced.run(context);
  }
}

registerSingleton(IContextMemory, new SyncDescriptor(ContextMemoryService, [], true));
