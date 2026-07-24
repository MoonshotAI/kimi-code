/**
 * `state` domain (L0) — scope-agnostic keyed state container primitives.
 *
 * Owns the typed `StateKey<T>` / `defineState(name, initial)` descriptor (the
 * state counterpart of wire's `defineModel`), the `IStateRegistry` base
 * interface shared by the per-scope state services (`IStateService` /
 * `ISessionStateService` / `IAgentStateService`), and the `StateRegistry`
 * implementation backing them: a `Map`-backed store where keys are declared
 * up front (`register`), read and replaced (`get` / `set`), and observed
 * (`onDidChange(key)` per key, `onDidChangeAny` globally, `entries()` as a
 * debugging snapshot). Misuse (duplicate registration, reading or writing an
 * unregistered key) is a caller bug and raises `BugIndicatingError`.
 *
 * Values are stored as-is — the container does not freeze or clone, so
 * replacing the whole value via `set` is the recommended update style;
 * mutating a held `Map` / `Set` in place bypasses change notification.
 * Persistence and replay are out of scope here: durable, replayable state
 * belongs to wire Models. Scope-agnostic.
 */

import { Disposable } from '../di/lifecycle';
import { BugIndicatingError } from '../errors/errors';
import { Emitter, type Event } from '../event';

export interface StateKey<T> {
  readonly name: string;
  readonly initial: () => T;
}

export function defineState<T>(name: string, initial: () => T): StateKey<T> {
  return { name, initial };
}

export interface StateChange {
  readonly key: string;
  readonly value: unknown;
}

export interface IStateRegistry {
  register<T>(key: StateKey<T>): void;
  has(key: StateKey<unknown>): boolean;
  get<T>(key: StateKey<T>): T;
  set<T>(key: StateKey<T>, value: T): void;
  onDidChange<T>(key: StateKey<T>): Event<T>;
  readonly onDidChangeAny: Event<StateChange>;
  entries(): readonly [string, unknown][];
}

export class StateRegistry extends Disposable implements IStateRegistry {
  private readonly values = new Map<string, unknown>();
  private readonly keyEmitters = new Map<string, Emitter<unknown>>();
  private readonly anyEmitter = this._register(new Emitter<StateChange>());
  readonly onDidChangeAny: Event<StateChange> = this.anyEmitter.event;

  register<T>(key: StateKey<T>): void {
    if (this.values.has(key.name)) {
      throw new BugIndicatingError(`state key '${key.name}' is already registered`);
    }
    this.values.set(key.name, key.initial());
  }

  has(key: StateKey<unknown>): boolean {
    return this.values.has(key.name);
  }

  get<T>(key: StateKey<T>): T {
    if (!this.values.has(key.name)) {
      throw new BugIndicatingError(`state key '${key.name}' is not registered`);
    }
    return this.values.get(key.name) as T;
  }

  set<T>(key: StateKey<T>, value: T): void {
    if (!this.values.has(key.name)) {
      throw new BugIndicatingError(`state key '${key.name}' is not registered`);
    }
    this.values.set(key.name, value);
    this.keyEmitters.get(key.name)?.fire(value);
    this.anyEmitter.fire({ key: key.name, value });
  }

  onDidChange<T>(key: StateKey<T>): Event<T> {
    let emitter = this.keyEmitters.get(key.name);
    if (emitter === undefined) {
      emitter = this._register(new Emitter<unknown>());
      this.keyEmitters.set(key.name, emitter);
    }
    return emitter.event as Event<T>;
  }

  entries(): readonly [string, unknown][] {
    return Array.from(this.values.entries());
  }
}
