/**
 * `flag` domain (L3) — `IFlagRegistry` implementation.
 *
 * In-memory catalog of flag definitions. Seeds itself from the import-time
 * contributions (`getContributedFlags`) on construction, and also accepts
 * runtime `register` calls (used by tests). Bound at App scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable, type IDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import {
  type FlagDefinitionInput,
  type FlagId,
  getContributedFlags,
  IFlagRegistry,
} from './flagRegistry';

export class FlagRegistryService extends Disposable implements IFlagRegistry {
  declare readonly _serviceBrand: undefined;
  private readonly byId = new Map<FlagId, FlagDefinitionInput>();

  constructor() {
    super();
    for (const def of getContributedFlags()) {
      this.add(def);
    }
  }

  register(definition: FlagDefinitionInput): IDisposable {
    this.add(definition);
    return this._register({
      dispose: () => {
        this.byId.delete(definition.id);
      },
    });
  }

  get(id: FlagId): FlagDefinitionInput | undefined {
    return this.byId.get(id);
  }

  list(): readonly FlagDefinitionInput[] {
    return [...this.byId.values()];
  }

  private add(definition: FlagDefinitionInput): void {
    if (this.byId.has(definition.id)) {
      throw new Error(`Flag '${definition.id}' is already registered`);
    }
    this.byId.set(definition.id, definition);
  }
}

registerScopedService(
  LifecycleScope.App,
  IFlagRegistry,
  FlagRegistryService,
  InstantiationType.Delayed,
  'flag',
);
