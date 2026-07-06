/**
 * `toolState` domain (L3) — `IAgentToolState` implementation.
 *
 * Holds the agent's opaque per-key tool store in the `wire` `ToolStoreModel`,
 * mutating it only through the `tools.update_store` Op
 * (`wire.dispatch(updateStore({ key, value }))`) and reading it through
 * `wire.getModel`. The `onUpdated` hook is driven by a `wire.subscribe` on that
 * model, so it fires on live writes but not during `wire.replay` (matching the
 * former `!restoring` gate). Bound at Agent scope.
 */

import { Disposable } from '#/_base/di';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { OrderedHookSlot } from '#/hooks';
import { IAgentWireService, type IWireService } from '#/wire';
import { IAgentToolState, type ToolStoreData, type ToolStoreKey } from './toolState';
import { ToolStoreModel, updateStore } from './toolStateOps';

export class AgentToolStateService extends Disposable implements IAgentToolState {
  declare readonly _serviceBrand: undefined;

  readonly hooks = {
    onUpdated: new OrderedHookSlot<{
      key: ToolStoreKey;
      value: ToolStoreData[ToolStoreKey];
    }>(),
  };

  constructor(@IAgentWireService private readonly wire: IWireService) {
    super();
    this._register(
      wire.subscribe(ToolStoreModel, (state, prev) => {
        if (state === prev) return;
        for (const key of Object.keys(state)) {
          if (state[key] !== prev[key]) {
            void this.hooks.onUpdated.run({
              key: key as ToolStoreKey,
              value: state[key] as ToolStoreData[ToolStoreKey],
            });
          }
        }
      }),
    );
  }

  get<K extends ToolStoreKey>(key: K): ToolStoreData[K] | undefined {
    return this.wire.getModel(ToolStoreModel)[key] as ToolStoreData[K] | undefined;
  }

  set<K extends ToolStoreKey>(key: K, value: ToolStoreData[K]): void {
    this.wire.dispatch(updateStore({ key, value }));
  }

  data(): Readonly<Partial<ToolStoreData>> {
    return { ...this.wire.getModel(ToolStoreModel) } as Readonly<Partial<ToolStoreData>>;
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentToolState,
  AgentToolStateService,
  InstantiationType.Delayed,
  'toolState',
);
