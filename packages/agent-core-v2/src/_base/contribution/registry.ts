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
