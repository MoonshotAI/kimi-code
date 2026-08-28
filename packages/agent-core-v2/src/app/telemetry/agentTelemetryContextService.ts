
import {
  IAgentTelemetryContextService,
  type AgentTelemetryContext,
} from './agentTelemetryContext';

export class AgentTelemetryContextService implements IAgentTelemetryContextService {
  declare readonly _serviceBrand: undefined;
  private context: AgentTelemetryContext;

  constructor() {
    this.context = { mode: 'agent' };
  }

  get(): AgentTelemetryContext {
    return this.context;
  }

  set(patch: Partial<AgentTelemetryContext>): void {
    this.context = { ...this.context, ...patch };
  }
}

