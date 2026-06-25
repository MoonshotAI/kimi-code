import type { AgentEvent as ProtocolAgentEvent } from '@moonshot-ai/protocol';

import { Disposable, registerSingleton, SyncDescriptor } from "#/_base/di";
import { Emitter } from "#/_base/event";

import { IEventBus } from './eventBus';
import { IWireRecord } from '../wireRecord/wireRecord';

export class EventBusService extends Disposable implements IEventBus {
  private readonly onDidEmitEmitter = this._register(new Emitter<ProtocolAgentEvent>());

  constructor(@IWireRecord private readonly wireRecord: IWireRecord) {
    super();
  }

  emit(event: ProtocolAgentEvent): void {
    if (this.wireRecord.restoring) return;
    this.onDidEmitEmitter.fire(event);
  }

  on(handler: (event: ProtocolAgentEvent) => void) {
    return this.onDidEmitEmitter.event(handler);
  }
}

registerSingleton(IEventBus, new SyncDescriptor(EventBusService, [], true));
