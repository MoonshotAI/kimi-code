/**
 * `di` domain — the kernel-side `ScopeUnits(kind)` fold (L3, D11/G2).
 *
 * `ScopeUnits(kind)` is the materialization collection token the kernel mints
 * per scope kind. When a scope of that kind is created, this fold watches the
 * new scope's live view of the token and materializes every record's recipe
 * as a unit INSIDE that scope (cross-scope materialization): a feature
 * contributed once at App scope becomes one live unit per Session/Agent
 * scope, automatically.
 *
 * Lifetime rules (per §5.6):
 * - the materialized unit's disposal hangs on the RECORD PROVIDER's book —
 *   disposing the provider retracts the record and tears the materialized
 *   units down across the tree (连坐);
 * - a target scope's natural death tears its materialized units down with it
 *   (the fold ledger is anchored into the scope's container ledger); both
 *   anchors are idempotent, so a provider dying mid-teardown is a no-op;
 * - records visible at creation are materialized immediately; the view's
 *   incremental changes reconcile the set by record identity.
 *
 * A materialized unit's own `this.provide(...)` registrations are ordinary
 * token provides in the target scope — they join the graph and cascades as
 * usual. The materialized unit itself carries no token identity, so its own
 * constructor dependencies do not independently join cascades (feature
 * recipes are dependency-free assemblies by convention, per the Plan
 * sample); its provided tokens fully participate.
 */

import { onUnexpectedError } from '../errors/unexpectedError';
import type { IDisposable } from './lifecycle';
import { Ledger } from '../lifecycle/ledger';
import type { StoredRecord } from './collection';
import {
  FiberRuntime,
  isClassRecipe,
  ScopeUnits,
  type EffectBody,
  type ServiceRecipe,
} from './fiber';
import type { InstantiationService } from './instantiationService';
import type { ScopeKind } from './scope';

export function watchScopeUnits(container: InstantiationService, kind: ScopeKind): void {
  if (container.cascadeDisposed) {
    return;
  }
  const token = ScopeUnits(kind);
  const host = container.fiberHost;
  const view = host.collectionView(token);
  const foldLedger = new Ledger(`scope-units:${kind}`);
  container.anchorKernelEntry((reason) => foldLedger.teardown(reason), `scope-units:${kind}`);

  const materialized = new Map<number, () => void>();

  const materialize = (record: StoredRecord): void => {
    const recipe = record.value as ServiceRecipe;
    const name = record.providerName;
    const unitLedger = new Ledger(`scope-units:${kind}:${name}`);
    try {
      if (isClassRecipe(recipe)) {
        const instance = host.constructService(recipe, undefined) as Partial<IDisposable>;
        unitLedger.register(() => {
          instance.dispose?.();
        }, `unit:${name}`);
      } else {
        const facade = new FiberRuntime(
          host,
          unitLedger,
          name,
          undefined,
          undefined,
          new Set(recipe.inject ?? []),
          undefined,
        );
        const out =
          typeof recipe === 'function'
            ? recipe(facade, undefined)
            : recipe.apply(facade, undefined);
        unitLedger.effect((() => out) as EffectBody, `effect:${name}`);
      }
    } catch (error) {
      void unitLedger.teardown('unload');
      onUnexpectedError(error);
      return;
    }

    let retracted = false;
    const retract = (): void => {
      if (retracted) {
        return;
      }
      retracted = true;
      materialized.delete(record.id);
      void unitLedger.teardown('unload');
    };
    if (!record.providerBook.isActive) {
      retract();
      return;
    }
    record.providerBook.register(() => {
      retract();
    }, `scope-units:${kind}`);
    foldLedger.register(() => {
      retract();
    }, `record:${name}`);
    materialized.set(record.id, retract);
  };

  const reconcile = (): void => {
    if (!foldLedger.isActive) {
      return;
    }
    const records = container.collectionStore.storedRecordsFor(token, container);
    const seen = new Set<number>();
    for (const record of records) {
      seen.add(record.id);
      if (!materialized.has(record.id)) {
        materialize(record);
      }
    }
    // Snapshot: `retract()` deletes its own entry from `materialized`.
    for (const [id, retract] of Array.from(materialized)) {
      if (!seen.has(id)) {
        retract();
      }
    }
  };

  const subscription = view.onDidChange(() => {
    reconcile();
  });
  foldLedger.register(() => {
    subscription.dispose();
  }, 'view-subscription');
  reconcile();
}
