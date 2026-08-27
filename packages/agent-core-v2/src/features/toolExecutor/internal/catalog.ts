import { Emitter, type Event } from '#/_base/event';
import type { IDisposable } from '#/_base/di/lifecycle';
import { IInstantiationService } from '#/_base/di/instantiation';
import type { AgentRuntimeContext } from '#/agent/runtime/agentRuntime';
import type {
  AgentToolContribution as AgentToolContributionRecord,
  AgentToolFactoryContext,
  AgentToolProviderContribution,
} from '#/agent/toolRegistry/toolContribution';
import { IAgentToolContributionSource } from '#/agent/toolRegistry/toolContributionSourceService';
import type { ExecutableTool, ToolDisclosure, ToolInfo, ToolSource } from '#/tool/toolContract';

interface ToolEntry {
  readonly tool: ExecutableTool;
  readonly source: ToolSource;
  readonly disclosure?: ToolDisclosure;
  readonly owner: unknown;
}

export class ToolCatalog {
  private readonly tools = new Map<string, ToolEntry>();
  private readonly contributionEntries = new Map<AgentToolContributionRecord, ToolEntry>();
  private readonly changeEmitter = new Emitter<void>();
  readonly onDidChange: Event<void> = this.changeEmitter.event;
  private contributionSubscription: IDisposable | undefined;
  private providerViewSubscription: IDisposable | undefined;
  private readonly providerSubscriptions = new Map<AgentToolProviderContribution, IDisposable>();

  constructor(
    private readonly runtime: AgentRuntimeContext<unknown>,
    private readonly factoryContext: AgentToolFactoryContext,
    private readonly shouldActivate: (record: AgentToolContributionRecord) => boolean,
  ) {}

  activateContributions(): void {
    const contributions = this.runtime.get(IAgentToolContributionSource).view;
    this.reconcileContributions(contributions.items);
    this.contributionSubscription = contributions.onDidChange(() => {
      this.reconcileContributions(contributions.items);
    });
    const providers = this.runtime.get(IAgentToolContributionSource).providers;
    this.reconcileProviders(providers.items);
    this.providerViewSubscription = providers.onDidChange(() => {
      this.reconcileProviders(providers.items);
    });
  }

  dispose(): void {
    this.contributionSubscription?.dispose();
    this.providerViewSubscription?.dispose();
    for (const subscription of this.providerSubscriptions.values()) subscription.dispose();
    this.providerSubscriptions.clear();
    this.contributionSubscription = undefined;
    this.providerViewSubscription = undefined;
    this.contributionEntries.clear();
    this.tools.clear();
    this.changeEmitter.dispose();
  }

  private reconcileProviders(records: readonly AgentToolProviderContribution[]): void {
    const active = new Set(
      records.filter((record) => record.agentId === this.runtime.agent.agentId),
    );
    for (const [record, subscription] of this.providerSubscriptions) {
      if (active.has(record)) continue;
      subscription.dispose();
      this.providerSubscriptions.delete(record);
      this.setSource(record, []);
    }
    for (const record of active) {
      if (!this.providerSubscriptions.has(record)) {
        this.providerSubscriptions.set(record, record.onDidChange(() => {
          this.setSource(record, record.snapshot());
        }));
      }
      this.setSource(record, record.snapshot());
    }
  }

  reconcileContributions(records: readonly AgentToolContributionRecord[]): void {
    const current = new Set(records);
    let changed = false;
    for (const [record, entry] of this.contributionEntries) {
      if (current.has(record)) continue;
      this.contributionEntries.delete(record);
      if (this.tools.get(entry.tool.name) === entry) this.tools.delete(entry.tool.name);
      changed = true;
    }
    const instantiation = this.runtime.get(IInstantiationService);
    instantiation.invokeFunction((accessor) => {
      for (const record of records) {
        if (this.contributionEntries.has(record)) continue;
        if (!this.shouldActivate(record)) continue;
        if (record.options.when !== undefined && !record.options.when(accessor)) continue;
        const tool = record.options.create?.(this.factoryContext) ?? instantiation.createInstance(record.ctor);
        const entry: ToolEntry = {
          tool,
          source: record.options.source ?? 'builtin',
          disclosure: record.options.disclosure,
          owner: record,
        };
        this.tools.set(tool.name, entry);
        this.contributionEntries.set(record, entry);
        changed = true;
      }
    });
    if (changed) this.changeEmitter.fire();
  }

  setSource(owner: unknown, entries: readonly { readonly tool: ExecutableTool; readonly source: ToolSource; readonly disclosure?: ToolDisclosure }[]): void {
    let changed = false;
    for (const [name, entry] of this.tools) {
      if (entry.owner !== owner) continue;
      this.tools.delete(name);
      changed = true;
    }
    for (const entry of entries) {
      this.tools.set(entry.tool.name, { ...entry, owner });
      changed = true;
    }
    if (changed) this.changeEmitter.fire();
  }

  list(): readonly ToolInfo[] {
    return [...this.tools.values()]
      .map(({ tool, source, disclosure }) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        source,
        disclosure,
      }))
      .toSorted((a, b) => a.name.localeCompare(b.name));
  }

  listReferences(): readonly { readonly name: string; readonly source: ToolSource }[] {
    return [...this.tools.values()]
      .map(({ tool, source }) => ({ name: tool.name, source }))
      .toSorted((a, b) => a.name.localeCompare(b.name));
  }

  resolve(name: string): ExecutableTool | undefined {
    return this.tools.get(name)?.tool;
  }
}
