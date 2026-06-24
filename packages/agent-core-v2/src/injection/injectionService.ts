/**
 * `injection` domain (L4) — `IInjectionService` (Agent) + `IInjectionQueue`
 * (Turn) implementation.
 *
 * Both are simple FIFO queues of pending injections; `flush` drains and
 * returns them. The Agent-scope service is fed by behavior domains
 * (compaction/plan/goal); the Turn-scope queue is flushed into the context
 * at the appropriate step boundary.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IContextService } from '#/context/context';

import { type InjectionItem, IInjectionQueue, IInjectionService } from './injection';

class Queue {
  private items: InjectionItem[] = [];
  push(item: InjectionItem): void {
    this.items.push(item);
  }
  flush(): readonly InjectionItem[] {
    const out = this.items;
    this.items = [];
    return out;
  }
  get pending(): number {
    return this.items.length;
  }
}

export class InjectionService implements IInjectionService {
  declare readonly _serviceBrand: undefined;
  private readonly queue = new Queue();

  constructor(@IContextService _context: IContextService) {}

  push(item: InjectionItem): void {
    this.queue.push(item);
  }
  flush(): readonly InjectionItem[] {
    return this.queue.flush();
  }
}

export class InjectionQueue implements IInjectionQueue {
  declare readonly _serviceBrand: undefined;
  private readonly queue = new Queue();

  push(item: InjectionItem): void {
    this.queue.push(item);
  }
  flush(): readonly InjectionItem[] {
    return this.queue.flush();
  }
}

registerScopedService(LifecycleScope.Agent, IInjectionService, InjectionService, InstantiationType.Delayed, 'injection');
registerScopedService(LifecycleScope.Turn, IInjectionQueue, InjectionQueue, InstantiationType.Delayed, 'injection');
