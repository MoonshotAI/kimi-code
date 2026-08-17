/**
 * `toolActivation` domain — `IAgentToolActivationService` implementation.
 *
 * The fold over the `AgentToolContribution` collection (`toolRegistry`, L3):
 * folds `view.items` into the per-agent runtime registry — for each record
 * allowed by the workspace os-level veto (the seeded `sessionToolPolicyGate`)
 * AND the bound Profile's tool policy (`profile`), it resolves the
 * Agent-scope service through the container — nothing constructs the tool
 * before this `accessor.get` — and registers the real instance into the
 * runtime registry.
 *
 * The fold is incremental: `view.onDidChange` re-folds deltas — an `added`
 * record walks the same activation judgment, a `removed` record (provider
 * unit disposed) withdraws the tool from the runtime registry through the
 * registration handle kept per record. Re-folding never gates the fold
 * itself: collection edges never join a cascade contagion set.
 *
 * One full pass also runs explicitly (after restore and profile binding) and
 * re-runs on every `agent.status.updated` event, so tools newly allowed by a
 * runtime re-bind or `setActiveTools` are activated without a restart.
 * Already-registered names are skipped, and besides withdrawn records
 * nothing is ever unregistered here: restricting visibility remains the
 * request-time tool policy's job.
 *
 * Resolving contributions lazily inside `activate()` / the change
 * subscription — never from this service's own constructor — keeps the
 * historical cycle broken: some tools (SkillTool → `prompt` → `loop` →
 * `toolRegistry`) transitively depend on the tool registry, which by
 * activation time has long finished constructing. Bound at Agent scope; the
 * lifecycle's explicit `activate()` is the only full-resolution path.
 */

import { type CollectionView } from '#/_base/di/collection';
import { IInstantiationService } from '#/_base/di/instantiation';
import { type IDisposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentProfileService } from '#/agent/profile/profile';
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
      eventBus.subscribe('agent.status.updated', () => {
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
