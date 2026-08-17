/**
 * `workspaceAgentProfileLoader` domain — `AgentProfileLoaderBase`, the shared
 * loader skeleton of the agent-profile extension point.
 *
 * A loader owns one source id: it loads an `AgentProfileContribution` payload
 * and contributes it to the `AgentProfileContribution` collection under that
 * id (workspace-local loaders additionally tag a `workspaceKey`); the
 * App-scope registry fold picks the record up from there. The first load
 * starts when the subclass constructor calls {@link start} — after its own
 * fields are set, since `load()` is virtual. `ready` tracks the most recent
 * load pass; `reload()` replaces it, so a `fatal` failure does not wedge the
 * loader once the underlying problem is fixed. A rejecting `fatal` loader
 * (an invalid `--agent-file`) propagates into `ready` so session
 * materialization fails fast; a rejecting non-fatal loader degrades to a
 * warning and keeps any previously contributed record, so directory problems
 * never poison the projection. Loads are serialized per loader — a refresh
 * never overlaps the previous pass — and the swallowed handler on `ready`
 * keeps an un-awaited rejection from crashing the process. The record hangs
 * on the loader unit's book, so disposing the loader withdraws it.
 */

import { MutableDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import type { ILogService } from '#/_base/log/log';
import { AgentProfileContribution } from '#/app/agentProfileCatalog/agentProfileContribution';
import type { IAgentProfileRegistry } from '#/app/agentProfileCatalog/agentProfileRegistry';

export abstract class AgentProfileLoaderBase extends Service {
  protected abstract readonly sourceId: string;
  protected abstract readonly priority: number;
  protected readonly fatal: boolean = false;

  private readyPromise: Promise<void> = Promise.resolve();
  private tail: Promise<void> = Promise.resolve();
  private readonly contributionHandle = this._register(new MutableDisposable<IDisposable>());

  constructor(
    protected readonly log: ILogService,
    private readonly registry?: IAgentProfileRegistry,
  ) {
    super();
  }

  get ready(): Promise<void> {
    return this.readyPromise;
  }

  protected start(): void {
    this.readyPromise = this.enqueue();
    void this.readyPromise.catch(() => undefined);
  }

  async reload(): Promise<void> {
    this.readyPromise = this.enqueue();
    void this.readyPromise.catch(() => undefined);
    await this.readyPromise;
  }

  protected abstract load(): Promise<AgentProfileContribution>;

  protected get workspaceKey(): string | undefined {
    return undefined;
  }

  private enqueue(): Promise<void> {
    const current = this.tail.catch(() => undefined).then(() => this.loadAndContribute());
    this.tail = current;
    return current;
  }

  private async loadAndContribute(): Promise<void> {
    try {
      const contribution = await this.load();
      const registration = {
        sourceId: this.sourceId,
        priority: this.priority,
        workspaceKey: this.workspaceKey,
        contribution,
      };
      if (this.registry !== undefined) {
        this.contributionHandle.value = this.registry.register(registration);
      } else {
        const handle = this.provide(AgentProfileContribution, registration);
        this.contributionHandle.value = { dispose: () => void handle.dispose() };
      }
    } catch (error) {
      if (this.fatal) throw error;
      this.log.warn(`agent profile loader "${this.sourceId}" load failed: ${String(error)}`);
    }
  }
}
