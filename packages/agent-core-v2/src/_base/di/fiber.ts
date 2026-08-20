import type { IDisposable } from './lifecycle';
import type { Emitter } from '../event';
import { isPromiseLike, type EffectBody } from '../lifecycle/disposer';
import { Ledger, type LedgerEntry } from '../lifecycle/ledger';
import {
  collection,
  isCollectionToken,
  type CollectionToken,
  type CollectionView,
} from './collection';
import { SyncDescriptor } from './descriptors';
import {
  isServiceIdentifier,
  ScopeActivation,
  _util,
  type LiveRef,
  type ServiceIdentifier,
} from './instantiation';

export enum FiberState {
  Pending = 0,
  Activating = 1,
  Active = 2,
  Unloading = 3,
  Failed = 4,
}

export interface ConfigSchema {
  readonly '~standard': {
    readonly validate: (value: unknown) => unknown;
  };
}

export interface RecipeStatics {
  readonly name?: string;
  readonly inject?: readonly ServiceIdentifier<any>[];
  readonly Config?: ConfigSchema;
  readonly meta?: Record<string, unknown>;
}

export type ServiceClassRecipe =
  (new (...args: any[]) => unknown) & RecipeStatics;

export type ServiceFunctionRecipe = ((
  fiber: Fiber,
  config?: any,
) => any) &
  RecipeStatics;

export type ServiceObjectRecipe = {
  apply(
    fiber: Fiber,
    config?: any,
  ): any;
} & RecipeStatics;

export type ServiceRecipe =
  | ServiceClassRecipe
  | ServiceFunctionRecipe
  | ServiceObjectRecipe;

export interface FiberProvideOptions {
  readonly config?: unknown;
  readonly activation?: ScopeActivation;
}

export interface Fiber {
  readonly name: string;
  readonly state: FiberState;
  readonly config: unknown;

  provide<T>(
    id: ServiceIdentifier<T>,
    recipe: ServiceClassRecipe,
    opts?: FiberProvideOptions,
  ): FiberHandle<T>;
  provide<T>(id: ServiceIdentifier<T>, instance: T): FiberHandle<T>;
  provide(recipe: ServiceRecipe, opts?: FiberProvideOptions): FiberHandle;
  provide<T>(token: CollectionToken<T>, value: T): FiberHandle;

  effect(body: EffectBody, label?: string): FiberHandle;

  on(event: string | Emitter<any>, handler: (e: any) => void): FiberHandle;

  get<T>(id: ServiceIdentifier<T>): T;
  ref<T>(id: ServiceIdentifier<T>): LiveRef<T>;
}

export interface FiberHandle<T = unknown> extends PromiseLike<FiberHandle<T>> {
  readonly name: string;
  readonly state: FiberState;
  readonly uid: number;
  update(config?: unknown): Promise<void>;
  dispose(): Promise<void>;
}

export class FiberProtocolError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'FiberProtocolError';
  }
}

export class ServiceRecipeError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'ServiceRecipeError';
  }
}

export interface ConstructionFrame {
  readonly ctor: new (...args: any[]) => any;
  readonly config: unknown;
  readonly token: ServiceIdentifier<any> | undefined;
  readonly host: FiberHost;
}

const _constructionStack: ConstructionFrame[] = [];

export function pushConstructionFrame(frame: ConstructionFrame): void {
  _constructionStack.push(frame);
}

export function popConstructionFrame(): void {
  _constructionStack.pop();
}

export function currentConstruction(): ConstructionFrame | undefined {
  return _constructionStack.at(-1);
}

export const SERVICE_MARK = Symbol('serviceUnit');

export function isServiceRecipe(ctor: any): ctor is ServiceClassRecipe {
  return typeof ctor === 'function' && ctor.prototype?.[SERVICE_MARK] === true;
}

export function isClassRecipe(recipe: unknown): recipe is ServiceClassRecipe {
  return (
    typeof recipe === 'function' &&
    Object.prototype.hasOwnProperty.call(recipe, 'prototype')
  );
}

export type BufferedOp = (runtime: Fiber) => void;

export interface UnitInternals {
  readonly unitBook: Ledger;
  takeUnitBuffer(): BufferedOp[] | null;
  setUnitRuntime(runtime: Fiber): void;
}

export interface FiberHost {
  mintUid(): number;
  provideToken<T>(
    id: ServiceIdentifier<T>,
    descriptor: SyncDescriptor<T>,
    options: {
      readonly activation: 'eager' | 'ondemand';
      readonly config?: unknown;
    },
  ): TokenProvideCore;
  provideTokenInstance<T>(id: ServiceIdentifier<T>, instance: T): TokenProvideCore;
  tokenState(id: ServiceIdentifier<any>): string | undefined;
  updateToken(id: ServiceIdentifier<any>, config: unknown, hasConfig: boolean): Promise<void>;
  resolveTokenWhenAvailable<T>(id: ServiceIdentifier<T>): Promise<T>;
  resolveInstance<T>(id: ServiceIdentifier<T>): T;
  materializedInstance<T>(id: ServiceIdentifier<T>): T | undefined;
  liveRef<T>(id: ServiceIdentifier<T>): LiveRef<T>;
  recordInstanceEdge(node: object | undefined, id: ServiceIdentifier<any>): void;
  collectionView<T>(token: CollectionToken<T>): CollectionView<T>;
  addCollectionRecord<T>(
    token: CollectionToken<T>,
    providerName: string,
    providerBook: Ledger,
    value: T,
  ): () => void;
  constructService<T>(ctor: new (...args: any[]) => T, config: unknown): T;
}

export interface TokenProvideCore {
  uid(): number;
  dispose(): Promise<void>;
  release(): void;
}

export type FiberEventResolver = (
  host: FiberHost,
  event: string,
  handler: (e: any) => void,
) => IDisposable;

let _eventResolver: FiberEventResolver | undefined;

export function setFiberEventResolver(resolver: FiberEventResolver | undefined): void {
  _eventResolver = resolver;
}

export function bindServiceUnit(instance: UnitInternals & IDisposable, frame: ConstructionFrame): void {
  const buffer = instance.takeUnitBuffer();
  if (buffer === null) {
    return;
  }
  const ctor = (instance as any).constructor as ServiceClassRecipe;
  const runtime = new FiberRuntime(
    frame.host,
    instance.unitBook,
    recipeName(ctor),
    frame.config,
    frame.token,
    new Set(_util.getInstanceDependencies(ctor as unknown as _util.DI_TARGET_OBJ).map((d) => d.id)),
    instance,
  );
  instance.setUnitRuntime(runtime);
  try {
    for (const op of buffer) {
      op(runtime);
    }
  } catch (error) {
    instance.dispose();
    throw error;
  }
}

function recipeName(recipe: RecipeStatics & { name?: string }): string {
  return recipe.name ?? 'anonymous';
}

function validateConfig(schema: ConfigSchema | undefined, config: unknown, name: string): unknown {
  if (schema === undefined) {
    return config;
  }
  const out = schema['~standard'].validate(config);
  if (isPromiseLike(out)) {
    throw new ServiceRecipeError(`config schema of unit '${name}' must validate synchronously`);
  }
  const result = out as {
    readonly value?: unknown;
    readonly issues?: ReadonlyArray<{ readonly message: string }>;
  };
  if (result.issues !== undefined && result.issues.length > 0) {
    throw new ServiceRecipeError(
      `invalid config for unit '${name}': ${result.issues.map((issue) => issue.message).join('; ')}`,
    );
  }
  return 'value' in result ? result.value : config;
}

function mapUnitState(state: string | undefined): FiberState {
  if (state === undefined) {
    return FiberState.Active;
  }
  switch (state) {
    case 'Pending':
      return FiberState.Pending;
    case 'Activating':
      return FiberState.Activating;
    case 'Unloading':
      return FiberState.Unloading;
    case 'Failed':
      return FiberState.Failed;
    default:
      return FiberState.Active;
  }
}

export class FiberRuntime implements Fiber {
  constructor(
    private readonly _host: FiberHost,
    private readonly _book: Ledger,
    readonly name: string,
    readonly config: unknown,
    private readonly _token: ServiceIdentifier<any> | undefined,
    private readonly _declared: ReadonlySet<ServiceIdentifier<any>>,
    private readonly _edgeNode: object | undefined,
  ) {}

  get state(): FiberState {
    if (this._token !== undefined) {
      return mapUnitState(this._host.tokenState(this._token));
    }
    return FiberState.Active;
  }

  provide<T>(
    id: ServiceIdentifier<T>,
    recipe: ServiceClassRecipe,
    opts?: FiberProvideOptions,
  ): FiberHandle<T>;
  provide<T>(id: ServiceIdentifier<T>, instance: T): FiberHandle<T>;
  provide(recipe: ServiceRecipe, opts?: FiberProvideOptions): FiberHandle;
  provide<T>(token: CollectionToken<T>, value: T): FiberHandle;
  provide(
    first: ServiceIdentifier<any> | ServiceRecipe | CollectionToken<any>,
    second?: any,
    third?: FiberProvideOptions,
  ): FiberHandle {
    if (isCollectionToken(first)) {
      return this._provideRecord(first, second);
    }
    if (isServiceIdentifier(first)) {
      if (isClassRecipe(second)) {
        return this._provideToken(first, second, third);
      }
      if (
        typeof second === 'function' ||
        (second !== null && typeof second === 'object' && typeof second.apply === 'function')
      ) {
        throw new ServiceRecipeError(
          `token-bound provide of '${String(first)}' requires a class recipe or an instance (function/object recipes are only valid for the anonymous form)`,
        );
      }
      return this._provideTokenInstance(first, second);
    }
    return this._provideAnonymous(first as ServiceRecipe, second as FiberProvideOptions | undefined);
  }

  effect(body: EffectBody, label?: string): FiberHandle {
    const entry = this._book.effect(body, label ?? `effect:${this.name}`);
    return new BasicFiberHandle({
      name: label ?? `effect:${this.name}`,
      uid: this._host.mintUid(),
      state: () => (entry.disposed ? FiberState.Unloading : FiberState.Active),
      update: async () => {
        await entry.dispose();
        if (this._book.isActive) {
          this._book.effect(body, label ?? `effect:${this.name}`);
        }
      },
      dispose: async () => {
        await entry.dispose();
      },
      whenActive: () => Promise.resolve(),
    });
  }

  on(event: string | Emitter<any>, handler: (e: any) => void): FiberHandle {
    let subscription: IDisposable;
    if (typeof event === 'string') {
      if (_eventResolver === undefined) {
        throw new FiberProtocolError(
          `no event resolver registered — cannot subscribe to '${event}'`,
        );
      }
      subscription = _eventResolver(this._host, event, handler);
    } else if (typeof event?.event === 'function') {
      subscription = event.event(handler);
    } else {
      throw new FiberProtocolError(`unsupported event source for unit '${this.name}'`);
    }
    const label = typeof event === 'string' ? `on:${event}` : `on:${event.constructor?.name ?? 'emitter'}`;
    const entry = this._book.register(() => {
      subscription.dispose();
    }, label);
    return new BasicFiberHandle({
      name: label,
      uid: this._host.mintUid(),
      state: () => (entry.disposed ? FiberState.Unloading : FiberState.Active),
      update: async () => {},
      dispose: async () => {
        await entry.dispose();
      },
      whenActive: () => Promise.resolve(),
    });
  }

  get<T>(id: ServiceIdentifier<T>): T {
    if (!this._declared.has(id)) {
      throw new FiberProtocolError(
        `unit '${this.name}' resolves undeclared dependency '${String(id)}' — declare it as a constructor parameter (class recipe) or in the inject static (function recipe)`,
      );
    }
    this._host.recordInstanceEdge(this._edgeNode, id);
    return this._host.resolveInstance(id);
  }

  ref<T>(id: ServiceIdentifier<T>): LiveRef<T> {
    return this._host.liveRef(id);
  }

  private _provideToken<T>(
    id: ServiceIdentifier<T>,
    recipe: ServiceClassRecipe,
    opts: FiberProvideOptions | undefined,
  ): FiberHandle<T> {
    if (!isClassRecipe(recipe)) {
      throw new ServiceRecipeError(
        `token-bound provide of '${String(id)}' requires a class recipe (function/object recipes are only valid for the anonymous form)`,
      );
    }
    const name = recipe.name ?? String(id);
    const config = validateConfig(recipe.Config, opts?.config, name);
    const core = this._host.provideToken(
      id,
      new SyncDescriptor<T>(recipe as new (...args: any[]) => T),
      {
        activation: opts?.activation === ScopeActivation.OnDemand ? 'ondemand' : 'eager',
        config,
      },
    );
    const entry = this._book.register(() => core.dispose(), `provide:${String(id)}`);
    return new BasicFiberHandle<T>({
      name,
      uid: undefined,
      uidOf: () => core.uid(),
      state: () => mapUnitState(this._host.tokenState(id)),
      update: (next) => {
        const hasConfig = next !== undefined;
        return this._host.updateToken(
          id,
          hasConfig ? validateConfig(recipe.Config, next, name) : undefined,
          hasConfig,
        );
      },
      dispose: async () => {
        await entry.dispose();
      },
      whenActive: () => this._host.resolveTokenWhenAvailable(id).then(() => undefined),
    });
  }

  private _provideTokenInstance<T>(id: ServiceIdentifier<T>, instance: T): FiberHandle<T> {
    const core = this._host.provideTokenInstance(id, instance);
    const entry = this._book.register(() => core.dispose(), `provide:${String(id)}`);
    return new BasicFiberHandle<T>({
      name: String(id),
      uid: undefined,
      uidOf: () => core.uid(),
      state: () => mapUnitState(this._host.tokenState(id)),
      update: () => this._host.updateToken(id, undefined, false),
      dispose: async () => {
        await entry.dispose();
      },
      whenActive: () => this._host.resolveTokenWhenAvailable(id).then(() => undefined),
    });
  }

  private _provideAnonymous(recipe: ServiceRecipe, opts: FiberProvideOptions | undefined): FiberHandle {
    if (isClassRecipe(recipe)) {
      return this._provideAnonymousClass(recipe, opts);
    }
    return this._provideFunction(recipe, opts);
  }

  private _provideAnonymousClass(recipe: ServiceClassRecipe, opts: FiberProvideOptions | undefined): FiberHandle {
    const name = recipeName(recipe);
    let config = validateConfig(recipe.Config, opts?.config, name);
    let state = FiberState.Activating;
    let failure: unknown;
    let instance: unknown;
    let entry: LedgerEntry | undefined;
    const construct = (nextConfig: unknown): void => {
      state = FiberState.Activating;
      instance = this._host.constructService(recipe, nextConfig);
      entry = this._book.register(() => {
        state = FiberState.Unloading;
        (instance as Partial<IDisposable>).dispose?.();
      }, `provide:${name}`);
      state = FiberState.Active;
    };
    try {
      construct(config);
    } catch (error) {
      state = FiberState.Failed;
      failure = error;
      throw error;
    }
    for (const dependency of _util.getInstanceDependencies(recipe as unknown as _util.DI_TARGET_OBJ)) {
      this._host.recordInstanceEdge(this._edgeNode, dependency.id);
    }
    return new BasicFiberHandle({
      name,
      uid: this._host.mintUid(),
      state: () => state,
      update: async (next) => {
        await entry?.dispose();
        entry = undefined;
        try {
          if (next !== undefined) {
            config = validateConfig(recipe.Config, next, name);
          }
          construct(config);
        } catch (error) {
          state = FiberState.Failed;
          failure = error;
          throw error;
        }
      },
      dispose: async () => {
        await entry?.dispose();
        entry = undefined;
      },
      whenActive: () => (failure !== undefined ? Promise.reject(failure) : Promise.resolve()),
    });
  }

  private _provideFunction(recipe: ServiceFunctionRecipe | ServiceObjectRecipe, opts: FiberProvideOptions | undefined): FiberHandle {
    const name = recipeName(recipe);
    const config = validateConfig(recipe.Config, opts?.config, name);
    const book = new Ledger(`unit:${name}`);
    const anchor = this._book.register((reason) => book.teardown(reason), `provide:${name}`);
    const facade = new FiberRuntime(
      this._host,
      book,
      name,
      config,
      undefined,
      new Set(recipe.inject ?? []),
      this._edgeNode,
    );
    const run = (): void => {
      let out: unknown;
      if (typeof recipe === 'function') {
        out = recipe(facade, config);
      } else {
        out = recipe.apply(facade, config);
      }
      book.effect((() => out) as EffectBody, `effect:${name}`);
    };
    try {
      run();
    } catch (error) {
      void book.teardown('unload');
      anchor.release();
      throw error;
    }
    return new BasicFiberHandle({
      name,
      uid: this._host.mintUid(),
      state: () => (anchor.disposed ? FiberState.Unloading : FiberState.Active),
      update: async () => {
        await book.clear('unload');
        try {
          run();
        } catch (error) {
          void book.teardown('unload');
          anchor.release();
          throw error;
        }
      },
      dispose: async () => {
        await anchor.dispose();
      },
      whenActive: () => Promise.resolve(),
    });
  }

  private _provideRecord<T>(token: CollectionToken<T>, value: T): FiberHandle {
    const remove = this._host.addCollectionRecord(token, this.name, this._book, value);
    const entry = this._book.register(() => {
      remove();
    }, `provide:${token.name}`);
    return new BasicFiberHandle({
      name: `${this.name}→${token.name}`,
      uid: this._host.mintUid(),
      state: () => (entry.disposed ? FiberState.Unloading : FiberState.Active),
      update: async () => {},
      dispose: async () => {
        await entry.dispose();
      },
      whenActive: () => Promise.resolve(),
    });
  }
}

interface BasicHandleParts {
  readonly name: string;
  readonly uid?: number;
  readonly uidOf?: () => number;
  readonly state: () => FiberState;
  readonly update: (config: unknown) => Promise<void>;
  readonly dispose: () => Promise<void>;
  readonly whenActive: () => Promise<void>;
}

class BasicFiberHandle<T> implements FiberHandle<T> {
  constructor(private readonly _parts: BasicHandleParts) {}

  get name(): string {
    return this._parts.name;
  }

  get state(): FiberState {
    return this._parts.state();
  }

  get uid(): number {
    if (this._parts.uidOf !== undefined) {
      return this._parts.uidOf();
    }
    return this._parts.uid!;
  }

  update(config?: unknown): Promise<void> {
    return this._parts.update(config);
  }

  dispose(): Promise<void> {
    return this._parts.dispose();
  }

  // eslint-disable-next-line eslint-plugin-unicorn(no-thenable)
  then<TResult1 = FiberHandle<T>, TResult2 = never>(
    onfulfilled?: ((value: FiberHandle<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return thenSettle(this._parts.whenActive().then(() => settledView(this)), onfulfilled, onrejected);
  }
}

interface SettledHandleView {
  readonly name: string;
  readonly state: FiberState;
  readonly uid: number;
  update(config?: unknown): Promise<void>;
  dispose(): Promise<void>;
}

function settledView<T>(handle: FiberHandle<T>): SettledHandleView {
  return {
    get name() {
      return handle.name;
    },
    get state() {
      return handle.state;
    },
    get uid() {
      return handle.uid;
    },
    update: (config?: unknown) => handle.update(config),
    dispose: () => handle.dispose(),
  };
}

function thenSettle<T, TResult1, TResult2>(
  settled: Promise<SettledHandleView>,
  onfulfilled: ((value: FiberHandle<T>) => TResult1 | PromiseLike<TResult1>) | null | undefined,
  onrejected: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null | undefined,
): PromiseLike<TResult1 | TResult2> {
  return settled.then(
    onfulfilled as unknown as (value: SettledHandleView) => TResult1 | PromiseLike<TResult1>,
    onrejected,
  );
}

export class PendingFiberHandle<T> implements FiberHandle<T> {
  private _real: FiberHandle<T> | undefined;
  private _disposed = false;

  constructor(private readonly _pendingName: string) {}

  attach(real: FiberHandle<T>): void {
    if (this._disposed) {
      void real.dispose();
      return;
    }
    this._real = real;
  }

  get name(): string {
    return this._real?.name ?? this._pendingName;
  }

  get state(): FiberState {
    return this._real?.state ?? FiberState.Activating;
  }

  get uid(): number {
    if (this._real === undefined) {
      throw new FiberProtocolError(
        `handle '${this._pendingName}' has not been flushed yet (construction protocol)`,
      );
    }
    return this._real.uid;
  }

  update(config?: unknown): Promise<void> {
    if (this._real === undefined) {
      return Promise.reject(
        new FiberProtocolError(`handle '${this._pendingName}' has not been flushed yet`),
      );
    }
    return this._real.update(config);
  }

  async dispose(): Promise<void> {
    this._disposed = true;
    await this._real?.dispose();
  }

  // eslint-disable-next-line eslint-plugin-unicorn(no-thenable) — FiberHandle is a thenable by design
  then<TResult1 = FiberHandle<T>, TResult2 = never>(
    onfulfilled?: ((value: FiberHandle<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    if (this._real !== undefined) {
      return this._real.then(onfulfilled, onrejected);
    }
    return thenSettle(Promise.resolve(settledView(this)), onfulfilled, onrejected);
  }
}

const _scopeUnitsTokens = new Map<string, CollectionToken<ServiceRecipe>>();

export function ScopeUnits(kind: string): CollectionToken<ServiceRecipe> {
  let token = _scopeUnitsTokens.get(kind);
  if (token === undefined) {
    token = collection<ServiceRecipe>(`scope-units:${kind}`);
    _scopeUnitsTokens.set(kind, token);
  }
  return token;
}

export type { EffectBody };
