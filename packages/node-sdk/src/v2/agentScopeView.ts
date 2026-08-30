import type { AgentContext } from '@moonshot-ai/agent-core-v2/agent/agentContext/agentContext';
import type { ServiceIdentifier } from '@moonshot-ai/agent-core-v2/_base/di/instantiation';
import type { ISessionScopeHandle } from '@moonshot-ai/agent-core-v2/_base/di/scope';
import { IEventBus } from '@moonshot-ai/agent-core-v2/app/event/eventBus';
import { ITelemetryService } from '@moonshot-ai/agent-core-v2/app/telemetry/telemetry';
import { IAgentTelemetryContextService } from '@moonshot-ai/agent-core-v2/app/telemetry/agentTelemetryContext';
import { IAgentBlobService } from '@moonshot-ai/agent-core-v2/agent/blob/agentBlobService';
import { IAgentContextProjectorService } from '@moonshot-ai/agent-core-v2/agent/contextProjector/contextProjector';
import { type AgentHost, IAgentHostService } from '@moonshot-ai/agent-core-v2/agent/host/agentHost';
import { IAgentRuntimeBindingService } from '@moonshot-ai/agent-core-v2/agent/runtimeBinding/runtimeBinding';
import { IAgentRuntimeService } from '@moonshot-ai/agent-core-v2/agent/runtimeBinding/agentRuntime';
import { IAgentStateService } from '@moonshot-ai/agent-core-v2/agent/state/agentState';
import { IEventDispatcher } from '@moonshot-ai/agent-core-v2/state/eventDispatcher';
import { IWireService } from '@moonshot-ai/agent-core-v2/wire/wire';
import { IAgentLifecycleService } from '@moonshot-ai/agent-core-v2/session/agentLifecycle/agentLifecycle';
import { IAgentPlanService } from '@moonshot-ai/agent-core-v2/features/plan/plan';
import { ISessionPlanService } from '@moonshot-ai/agent-core-v2/features/plan/sessionPlanService';
import { IAgentTaskService } from '@moonshot-ai/agent-core-v2/agent/task/task';
import { ISessionTaskService } from '@moonshot-ai/agent-core-v2/agent/task/sessionTaskService';
import { IAgentCommandService } from '@moonshot-ai/agent-core-v2/agent/command/agentCommand';
import { ISessionCommandService } from '@moonshot-ai/agent-core-v2/agent/command/sessionCommandService';
import { IAgentShellCommandService } from '@moonshot-ai/agent-core-v2/agent/shellCommand/shellCommand';
import { ISessionShellCommandService } from '@moonshot-ai/agent-core-v2/agent/shellCommand/sessionShellCommandService';
import { IAgentTowerService } from '@moonshot-ai/agent-core-v2/features/tower/tower';
import { ISessionTowerService } from '@moonshot-ai/agent-core-v2/features/tower/sessionTowerService';
import { IAgentPluginCommandService } from '@moonshot-ai/agent-core-v2/agent/pluginCommand/pluginCommand';
import { ISessionPluginCommandService } from '@moonshot-ai/agent-core-v2/agent/pluginCommand/sessionPluginCommandService';
import { IAgentSwarmService } from '@moonshot-ai/agent-core-v2/features/swarm/agent/swarm';
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
    case IAgentTaskService:
      return session.accessor.get(ISessionTaskService).of(agent);
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

export interface AgentScopeView {
  readonly id: string;
  readonly kind: 'agent';
  readonly context: AgentContext;
  readonly accessor: {
    get<T>(id: ServiceIdentifier<T>): T;
  };
}

export function syntheticAgentScope(
  session: ISessionScopeHandle,
  agent: AgentContext,
): AgentScopeView {
  return {
    id: agent.agentId,
    kind: 'agent',
    context: agent,
    accessor: {
      get: <T>(id: ServiceIdentifier<T>): T => {
        const host = session.accessor.get(IAgentHostService).of(agent);
        const member = hostMember(host, id as ServiceIdentifier<unknown>);
        if (member !== undefined) return member as T;
        const shell = shellService(session, agent, id as ServiceIdentifier<unknown>);
        if (shell !== undefined) return shell as T;
        return session.accessor.get(id);
      },
    },
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
