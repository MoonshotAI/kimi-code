/**
 * `debug` domain — `IDebugCascadeService` implementation.
 *
 * Read paths fold the kernel's debug accessors (`cascadeTree.engines` /
 * `history` / `pendingSnapshot` / `unitsSnapshot`); the triggers only call the
 * kernel's public entries (`unprovide` / `cascade.update` / `cascade.submit`)
 * after resolving `(scopePath, token)` to a live container and identifier.
 * Publishes `event.di.unit_changed` through `event` (`IEventService`) for
 * every unit state transition of the tree. Bound at App scope, activated with
 * the scope so the event feed is always on.
 *
 * NOTE: does not extend `Disposable` — the wire trigger `dispose(scopePath,
 * token)` collides with `IDisposable.dispose`; the no-arg overload below is
 * the framework teardown (the container retires this unit by calling
 * `dispose()`), the two-arg overload is the trigger.
 */

import type { CascadeEngine } from '#/_base/di/cascadeEngine';
import {
  IInstantiationService,
  type ServiceIdentifier,
} from '#/_base/di/instantiation';
import type { InstantiationService } from '#/_base/di/instantiationService';
import { DisposableStore, type IDisposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IEventService } from '#/app/event/event';
import { LifecycleScope } from '#/app/scopes';
import { Error2, ErrorCodes } from '#/errors';

import {
  DiUnitChanged,
  IDebugCascadeService,
  type DebugCascadeEntry,
  type DebugFailedUnit,
  type DebugPendingGroup,
  type DebugPendingUnit,
  type DiUnitChangedPayload,
} from './debugCascade';
import {
  resolveScopeContainer,
  scopePathOfEngine,
  walkScopeContainers,
} from './scopeTree';

export class DebugCascadeService implements IDebugCascadeService {
  declare readonly _serviceBrand: undefined;

  private readonly root: InstantiationService;
  private readonly events: IEventService;
  private readonly store = new DisposableStore();
  private readonly engineSubscriptions = new Map<CascadeEngine, IDisposable>();
  private tornDown = false;

  constructor(
    @IInstantiationService instantiation: IInstantiationService,
    @IEventService events: IEventService,
  ) {
    this.root = instantiation as InstantiationService;
    this.events = events;
    const tree = this.root.cascadeTree;
    for (const engine of tree.engines) {
      this._watchEngine(engine);
    }
    this.store.add(
      tree.onDidAddEngine((engine) => {
        this._watchEngine(engine);
      }),
    );
    this.store.add(
      tree.onDidRemoveEngine((engine) => {
        this._unwatchEngine(engine);
      }),
    );
  }

  history(): DebugCascadeEntry[] {
    const entries: DebugCascadeEntry[] = [];
    for (const info of walkScopeContainers(this.root)) {
      for (const entry of info.container.cascade.history()) {
        entries.push({ scopePath: info.path, ...entry });
      }
    }
    return entries.toSorted(
      (a, b) => a.seq - b.seq || a.scopePath.localeCompare(b.scopePath),
    );
  }

  pending(): DebugPendingGroup[] {
    const groups: DebugPendingGroup[] = [];
    for (const info of walkScopeContainers(this.root)) {
      const waiting: DebugPendingUnit[] = [];
      for (const [token, missing] of info.container.cascade.pendingSnapshot()) {
        waiting.push({ token, missing: [...missing] });
      }
      const failed: DebugFailedUnit[] = info.container.cascade
        .unitsSnapshot()
        .filter((unit) => unit.state === 'Failed')
        .map((unit) => ({ token: unit.token, error: unit.error }));
      if (waiting.length > 0 || failed.length > 0) {
        groups.push({ scopePath: info.path, waiting, failed });
      }
    }
    return groups;
  }

  async unprovide(scopePath: string, token: string): Promise<void> {
    const { container, id } = this._resolve(scopePath, token);
    container.unprovide(id);
    await container.cascade.whenIdle();
  }

  async update(scopePath: string, token: string, config?: unknown): Promise<void> {
    const { container, id } = this._resolve(scopePath, token);
    if (config === undefined) {
      await container.cascade.update(id, `debug update ${token}`);
    } else {
      await container.fiberHost.updateToken(id, config, true);
    }
  }

  async dispose(scopePath: string, token: string): Promise<void>;
  dispose(): void;
  async dispose(scopePath?: string, token?: string): Promise<void> {
    if (scopePath === undefined && token === undefined) {
      if (!this.tornDown) {
        this.tornDown = true;
        this.store.dispose();
        for (const subscription of this.engineSubscriptions.values()) {
          subscription.dispose();
        }
        this.engineSubscriptions.clear();
      }
      return;
    }
    if (scopePath === undefined || token === undefined) {
      throw new Error2(
        ErrorCodes.DEBUG_TOKEN_NOT_FOUND,
        'dispose requires both a scope path and a token',
      );
    }
    const { container, id } = this._resolve(scopePath, token);
    await container.cascade.submit({
      action: 'unprovide',
      token: id,
      reason: `debug dispose ${token}`,
    });
  }

  private _resolve(
    scopePath: string,
    token: string,
  ): { container: InstantiationService; id: ServiceIdentifier<unknown> } {
    const container = resolveScopeContainer(this.root, scopePath);
    if (container === undefined) {
      throw new Error2(
        ErrorCodes.DEBUG_SCOPE_NOT_FOUND,
        `no DI container at scope path '${scopePath}'`,
      );
    }
    const id = container.findIdentifier(token);
    if (id === undefined) {
      throw new Error2(
        ErrorCodes.DEBUG_TOKEN_NOT_FOUND,
        `token '${token}' is not registered in container '${scopePath}'`,
      );
    }
    return { container, id };
  }

  private _watchEngine(engine: CascadeEngine): void {
    if (this.engineSubscriptions.has(engine)) {
      return;
    }
    this.engineSubscriptions.set(
      engine,
      engine.onDidChangeUnitState((change) => {
        const payload: DiUnitChangedPayload = {
          scope: scopePathOfEngine(this.root, engine) ?? '#unknown',
          token: change.token,
          state: change.state,
          error: change.error,
        };
        this.events.publish(new DiUnitChanged({ payload }));
      }),
    );
  }

  private _unwatchEngine(engine: CascadeEngine): void {
    this.engineSubscriptions.get(engine)?.dispose();
    this.engineSubscriptions.delete(engine);
  }
}

registerScopedService(
  LifecycleScope.App,
  IDebugCascadeService,
  DebugCascadeService,
  ScopeActivation.OnScopeCreated,
  'debug',
);
