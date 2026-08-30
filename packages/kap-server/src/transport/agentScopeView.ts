import {
  IAgentBlobService,
  IAgentCommandService,
  IAgentContextProjectorService,
  IAgentHostService,
  IAgentLifecycleService,
  IAgentPlanService,
  IAgentPluginCommandService,
  IAgentRuntimeBindingService,
  IAgentRuntimeService,
  IAgentShellCommandService,
  IAgentStateService,
  IAgentSwarmService,
  IAgentTelemetryContextService,
  IAgentTowerService,
  IEventBus,
  IEventDispatcher,
  ITelemetryService,
  IWireService,
  type AgentContext,
  type AgentHost,
  type IScopeHandle,
  type ISessionScopeHandle,
  type ServiceIdentifier,
} from '@moonshot-ai/agent-core-v2';
import { ISessionPlanService } from '@moonshot-ai/agent-core-v2/features/plan/sessionPlanService';
import { ISessionCommandService } from '@moonshot-ai/agent-core-v2/agent/command/sessionCommandService';
import { ISessionShellCommandService } from '@moonshot-ai/agent-core-v2/agent/shellCommand/sessionShellCommandService';
import { ISessionTowerService } from '@moonshot-ai/agent-core-v2/features/tower/sessionTowerService';
import { ISessionPluginCommandService } from '@moonshot-ai/agent-core-v2/agent/pluginCommand/sessionPluginCommandService';
import { ISessionSwarmAgentService } from '@moonshot-ai/agent-core-v2/features/swarm/session/sessionSwarmAgentService';

function hostMember(host: AgentHost, id: ServiceIdentifier<unknown>): unknown {
  switch (id) {
    case IAgentBlobService:
      return host.blob;
    case IWireService:
      return host.wire;
    case IAgentStateService:
      return host.state;
    case IEventBus:
      return host.eventBus;
    case IEventDispatcher:
      return host.dispatcher;
    case ITelemetryService:
      return host.telemetry;
    case IAgentTelemetryContextService:
      return host.telemetryContext;
    case IAgentRuntimeBindingService:
      return host.runtimeBinding;
    case IAgentRuntimeService:
      return host.agentRuntime;
    case IAgentContextProjectorService:
      return host.contextProjector;
    default:
      return undefined;
  }
}

function shellService(
  session: ISessionScopeHandle,
  agent: AgentContext,
  id: ServiceIdentifier<unknown>,
): unknown {
  switch (id) {
    case IAgentPlanService:
      return session.accessor.get(ISessionPlanService).of(agent);
    case IAgentCommandService:
      return session.accessor.get(ISessionCommandService).of(agent);
    case IAgentShellCommandService:
      return session.accessor.get(ISessionShellCommandService).of(agent);
    case IAgentTowerService:
      return session.accessor.get(ISessionTowerService).of(agent);
    case IAgentPluginCommandService:
      return session.accessor.get(ISessionPluginCommandService).of(agent);
    case IAgentSwarmService:
      return session.accessor.get(ISessionSwarmAgentService).of(agent);
    default:
      return undefined;
  }
}

export function agentServiceResolver(
  session: ISessionScopeHandle,
  agent: AgentContext,
) {
  return <T>(id: never): T => {
    const host = session.accessor.get(IAgentHostService).of(agent);
    const member = hostMember(host, id as unknown as ServiceIdentifier<unknown>);
    if (member !== undefined) return member as T;
    const shell = shellService(session, agent, id as unknown as ServiceIdentifier<unknown>);
    if (shell !== undefined) return shell as T;
    return session.accessor.get(id as unknown as ServiceIdentifier<T>);
  };
}

export interface AgentScopeView extends IScopeHandle {
  readonly context: AgentContext;
}

export function syntheticAgentScope(
  session: ISessionScopeHandle,
  agent: AgentContext,
): AgentScopeView {
  return {
    id: agent.agentId,
    kind: 'agent',
    context: agent,
    accessor: { get: agentServiceResolver(session, agent) },
    dispose: () => {},
  };
}

export function liveAgentScope(
  session: ISessionScopeHandle,
  agentId: string,
): AgentScopeView | undefined {
  const agent = session.accessor.get(IAgentLifecycleService).get(agentId);
  if (agent === undefined) return undefined;
  return syntheticAgentScope(session, agent);
}
