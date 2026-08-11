/**
 * `createKlient` over an in-process engine scope — the host bootstraps the
 * engine (`bootstrap()` from agent-core-v2) and passes the app scope (or its
 * handle) in. Calls and events never leave the process, but everything the
 * facade returns has crossed the same JSON round-trip as the networked
 * transports, so behavior is indistinguishable.
 */

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
  /**
   * A bootstrapped engine app scope (`bootstrap(...).app` or an
   * `IAppScopeHandle`). The klient does NOT own its lifecycle — `close()`
   * leaves the scope alone.
   */
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
    // The scope belongs to the host; nothing transport-side to release.
    return Promise.resolve();
  }
}

export function createKlient(options: MemoryKlientOptions): Klient {
  return createKlientFromChannel(new MemoryChannel(options.scope), options);
}
