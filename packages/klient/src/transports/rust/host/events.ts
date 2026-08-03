/**
 * Host-side local event bus for the rust transport.
 *
 * The retired v2 dispatcher exposed per-service `onDid*` emitters that the
 * klient `globalEvents` table binds public events to (`kosong.providers.changed`
 * → `providerService.onDidChangeProviders`, …). The Rust engine hosts no such
 * emitters, so the rust transport had no way to surface host-side config
 * writes as events. This bus restores that surface: write-path services
 * (`providerService` / `modelService` / `configService`) emit here after
 * persisting config, and the channel wires emitter-kind subscriptions to it.
 */

import { EventEmitter } from 'node:events';

import type { IDisposable } from '../../../core/channel.js';
import type { RustEventBus } from '../types.js';

/** Create a bus backed by a bare `EventEmitter`. */
export function createRustEventBus(): RustEventBus {
  const emitter = new EventEmitter();
  return {
    on(event: string, handler: (payload: unknown) => void): IDisposable {
      emitter.on(event, handler);
      return {
        dispose: () => {
          emitter.off(event, handler);
        },
      };
    },
    emit(event: string, payload: unknown): void {
      emitter.emit(event, payload);
    },
  };
}
