/**
 * `debug` domain — `IDebugLedgerService` implementation.
 *
 * Read-only introspection over the kernel's debug accessors (`children` /
 * `servicesSnapshot` / `unitsSnapshot` / `ledger.entries`); no kernel state is
 * mutated. Bound at App scope; the injected container is the tree root.
 */

import { IInstantiationService } from '#/_base/di/instantiation';
import type { InstantiationService } from '#/_base/di/instantiationService';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';

import { IDebugLedgerService, type DebugLedgerNode, type DebugUnit } from './debugLedger';
import { scopeContainerLabel } from './scopeTree';

export class DebugLedgerService implements IDebugLedgerService {
  declare readonly _serviceBrand: undefined;

  private readonly root: InstantiationService;

  constructor(@IInstantiationService instantiation: IInstantiationService) {
    this.root = instantiation as InstantiationService;
  }

  tree(): DebugLedgerNode {
    return this._node(this.root, scopeContainerLabel(this.root));
  }

  private _node(container: InstantiationService, path: string): DebugLedgerNode {
    return {
      path,
      label: scopeContainerLabel(container),
      units: joinUnits(container),
      ledger: container.ledger.entries(),
      children: container.children.map((child) =>
        this._node(child, `${path}/${scopeContainerLabel(child)}`),
      ),
    };
  }
}

function joinUnits(container: InstantiationService): DebugUnit[] {
  const states = new Map(container.cascade.unitsSnapshot().map((unit) => [unit.token, unit]));
  return container.servicesSnapshot().map((registration) => {
    const unit = states.get(registration.token);
    return {
      token: registration.token,
      uid: registration.uid,
      state: unit?.state,
      error: unit?.error,
      everActive: unit?.everActive,
      inFlight: unit?.inFlight,
    };
  });
}

registerScopedService(
  LifecycleScope.App,
  IDebugLedgerService,
  DebugLedgerService,
  ScopeActivation.OnDemand,
  'debug',
);
