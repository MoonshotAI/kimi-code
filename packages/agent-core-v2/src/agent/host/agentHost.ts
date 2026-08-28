import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import type { IAgentBlobService } from '#/agent/blob/agentBlobService';
import type { IAgentContextProjectorService } from '#/agent/contextProjector/contextProjector';
import type { IAgentRuntimeBindingService } from '#/agent/runtimeBinding/runtimeBinding';
import type { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { IAgentStateService } from '#/agent/state/agentState';
import type { IAgentTelemetryContextService } from '#/app/telemetry/agentTelemetryContext';
import type { IEventBus } from '#/app/event/eventBus';
import type { ITelemetryService } from '#/app/telemetry/telemetry';
import type { RuntimeBinding } from '#/runtime/runtime';
import type { IEventDispatcher } from '#/state/eventDispatcher';
import type { IWireService } from '#/wire/wire';

export interface AgentHost {
  readonly scopeContext: IAgentScopeContext;
  readonly telemetry: ITelemetryService;
  readonly eventBus: IEventBus;
  readonly blob: IAgentBlobService;
  readonly wire: IWireService;
  readonly state: IAgentStateService;
  readonly dispatcher: IEventDispatcher;
  readonly telemetryContext: IAgentTelemetryContextService;
  readonly runtimeBinding: IAgentRuntimeBindingService;
  readonly agentRuntime: IAgentRuntimeService;
  readonly contextProjector: IAgentContextProjectorService;
  dispose(): Promise<void>;
}

export interface AgentHostOverrides {
  readonly blob?: IAgentBlobService;
  readonly wire?: IWireService;
  readonly state?: IAgentStateService;
  readonly eventBus?: IEventBus;
  readonly dispatcher?: IEventDispatcher;
  readonly telemetryContext?: IAgentTelemetryContextService;
  readonly runtimeBinding?: IAgentRuntimeBindingService;
  readonly agentRuntime?: IAgentRuntimeService;
  readonly contextProjector?: IAgentContextProjectorService;
}

export interface AgentHostCreateInput {
  readonly scopeContext: IAgentScopeContext;
  readonly binding: RuntimeBinding;
  readonly overrides?: AgentHostOverrides;
}

export interface IAgentHostService {
  readonly _serviceBrand: undefined;

  create(input: AgentHostCreateInput): AgentHost;

  of(agent: AgentContext): AgentHost;

  tryOf(agent: AgentContext): AgentHost | undefined;

  release(agent: AgentContext): void;
}

export const IAgentHostService: ServiceIdentifier<IAgentHostService> =
  createDecorator<IAgentHostService>('agentHostService');
