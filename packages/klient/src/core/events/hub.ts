/**
 * The event hub — klient-level event forwarding. It exposes typed, namespaced
 * events and hides the engine's `onDid*`/`onWill*` surface: each public event
 * name resolves to one registration (a global-bus type filter, a scope
 * stream, or a service emitter). Underlying channel subscriptions are shared
 * per source and ref-counted by listener count. Payloads are validated
 * against the event schema before delivery; bad payloads are dropped and
 * reported through `onError`, never thrown.
 *
 * One hub serves one scope: the global klient hub binds `{}`, session/agent
 * handles bind their scope coordinates, so `stream` sources resolve to the
 * right scope's event stream on every transport.
 */

import type { IDisposable, KlientChannel, ScopeRef } from '../channel.js';
import type { EventRegistration } from '#/contract/types';
import type { KlientEventPayloads } from '#/contract/global/events';
import { parseEvent } from '../validation.js';

export interface KlientEvents<TPayloadMap extends object = KlientEventPayloads> {
  on<E extends keyof TPayloadMap & string>(
    event: E,
    listener: (payload: TPayloadMap[E]) => void,
  ): IDisposable;
  /** Validation failures and listener exceptions surface here. */
  onError(listener: (error: Error) => void): IDisposable;
}

type AnyListener = (payload: never) => void;

interface SharedSub {
  readonly reg: EventRegistration;
  disposable: IDisposable;
  refs: number;
}

/** Stable identity of a registration's underlying channel subscription. */
function keyOf(reg: EventRegistration): string {
  switch (reg.kind) {
    case 'bus':
      return 'bus';
    case 'stream':
      return `stream:${reg.name}`;
    case 'emitter':
      return `emitter:${reg.service}:${reg.event}`;
  }
}

function rawTypeOf(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const type = (raw as { type?: unknown }).type;
  return typeof type === 'string' ? type : undefined;
}

export class EventHub<TPayloadMap extends object = KlientEventPayloads>
  implements KlientEvents<TPayloadMap>
{
  private readonly listeners = new Map<string, Set<AnyListener>>();
  private readonly subs = new Map<string, SharedSub>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private closed = false;

  constructor(
    private readonly channel: KlientChannel,
    private readonly validate: boolean,
    private readonly scope: ScopeRef,
    private readonly registrations: Record<string, EventRegistration>,
  ) {}

  on<E extends keyof TPayloadMap & string>(
    event: E,
    listener: (payload: TPayloadMap[E]) => void,
  ): IDisposable {
    if (this.closed) throw new Error('event hub is closed');
    if (this.registrations[event] === undefined) {
      throw new Error(`unknown event: ${event}`);
    }
    let set = this.listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(event, set);
    }
    const entry = listener as AnyListener;
    set.add(entry);
    this.acquire(event);

    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        set.delete(entry);
        if (set.size === 0) {
          this.listeners.delete(event);
        }
        this.release(event);
      },
    };
  }

  onError(listener: (error: Error) => void): IDisposable {
    this.errorListeners.add(listener);
    return {
      dispose: () => {
        this.errorListeners.delete(listener);
      },
    };
  }

  /** Detach every subscription; the hub may not be reused after. */
  close(): void {
    this.closed = true;
    for (const sub of this.subs.values()) {
      sub.disposable.dispose();
    }
    this.subs.clear();
    this.listeners.clear();
  }

  private acquire(event: string): void {
    const reg = this.registrations[event];
    if (reg === undefined) return;
    const key = keyOf(reg);
    let sub = this.subs.get(key);
    if (sub === undefined) {
      sub = {
        reg,
        disposable: this.subscribe(key, reg),
        refs: 0,
      };
      this.subs.set(key, sub);
    }
    sub.refs += 1;
  }

  private release(event: string): void {
    const reg = this.registrations[event];
    if (reg === undefined) return;
    const key = keyOf(reg);
    const sub = this.subs.get(key);
    if (sub === undefined) return;
    sub.refs -= 1;
    if (sub.refs <= 0) {
      sub.disposable.dispose();
      this.subs.delete(key);
    }
  }

  private subscribe(key: string, reg: EventRegistration): IDisposable {
    if (reg.kind === 'emitter') {
      return this.channel.listen(
        this.scope,
        { kind: 'emitter', service: reg.service, event: reg.event },
        (data) => {
          this.deliver(key, data);
        },
        (error) => {
          this.reportError(error);
        },
      );
    }
    const name = reg.kind === 'bus' ? 'events' : reg.name;
    return this.channel.listen(
      this.scope,
      { kind: 'stream', name },
      (data) => {
        this.deliver(key, data);
      },
      (error) => {
        this.reportError(error);
      },
    );
  }

  /** Fan one raw payload out to the registrations attached to this source. */
  private deliver(key: string, raw: unknown): void {
    for (const [event, reg] of Object.entries(this.registrations)) {
      if (keyOf(reg) !== key || !this.listeners.has(event)) continue;
      if (reg.kind === 'bus') {
        // Global bus events are `{ type, payload }` facts; only registered
        // types are forwarded, with the payload unwrapped.
        if (rawTypeOf(raw) !== reg.type) continue;
        this.deliverValidated(event, reg, (raw as { payload?: unknown }).payload);
        continue;
      }
      if (reg.kind === 'stream' && reg.type !== undefined) {
        // Scoped streams (e.g. the agent `events` bus) carry flat
        // `{ type, ...fields }` events; forward the whole event.
        if (rawTypeOf(raw) !== reg.type) continue;
        this.deliverValidated(event, reg, raw);
        continue;
      }
      this.deliverValidated(event, reg, raw);
    }
  }

  private deliverValidated(event: string, reg: EventRegistration, data: unknown): void {
    let payload: unknown = data;
    if (this.validate) {
      const parsed = parseEvent(event, reg.schema, data);
      if (!parsed.ok) {
        this.reportError(parsed.error);
        return;
      }
      payload = parsed.data;
    }
    const set = this.listeners.get(event);
    if (set === undefined) return;
    for (const listener of set) {
      try {
        (listener as (payload: unknown) => void)(payload);
      } catch (error) {
        this.reportError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private reportError(error: Error): void {
    for (const listener of this.errorListeners) {
      try {
        listener(error);
      } catch {
        // error listeners must not take the hub down
      }
    }
  }
}
