/**
 * `di` domain — the `Service` base class for L3 unit recipes.
 *
 * Extending `Service` turns a class into a unit recipe with the five `Fiber`
 * capabilities (`this.provide` / `effect` / `on` / `get` / `ref`). The class
 * follows the two-phase construction protocol: inside the constructor — when
 * the container builds the instance under a matching `ConstructionFrame` —
 * capability calls do not run immediately; they are buffered as
 * `BufferedOp`s and answered with `PendingFiberHandle`s, then flushed
 * against the real `FiberRuntime` by `bindServiceUnit` right after
 * construction (`fiber.ts`). Reads (`get` / `ref`) are forbidden during this
 * phase — declare dependencies as constructor parameters instead (构造期只写
 * 不读). A `Service` created by manual `new` never gets a bound runtime, and
 * its capability calls throw `FiberProtocolError`.
 *
 * The `SERVICE_MARK` prototype marker (set below) lets the container
 * recognize `Service`-derived class recipes and drive them through this
 * protocol; services whose members collide with the `Service` vocabulary
 * keep `extends Disposable` and use the function/object recipe forms
 * instead.
 */

import type { Emitter } from '../event';
import type { EffectBody } from '../lifecycle/disposer';
import type { Ledger } from '../lifecycle/ledger';
import type { CollectionToken } from './collection';
import {
  currentConstruction,
  FiberProtocolError,
  FiberState,
  PendingFiberHandle,
  SERVICE_MARK,
  type BufferedOp,
  type Fiber,
  type FiberHandle,
  type FiberProvideOptions,
  type FiberRuntime,
  type RecipeStatics,
  type ServiceClassRecipe,
  type ServiceRecipe,
  type UnitInternals,
} from './fiber';
import type { ServiceIdentifier, LiveRef } from './instantiation';
import { Disposable } from './lifecycle';

export abstract class Service extends Disposable implements Fiber, UnitInternals {
  private __unitBuffer: BufferedOp[] | null;
  private __unitRuntime: FiberRuntime | undefined;

  readonly name: string;
  readonly state: FiberState = FiberState.Active;
  readonly config: unknown;

  constructor() {
    super();
    const frame = currentConstruction();
    if (
      frame !== undefined &&
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      frame.ctor === (new.target as unknown as new (...args: any[]) => any)
    ) {
      this.__unitBuffer = [];
      this.config = frame.config;
    } else {
      this.__unitBuffer = null;
      this.config = undefined;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.name = (this.constructor as any).name || 'anonymous';
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    first: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    second?: any,
    third?: FiberProvideOptions,
  ): FiberHandle {
    if (this.__unitBuffer !== null) {
      const pending = new PendingFiberHandle(this._pendingName(first));
      this.__unitBuffer.push((runtime) => {
        pending.attach(runtime.provide(first, second, third));
      });
      return pending;
    }
    return this._runtime().provide(first, second, third);
  }

  effect(body: EffectBody, label?: string): FiberHandle {
    if (this.__unitBuffer !== null) {
      const pending = new PendingFiberHandle(label ?? `effect:${this.name}`);
      this.__unitBuffer.push((runtime) => {
        pending.attach(runtime.effect(body, label));
      });
      return pending;
    }
    return this._runtime().effect(body, label);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string | Emitter<any>, handler: (e: any) => void): FiberHandle {
    const label = typeof event === 'string' ? `on:${event}` : 'on:emitter';
    if (this.__unitBuffer !== null) {
      const pending = new PendingFiberHandle(label);
      this.__unitBuffer.push((runtime) => {
        pending.attach(runtime.on(event, handler));
      });
      return pending;
    }
    return this._runtime().on(event, handler);
  }

  get<T>(id: ServiceIdentifier<T>): T {
    return this._runtime().get(id);
  }

  ref<T>(id: ServiceIdentifier<T>): LiveRef<T> {
    return this._runtime().ref(id);
  }

  get unitBook(): Ledger {
    return this._store.ledger;
  }

  takeUnitBuffer(): BufferedOp[] | null {
    const buffer = this.__unitBuffer;
    this.__unitBuffer = null;
    return buffer;
  }

  setUnitRuntime(runtime: FiberRuntime): void {
    this.__unitRuntime = runtime;
  }

  private _runtime(): FiberRuntime {
    if (this.__unitRuntime === undefined) {
      if (this.__unitBuffer !== null) {
        throw new FiberProtocolError(
          `unit '${this.name}': get/ref/provide reads are not available during construction — declare dependencies as constructor parameters (构造期只写不读)`,
        );
      }
      throw new FiberProtocolError(
        `unit '${this.name}': no unit runtime is bound — a Service created by manual \`new\` has no capabilities; construct it through the container`,
      );
    }
    return this.__unitRuntime;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _pendingName(first: any): string {
    if (typeof first === 'function') {
      return (first as RecipeStatics).name ?? String(first);
    }
    return this.name;
  }
}

(Service.prototype as unknown as Record<symbol, unknown>)[SERVICE_MARK] = true;
