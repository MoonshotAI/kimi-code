import type {
  EventSourceRef,
  IDisposable,
  KlientChannel,
  ScopeRef,
} from '../../core/channel.js';
import { createKlientFromChannel, type Klient, type KlientOptions } from '../../core/klient.js';
import { createMemoryDispatcher, type ScopeLike } from './dispatcher.js';

export type { ScopeLike } from './dispatcher.js';

export interface MemoryKlientOptions extends KlientOptions {
  readonly scope: ScopeLike;
}

class MemoryChannel implements KlientChannel {
  private readonly dispatcher;

  constructor(scope: ScopeLike) {
    this.dispatcher = createMemoryDispatcher(scope);
  }

  call(scope: ScopeRef, service: string, method: string, args: unknown[]): Promise<unknown> {
    return this.dispatcher.call(scope, service, method, args);
  }

  stream(scope: ScopeRef, service: string, method: string, args: unknown[]): AsyncIterable<unknown> {
    return this.dispatcher.stream(scope, service, method, args);
  }

  listen(
    scope: ScopeRef,
    source: EventSourceRef,
    handler: (data: unknown) => void,
    onError?: (error: Error) => void,
  ): IDisposable {
    return this.dispatcher.listen(scope, source, handler, onError);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

export function createKlient(options: MemoryKlientOptions): Klient {
  return createKlientFromChannel(new MemoryChannel(options.scope), options);
}
