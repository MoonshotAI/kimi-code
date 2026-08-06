/**
 * `_base/contribution` domain — generic source-keyed contribution
 * registry.
 *
 * The storage half of the Contribution / Registry / Catalog extension-point
 * pattern: a *contribution* is a plain data structure offered by an outer
 * contributor (a loader, a plugin, a code module); the *registry* stores at
 * most one contribution per `sourceId` — re-registering the same `sourceId`
 * replaces the previous entry, which is the only dedup this layer performs.
 * Content-level dedup (e.g. by item name), ordering, and merge rules are the
 * Catalog's projection job, never the registry's. `register` returns a handle
 * whose `dispose` unregisters — but only the entry it registered, so a stale
 * handle can never evict a newer re-registration. Every mutation fires
 * `onDidChange` with the affected `sourceId` so catalogs can re-project.
 */

import { Disposable, type IDisposable } from '../di/lifecycle';
import { Emitter, type Event } from '../event';

export interface ContributionRegistration<T> {
  readonly sourceId: string;
  readonly priority: number;
  readonly contribution: T;
}

export interface RegisterContributionOptions {
  readonly priority?: number;
}

// NOTE: stays Disposable — its own 'get' collides with the Fiber
export class ContributionRegistry<T> extends Disposable {
  private readonly registrations = new Map<string, ContributionRegistration<T>>();
  private readonly onDidChangeEmitter = this._register(new Emitter<string>());
  readonly onDidChange: Event<string> = this.onDidChangeEmitter.event;

  register(
    sourceId: string,
    contribution: T,
    options?: RegisterContributionOptions,
  ): IDisposable {
    const registration: ContributionRegistration<T> = {
      sourceId,
      priority: options?.priority ?? 0,
      contribution,
    };
    this.registrations.set(sourceId, registration);
    this.onDidChangeEmitter.fire(sourceId);
    let active = true;
    return {
      dispose: () => {
        if (!active) return;
        active = false;
        if (this.registrations.get(sourceId) !== registration) return;
        this.registrations.delete(sourceId);
        this.onDidChangeEmitter.fire(sourceId);
      },
    };
  }

  unregister(sourceId: string): void {
    if (!this.registrations.delete(sourceId)) return;
    this.onDidChangeEmitter.fire(sourceId);
  }

  entries(): readonly ContributionRegistration<T>[] {
    return [...this.registrations.values()];
  }

  get(sourceId: string): ContributionRegistration<T> | undefined {
    return this.registrations.get(sourceId);
  }
}
