import { Disposable, registerSingleton, SyncDescriptor } from '../../../di';
import { Emitter } from '../../../base/common/event';

import { IEventBus } from './eventBus';
import type { AgentEvent } from '../types';
import { IWireRecord } from '../wireRecord/wireRecord';

export class EventBusService extends Disposable implements IEventBus {
  private readonly onDidEmitEmitter = this._register(new Emitter<AgentEvent>());

  constructor(@IWireRecord private readonly wireRecord: IWireRecord) {
    super();
  }

  emit(event: AgentEvent): void {
    if (this.wireRecord.restoring) return;
    this.onDidEmitEmitter.fire(event);
  }

  on(handler: (event: AgentEvent) => void) {
    return this.onDidEmitEmitter.event(handler);
  }
}

registerSingleton(IEventBus, new SyncDescriptor(EventBusService, [], true));
