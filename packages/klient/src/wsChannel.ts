/**
 * `WsChannel` — an `IChannel` bound to one Service that forwards `call`s over
 * the shared `/api/v2/ws` socket instead of HTTP. Same VS Code shape as
 * `HttpChannel` (the URL equivalent is the `{scope, service, ids}` triple the
 * socket puts on each frame), so the same `makeProxy` turns it into a typed
 * Service client. `listen` here takes a handler and returns a subscription
 * that survives reconnects until disposed.
 */

import type { Event, IChannel } from './channel.js';
import type { WsScopeIds, WsScopeKind, WsSocket } from './wsSocket.js';

export interface WsChannelOptions {
  readonly socket: WsSocket;
  readonly scope: WsScopeKind;
  /** Service channel name (the decorator id, `String(id)`). */
  readonly service: string;
  readonly sessionId?: string;
  readonly agentId?: string;
}

interface SharedEvent {
  readonly listeners: Set<{ listener: (data: unknown) => unknown; thisArg: unknown }>;
  remote?: { dispose(): void };
}

export class WsChannel implements IChannel {
  private readonly socket: WsSocket;
  private readonly scope: WsScopeKind;
  private readonly service: string;
  private readonly ids: WsScopeIds;
  private readonly events = new Map<string, SharedEvent>();

  constructor(opts: WsChannelOptions) {
    this.socket = opts.socket;
    this.scope = opts.scope;
    this.service = opts.service;
    this.ids = { sessionId: opts.sessionId, agentId: opts.agentId };
  }

  call<T>(command: string, args: unknown[] = []): Promise<T> {
    return this.socket.call(this.scope, this.service, command, args, this.ids);
  }

  listen<T>(event: string): Event<T> {
    let shared = this.events.get(event);
    if (shared === undefined) {
      shared = { listeners: new Set() };
      this.events.set(event, shared);
    }
    return (listener, thisArg, disposables) => {
      const entry = { listener: listener as (data: unknown) => unknown, thisArg };
      shared.listeners.add(entry);
      shared.remote ??= this.socket.listen(
        this.scope,
        event,
        this.ids,
        (data) => {
          for (const current of shared.listeners) current.listener.call(current.thisArg, data);
        },
        this.service,
      );
      let disposed = false;
      const subscription = {
        dispose: (): void => {
          if (disposed) return;
          disposed = true;
          shared.listeners.delete(entry);
          if (shared.listeners.size === 0) {
            shared.remote?.dispose();
            shared.remote = undefined;
          }
        },
      };
      disposables?.push(subscription);
      return subscription;
    };
  }
}
