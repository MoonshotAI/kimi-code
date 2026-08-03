/**
 * `createKlient` over an in-process engine scope — the host bootstraps the
 * engine (e.g. `bootstrap()` from the retired agent-core-v2 package) and
 * passes the app scope plus the engine access (DI tokens, main-agent
 * materializer) in. Calls and events never leave the process, but everything
 * the facade returns has crossed the same JSON round-trip as the networked
 * transports, so behavior is indistinguishable.
 */

import type {
  EventSourceRef,
  IDisposable,
  KlientChannel,
  ScopeRef,
} from '../../core/channel.js';
import { createKlientFromChannel, type Klient, type KlientOptions } from '../../core/klient.js';
import {
  createMemoryDispatcher,
  type ScopeLike,
} from './dispatcher.js';
import type { MemoryEngineAccess } from './engine.js';

export type { MemoryEngineAccess, EngineToken, ScopeLike } from './engine.js';
export { createMemoryDispatcher, type MemoryDispatcher } from './dispatcher.js';

export interface MemoryKlientOptions extends KlientOptions {
  /**
   * A bootstrapped engine app scope (`bootstrap(...).app` or an
   * `IAppScopeHandle`). The klient does NOT own its lifecycle — `close()`
   * leaves the scope alone.
   */
  readonly scope: ScopeLike;
  /**
   * Engine access (DI token map + main-agent materializer), supplied by the
   * host that bootstrapped the engine. klient never imports the engine
   * package; hosts build this from it (see `test/helpers/engine.ts`).
   */
  readonly engine: MemoryEngineAccess;
}

class MemoryChannel implements KlientChannel {
  private readonly dispatcher;

  constructor(scope: ScopeLike, engine: MemoryEngineAccess) {
    this.dispatcher = createMemoryDispatcher(scope, engine);
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
  return createKlientFromChannel(new MemoryChannel(options.scope, options.engine), options);
}
