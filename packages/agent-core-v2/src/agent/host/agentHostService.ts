import type { CollectionView } from '#/_base/di/collection';
import { Disposable, type IDisposable } from '#/_base/di/lifecycle';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { LifecycleScope } from '#/app/scopes';
import { ISessionEventBus } from '#/app/event/eventBus';
import { AgentEventBusView } from '#/app/event/eventBusService';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { AgentTelemetryContextService } from '#/app/telemetry/agentTelemetryContextService';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { AgentBlobServiceImpl } from '#/agent/blob/agentBlobServiceImpl';
import { AgentContextProjectorService } from '#/agent/contextProjector/contextProjectorService';
import { AgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { AgentRuntimeBindingService } from '#/agent/runtimeBinding/runtimeBindingService';
import { AgentStateService } from '#/agent/state/agentStateService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IBlobStore } from '#/persistence/interface/blobStore';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionStateService } from '#/session/state/sessionState';
import { EventDispatcherService } from '#/state/eventDispatcherService';
import { EventStateContribution, type EventStateContributionRecord } from '#/state/stateContribution';
import { WireService } from '#/wire/wireService';
import {
  IRuntimeResolver,
  IWorkspaceInstanceManager,
} from '#/workspace/workspaceInstance/workspaceInstanceManager';

import {
  type AgentHost,
  type AgentHostCreateInput,
  IAgentHostService,
} from './agentHost';

export class AgentHostService extends Disposable implements IAgentHostService {
  declare readonly _serviceBrand: undefined;
  private readonly entries = new Map<string, AgentHost>();

  constructor(
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IBlobStore private readonly blobStore: IBlobStore,
    @IAppendLogStore private readonly appendLog: IAppendLogStore,
    @ISessionEventBus private readonly sessionEventBus: ISessionEventBus,
    @ILogService private readonly log: ILogService,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IRuntimeResolver private readonly runtimeResolver: IRuntimeResolver,
    @IWorkspaceInstanceManager private readonly workspaceInstances: IWorkspaceInstanceManager,
    @EventStateContribution private readonly eventStates: CollectionView<EventStateContributionRecord>,
    @ISessionStateService private readonly sessionState?: ISessionStateService,
  ) {
    super();
    this._register({
      dispose: () => {
        this.entries.clear();
      },
    });
  }

  create(input: AgentHostCreateInput): AgentHost {
    const agent = input.scopeContext.agentContext;
    const overrides = input.overrides ?? {};
    const owned: IDisposable[] = [];
    const track = <T extends object>(member: T): T => {
      if (typeof (member as Partial<IDisposable>).dispose === 'function') {
        owned.push(member as IDisposable);
      }
      return member;
    };
    try {
      const scopeContext = input.scopeContext;
      const telemetry = this.telemetry.withContext({ agent_id: agent.agentId });
      const blob = overrides.blob ?? track(new AgentBlobServiceImpl(this.blobStore, scopeContext));
      const wire = overrides.wire ?? track(new WireService(scopeContext, this.appendLog, blob));
      const state = overrides.state ?? track(new AgentStateService(this.sessionState));
      const eventBus = overrides.eventBus ?? track(new AgentEventBusView(this.sessionEventBus, scopeContext));
      const dispatcher = overrides.dispatcher ?? track(new EventDispatcherService(wire, eventBus, scopeContext, blob, state, this.eventStates));
      const telemetryContext = overrides.telemetryContext ?? new AgentTelemetryContextService();
      const runtimeBinding = overrides.runtimeBinding ?? track(new AgentRuntimeBindingService(
        scopeContext,
        state,
        { _serviceBrand: undefined, binding: input.binding },
        this.sessionContext,
        this.runtimeResolver,
        dispatcher,
      ));
      const agentRuntime = overrides.agentRuntime ?? track(new AgentRuntimeService(
        runtimeBinding,
        this.runtimeResolver,
        this.workspaceInstances,
      ));
      const contextProjector = overrides.contextProjector ?? new AgentContextProjectorService(this.log, telemetry, state);
      let disposed = false;
      const host: AgentHost = {
        scopeContext,
        telemetry,
        eventBus,
        blob,
        wire,
        state,
        dispatcher,
        telemetryContext,
        runtimeBinding,
        agentRuntime,
        contextProjector,
        dispose: async (): Promise<void> => {
          if (disposed) return;
          disposed = true;
          this.entries.delete(agent.agentId);
          for (let index = owned.length - 1; index >= 0; index -= 1) {
            owned[index]!.dispose();
          }
        },
      };
      this.entries.set(agent.agentId, host);
      return host;
    } catch (error) {
      for (let index = owned.length - 1; index >= 0; index -= 1) {
        owned[index]!.dispose();
      }
      throw error;
    }
  }

  of(agent: AgentContext): AgentHost {
    const host = this.entries.get(agent.agentId);
    if (host === undefined) {
      throw new Error(`Agent host for '${agent.agentId}' is unavailable`);
    }
    return host;
  }

  tryOf(agent: AgentContext): AgentHost | undefined {
    return this.entries.get(agent.agentId);
  }

  release(agent: AgentContext): void {
    this.entries.delete(agent.agentId);
  }
}

registerScopedService(
  LifecycleScope.Session,
  IAgentHostService,
  AgentHostService,
  ScopeActivation.OnScopeCreated,
  'agentHost',
);
