/**
 * `flag` domain — `IFlagRegistry` implementation.
 *
 * In-memory catalog of flag definitions. Seeds itself from the import-time
 * contributions (`getContributedFlags`) on construction, and also accepts
 * runtime `register` calls (used by tests). Bound at App scope.
 */

import { Disposable, type IDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { BugIndicatingError } from '#/errors';

import {
  type FlagDefinitionInput,
  type FlagId,
  getContributedFlags,
  IFlagRegistry,
} from './flagRegistry';

// NOTE: stays Disposable — its own 'get' collides with the Fiber
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
      throw new BugIndicatingError(`Flag '${definition.id}' is already registered`);
    }
    this.byId.set(definition.id, definition);
  }
}

registerScopedService(
  LifecycleScope.App,
  IFlagRegistry,
  FlagRegistryService,
  ScopeActivation.OnScopeCreated,
  'flag',
);
