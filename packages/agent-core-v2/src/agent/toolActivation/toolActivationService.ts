import { type CollectionView } from '#/_base/di/collection';
import { IInstantiationService } from '#/_base/di/instantiation';
import { type IDisposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentProfileService } from '#/agent/profile/profile';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { isToolActive } from '#/agent/toolPolicy/evaluate';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { AgentToolContribution } from '#/agent/toolRegistry/toolContribution';
import { ISessionToolPolicyGate } from '#/session/sessionToolPolicyGate/sessionToolPolicyGate';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';

import { IAgentToolActivationService } from './toolActivation';

export class AgentToolActivationService extends Service implements IAgentToolActivationService {
  declare readonly _serviceBrand: undefined;

  private readonly registrations = new Map<AgentToolContribution, IDisposable>();

  constructor(
    @IInstantiationService private readonly instantiationService: IInstantiationService,
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @ISessionToolPolicyGate private readonly toolPolicyGate: ISessionToolPolicyGate,
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @IEventBus eventBus: IEventBus,
    @AgentToolContribution private readonly contributions: CollectionView<AgentToolContribution>,
  ) {
    super();
    this._register(
      eventBus.subscribe(AgentStatusUpdated, () => {
        void this.activate();
      }),
    );
    this._register(this.runtime.onDidChange(() => this.refreshRuntimeRecords()));
    this._register(
      this.contributions.onDidChange((change) => {
        this.activateRecords(change.added);
        for (const record of change.removed) {
          this.deactivateRecord(record);
        }
      }),
    );
  }

  activate(): Promise<void> {
    this.activateRecords(this.contributions.items);
    return Promise.resolve();
  }

  private activateRecords(records: readonly AgentToolContribution[]): void {
    if (records.length === 0) return;
    const data = this.profile.data();
    const policy = { tools: data.activeToolNames, disallowedTools: data.disallowedTools };
    const workspaceVeto = { disallowedTools: this.toolPolicyGate.disabledTools };
    this.instantiationService.invokeFunction((accessor) => {
      for (const record of records) {
        const { id, options } = record;
        const source = options.source ?? 'builtin';
        if (this.toolRegistry.resolve(options.name) !== undefined) continue;
        if (!this.runtimeAllows(record)) continue;
        if (!isToolActive(workspaceVeto, options.name, source)) continue;
        if (!isToolActive(policy, options.name, source)) continue;
        if (options.when !== undefined && !options.when(accessor)) continue;
        const tool = accessor.get(id);
        const registration = this.toolRegistry.register(tool, {
          source: options.source,
          disclosure: options.disclosure,
        });
        this.registrations.set(record, registration);
        this._register(registration);
      }
    });
  }

  private refreshRuntimeRecords(): void {
    for (const record of this.contributions.items) {
      if (!this.runtimeAllows(record)) this.deactivateRecord(record);
    }
    this.activateRecords(this.contributions.items);
  }

  private runtimeAllows(record: AgentToolContribution): boolean {
    const required = record.options.requiredRuntimeCapabilities;
    return required === undefined || this.runtime.isAvailable(required);
  }

  private deactivateRecord(record: AgentToolContribution): void {
    const registration = this.registrations.get(record);
    if (registration === undefined) return;
    this.registrations.delete(record);
    registration.dispose();
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentToolActivationService,
  AgentToolActivationService,
  ScopeActivation.OnScopeCreated,
  'toolActivation',
);
