import { Disposable, type IDisposable, toDisposable } from '../di/lifecycle';
import { BugIndicatingError } from '../errors/errors';
import { Emitter, type Event } from '../event';

export interface StateKey<T> {
  readonly name: string;
  readonly initial: () => T;
  readonly snapshotExcluded?: boolean;
}

export interface StateChange {
  readonly key: string;
  readonly value: unknown;
}

export interface StateInspection {
  readonly scope: string;
  readonly state: Record<string, unknown>;
  readonly parent?: StateInspection;
}

export interface IStateRegistry {
  contributeState<T>(key: StateKey<T>): IDisposable;
  has(key: StateKey<unknown>): boolean;
  get<T>(key: StateKey<T>): T;
  set<T>(key: StateKey<T>, value: T): void;
  onDidChange<T>(key: StateKey<T>): Event<T>;
  readonly onDidChangeAny: Event<StateChange>;
  entries(): readonly [string, unknown][];
  snapshot(): Record<string, unknown>;
  inspect(): StateInspection;
}

export class StateRegistry extends Disposable implements IStateRegistry {
  private readonly values = new Map<string, unknown>();
  private readonly registrations = new Map<string, object>();
  private readonly excludedFromSnapshot = new Set<string>();
  private readonly keyEmitters = new Map<string, Emitter<unknown>>();
  private readonly anyEmitter = this._register(new Emitter<StateChange>());
  readonly onDidChangeAny: Event<StateChange> = this.anyEmitter.event;

  protected readonly inspectScope: string = 'unknown';
  protected inspectParent?: IStateRegistry;

  contributeState<T>(key: StateKey<T>): IDisposable {
    const replayable = (key as StateKey<T> & { readonly replayable?: unknown }).replayable;
    if (typeof replayable === 'object' && replayable !== null) {
      throw new BugIndicatingError(
        `replayable state key '${key.name}' must be contributed to the Agent-scope state service`,
      );
    }
    return this.contributeKey(key);
  }

  protected contributeKey<T>(key: StateKey<T>): IDisposable {
    if (this.values.has(key.name)) {
      throw new BugIndicatingError(`state key '${key.name}' is already registered`);
    }
    const registration = {};
    this.registrations.set(key.name, registration);
    this.values.set(key.name, key.initial());
    if (key.snapshotExcluded === true) {
      this.excludedFromSnapshot.add(key.name);
    }
    return toDisposable(() => {
      if (this.registrations.get(key.name) !== registration) return;
      this.registrations.delete(key.name);
      this.values.delete(key.name);
      this.excludedFromSnapshot.delete(key.name);
      this.keyEmitters.get(key.name)?.dispose();
      this.keyEmitters.delete(key.name);
    });
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

  snapshot(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of this.values) {
      if (this.excludedFromSnapshot.has(key)) continue;
      out[key] = toJsonSafe(value, new WeakSet());
    }
    return out;
  }

  inspect(): StateInspection {
    return {
      scope: this.inspectScope,
      state: this.snapshot(),
      parent: this.inspectParent?.inspect(),
    };
  }
}

function toJsonSafe(value: unknown, seen: WeakSet<object>): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === 'function') return '(function)';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '(circular)';
  seen.add(value);
  try {
    if (value instanceof Date) return value.toJSON();
    if (Array.isArray(value)) return value.map((item) => toJsonSafe(item, seen));
    if (value instanceof Map) {
      const entries = [...value.entries()];
      const objectKeys = entries.every(([key]) => ['string', 'number'].includes(typeof key));
      if (objectKeys) {
        return Object.fromEntries(
          entries.map(([key, item]) => [key, toJsonSafe(item, seen)] as const),
        );
      }
      return entries.map(([key, item]) => [toJsonSafe(key, seen), toJsonSafe(item, seen)]);
    }
    if (value instanceof Set) {
      return [...value.values()].map((item) => toJsonSafe(item, seen));
    }
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      const ctor = (value as { constructor?: { name?: string } }).constructor;
      return `(${ctor?.name ?? 'object'})`;
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'function') continue;
      out[key] = toJsonSafe(item, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}
