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
