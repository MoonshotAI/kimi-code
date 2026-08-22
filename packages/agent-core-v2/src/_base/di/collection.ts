import { Emitter, type Event } from '../event';
import type { Ledger } from '../lifecycle/ledger';
import { storeCustomDependency, type ServiceIdentifier } from './instantiation';

export interface CollectionToken<T> {
  (target: any, key: string | symbol | undefined, index: number): void;

  readonly name: string;

  readonly __t?: T;

  toString(): string;
}

export interface DefinitionToken<T> extends CollectionToken<T> {
  readonly __definition?: T;
}

export interface DefinitionRecord<T> {
  readonly definition: T;
  readonly owner: string;
  readonly generation: number;
}

export interface DefinitionChange<T> {
  readonly current: DefinitionRecord<T> | undefined;
  readonly previous: DefinitionRecord<T> | undefined;
}

export interface DefinitionView<T> {
  readonly current: DefinitionRecord<T> | undefined;
  readonly onDidChangeDefinition: Event<DefinitionChange<T>>;
}

const _collectionTokens = new Map<string, CollectionToken<unknown>>();
const _collectionTokenSet = new WeakSet<object>();
const _definitionTokenSet = new WeakSet<object>();
const _collectionValidators = new WeakMap<
  object,
  (value: unknown, existing: readonly unknown[]) => void
>();

export function collection<T>(
  name: string,
  options: { readonly validate?: (value: T, existing: readonly T[]) => void } = {},
): CollectionToken<T> {
  const existing = _collectionTokens.get(name);
  if (existing !== undefined) {
    return existing as CollectionToken<T>;
  }
  const token = function collectionDecorator(
    target: any,
    _key: string | symbol | undefined,
    index: number,
  ): void {
    if (arguments.length !== 3) {
      throw new Error('@CollectionToken-decorator can only be used to decorate a parameter');
    }
    storeCustomDependency(token as unknown as ServiceIdentifier<any>, 'collection', target, index);
  } as unknown as CollectionToken<T>;
  Object.defineProperty(token, 'toString', {
    value: () => `collection:${name}`,
    enumerable: false,
  });
  Object.defineProperty(token, 'name', { value: name, enumerable: false, configurable: true });
  _collectionTokens.set(name, token as CollectionToken<unknown>);
  _collectionTokenSet.add(token);
  if (options.validate !== undefined) {
    _collectionValidators.set(
      token,
      options.validate as (value: unknown, existing: readonly unknown[]) => void,
    );
  }
  return token;
}

export function definition<T>(name: string): DefinitionToken<T> {
  const token = collection<T>(name, {
    validate: (_value, existing) => {
      if (existing.length > 0) throw new Error(`Definition ${name} already has an active provider`);
    },
  }) as DefinitionToken<T>;
  _definitionTokenSet.add(token);
  return token;
}

export function isCollectionToken(thing: unknown): thing is CollectionToken<unknown> {
  return typeof thing === 'function' && _collectionTokenSet.has(thing);
}

export function isDefinitionToken(thing: unknown): thing is DefinitionToken<unknown> {
  return typeof thing === 'function' && _definitionTokenSet.has(thing);
}

export interface CollectionRecord<T> {
  readonly value: T;
  readonly providerName: string;
  readonly scopePath: string;
}

export interface CollectionChange<T> {
  readonly added: readonly T[];
  readonly removed: readonly T[];
}

export interface CollectionView<T> {
  readonly items: readonly T[];
  readonly records: readonly CollectionRecord<T>[];
  readonly onDidChange: Event<CollectionChange<T>>;
}

interface StoredRecord {
  readonly id: number;
  readonly value: unknown;
  readonly providerName: string;
  readonly scopePath: string;
  readonly provider: object;
  readonly providerBook: Ledger;
}

export type { StoredRecord };

export class CollectionStore {
  private readonly _records = new Map<
    CollectionToken<unknown>,
    Map<number, StoredRecord>
  >();
  private readonly _views = new Set<CollectionViewImpl<unknown>>();
  private _nextId = 0;

  constructor(private readonly _parentOf: (container: object) => object | undefined) {}

  addRecord<T>(
    token: CollectionToken<T>,
    provider: object,
    providerName: string,
    scopePath: string,
    providerBook: Ledger,
    value: T,
  ): () => void {
    let records = this._records.get(token as CollectionToken<unknown>);
    if (records === undefined) {
      records = new Map();
      this._records.set(token as CollectionToken<unknown>, records);
    }
    _collectionValidators.get(token)?.(
      value,
      [...records.values()].map((entry) => entry.value),
    );
    const record: StoredRecord = {
      id: ++this._nextId,
      value,
      providerName,
      scopePath,
      provider,
      providerBook,
    };
    records.set(record.id, record);
    const fire = (view: CollectionViewImpl<unknown>, kind: 'added' | 'removed'): void => {
      if (view.consumer === provider || this._isRelated(view.consumer, provider)) {
        view._fireDelta(kind, [record]);
      }
    };
    for (const view of this._views) {
      if (view.token === (token as unknown as CollectionToken<unknown>)) {
        fire(view, 'added');
      }
    }
    return () => {
      if (!records.delete(record.id)) {
        return;
      }
      for (const view of this._views) {
        if (view.token === (token as unknown as CollectionToken<unknown>)) {
          fire(view, 'removed');
        }
      }
    };
  }

  createView<T>(token: CollectionToken<T>, consumer: object): CollectionViewImpl<T> {
    const view = new CollectionViewImpl<T>(this, token, consumer);
    this._views.add(view as unknown as CollectionViewImpl<unknown>);
    return view;
  }

  dropView(view: CollectionViewImpl<unknown>): void {
    this._views.delete(view);
  }

  recordsFor<T>(token: CollectionToken<T>, consumer: object): CollectionRecord<T>[] {
    const records = this._records.get(token as CollectionToken<unknown>);
    if (records === undefined) {
      return [];
    }
    const out: CollectionRecord<T>[] = [];
    for (const record of records.values()) {
      if (record.provider === consumer || this._isRelated(consumer, record.provider)) {
        out.push({
          value: record.value as T,
          providerName: record.providerName,
          scopePath: record.scopePath,
        });
      }
    }
    return out;
  }

  storedRecordsFor(
    token: CollectionToken<unknown>,
    consumer: object,
  ): readonly StoredRecord[] {
    const records = this._records.get(token);
    if (records === undefined) {
      return [];
    }
    const out: StoredRecord[] = [];
    for (const record of records.values()) {
      if (record.provider === consumer || this._isRelated(consumer, record.provider)) {
        out.push(record);
      }
    }
    return out;
  }

  definitionFor<T>(token: CollectionToken<T>, consumer: object): DefinitionRecord<T> | undefined {
    const record = this.storedRecordsFor(
      token as CollectionToken<unknown>,
      consumer,
    )[0];
    if (record === undefined) return undefined;
    return {
      definition: record.value as T,
      owner: `${record.providerName}@${record.scopePath}`,
      generation: record.id,
    };
  }

  private _isRelated(consumer: object, provider: object): boolean {
    for (let c: object | undefined = consumer; c !== undefined; c = this._parentOf(c)) {
      if (c === provider) return true;
    }
    for (let p: object | undefined = provider; p !== undefined; p = this._parentOf(p)) {
      if (p === consumer) return true;
    }
    return false;
  }
}

export class CollectionViewImpl<T> implements CollectionView<T>, DefinitionView<T> {
  private readonly _onDidChange = new Emitter<CollectionChange<T>>();
  private readonly _onDidChangeDefinition = new Emitter<DefinitionChange<T>>();
  readonly onDidChange: Event<CollectionChange<T>> = this._onDidChange.event;
  readonly onDidChangeDefinition: Event<DefinitionChange<T>> =
    this._onDidChangeDefinition.event;

  constructor(
    private readonly _store: CollectionStore,
    readonly token: CollectionToken<T>,
    readonly consumer: object,
  ) {}

  get records(): CollectionRecord<T>[] {
    return this._store.recordsFor(this.token, this.consumer);
  }

  get items(): readonly T[] {
    return this.records.map((record) => record.value);
  }

  get current(): DefinitionRecord<T> | undefined {
    return this._store.definitionFor(this.token, this.consumer);
  }

  _fireDelta(kind: 'added' | 'removed', records: readonly StoredRecord[]): void {
    const previous = kind === 'removed' ? this.definitionRecord(records[0]) : undefined;
    const values = records.map((record) => record.value as T);
    this._onDidChange.fire(
      kind === 'added'
        ? { added: values, removed: [] }
        : { added: [], removed: values },
    );
    if (isDefinitionToken(this.token)) {
      this._onDidChangeDefinition.fire({ current: this.current, previous });
    }
  }

  dispose(): void {
    this._store.dropView(this as unknown as CollectionViewImpl<unknown>);
    this._onDidChange.dispose();
    this._onDidChangeDefinition.dispose();
  }

  private definitionRecord(record: StoredRecord | undefined): DefinitionRecord<T> | undefined {
    if (record === undefined) return undefined;
    return {
      definition: record.value as T,
      owner: `${record.providerName}@${record.scopePath}`,
      generation: record.id,
    };
  }
}
