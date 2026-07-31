/**
 * `workspaceAgentProfileLoader` domain — `AgentProfileLoaderBase`, the shared
 * loader skeleton of the agent-profile extension point.
 *
 * A loader owns one source id: it loads an `AgentProfileContribution` and
 * registers it into the App-scope `IAgentProfileRegistry` under that id
 * (workspace-local loaders additionally tag a `workspaceKey`). The first load
 * starts when the subclass constructor calls {@link start} — after its own
 * fields are set, since `load()` is virtual. `ready` tracks the most recent
 * load pass; `reload()` replaces it, so a `fatal` failure does not wedge the
 * loader once the underlying problem is fixed. A rejecting `fatal` loader
 * (an invalid `--agent-file`) propagates into `ready` so session
 * materialization fails fast; a rejecting non-fatal loader degrades to a
 * warning and keeps any previously registered contribution, so directory
 * problems never poison the registry. Loads are serialized per loader — a
 * refresh never overlaps the previous pass — and the swallowed handler on
 * `ready` keeps an un-awaited rejection from crashing the process.
 */

import { Disposable, MutableDisposable, type IDisposable } from '#/_base/di/lifecycle';
import type { ILogService } from '#/_base/log/log';
import type { IAgentProfileRegistry } from '#/app/agentProfileCatalog/agentProfileRegistry';

import type { AgentProfileContribution } from '#/app/agentProfileCatalog/agentProfileContribution';

export abstract class AgentProfileLoaderBase extends Disposable {
  protected abstract readonly sourceId: string;
  protected abstract readonly priority: number;
  protected readonly fatal: boolean = false;

  private readyPromise: Promise<void> = Promise.resolve();
  private tail: Promise<void> = Promise.resolve();
  private readonly registrationHandle = this._register(new MutableDisposable<IDisposable>());

  constructor(
    protected readonly registry: IAgentProfileRegistry,
    protected readonly log: ILogService,
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
    const current = this.tail.catch(() => undefined).then(() => this.loadAndRegister());
    this.tail = current;
    return current;
  }

  private async loadAndRegister(): Promise<void> {
    try {
      const contribution = await this.load();
      this.registrationHandle.value = this.registry.register(this.sourceId, contribution, {
        priority: this.priority,
        workspaceKey: this.workspaceKey,
      });
    } catch (error) {
      if (this.fatal) throw error;
      this.log.warn(`agent profile loader "${this.sourceId}" load failed: ${String(error)}`);
    }
  }
}
