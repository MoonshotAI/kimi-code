import type { AgentRuntimeContext } from '#/actor/agentRuntime';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { LoopControl } from './loop';
import type { AgentLoopLogic } from './loopLogic';

export interface LoopDurableState {
  readonly nextTurnId: number;
  readonly cancelledTurnIds: readonly number[];
  readonly lastEnded?: {
    readonly turnId: number;
    readonly reason: 'completed' | 'cancelled' | 'failed' | 'blocked';
    readonly durationMs?: number;
  };
}

const controls = new WeakMap<object, LoopControl>();
const durableStates = new WeakMap<object, () => LoopDurableState>();

export function registerLoopControl(
  agent: AgentContext,
  control: LoopControl | AgentLoopLogic,
  getDurableState: () => LoopDurableState,
): void {
  controls.set(agent, control);
  durableStates.set(agent, getDurableState);
}

export function getLoopControl(
  context: AgentRuntimeContext<unknown> | IAgentScopeContext | AgentContext,
): LoopControl {
  const control = tryGetLoopControl(context);
  if (control === undefined) {
    const agent = 'agent' in context ? context.agent : 'agentContext' in context ? context.agentContext : context;
    throw new Error(`Loop control for agent '${agent.agentId}' is unavailable`);
  }
  return control;
}

export function tryGetLoopControl(
  context: AgentRuntimeContext<unknown> | IAgentScopeContext | AgentContext,
): LoopControl | undefined {
  const agent = 'agent' in context ? context.agent : 'agentContext' in context ? context.agentContext : context;
  return controls.get(agent);
}

export function getLoopDurableState(
  context: AgentRuntimeContext<unknown> | IAgentScopeContext | AgentContext,
): LoopDurableState | undefined {
  const agent = 'agent' in context ? context.agent : 'agentContext' in context ? context.agentContext : context;
  return durableStates.get(agent)?.();
}
