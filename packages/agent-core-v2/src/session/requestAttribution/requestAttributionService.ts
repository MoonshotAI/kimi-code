import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import type { RequestModel, TurnModelStep } from '#/agent/loop/turnOps';

import {
  type AgentRequestAttribution,
  ISessionRequestAttributionService,
} from './requestAttribution';

interface ObservedStep {
  request: TurnModelStep;
  subagents: TurnModelStep[];
}

export class SessionRequestAttributionService
  extends Service
  implements ISessionRequestAttributionService
{
  declare readonly _serviceBrand: undefined;

  private readonly agents = new Map<string, AgentRequestAttribution>();
  private readonly modelTurns = new Map<string, {
    turnId: number;
    steps: Map<number, ObservedStep>;
    parentStep?: ObservedStep;
    currentStep?: ObservedStep;
  }>();

  of(agentId: string): AgentRequestAttribution {
    return this.agents.get(agentId) ?? {};
  }

  noteUserInput(agentId: string, userInputId: string): void {
    this.agents.set(agentId, { ...this.of(agentId), userInputId });
  }

  noteActiveRequest(agentId: string, requestId: string | undefined, active = true, source?: { turnId: number; step?: number }): void {
    const current = this.of(agentId);
    const trimmed = requestId?.trim();
    const valid = trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
    const turn = this.modelTurns.get(agentId);
    const step = turn?.currentStep?.request;
    if (source !== undefined && turn?.turnId === source.turnId && step !== undefined && step.step === source.step) {
      step.requestId = valid;
    }
    this.agents.set(agentId, {
      ...current,
      activeRequestId: active ? valid : undefined,
      lastRequestId: valid ?? current.lastRequestId,
    });
  }

  noteSubagentDispatch(agentId: string, parentAgentId: string, turnId?: number): AgentRequestAttribution {
    const current = this.of(agentId);
    const parent = this.of(parentAgentId);
    const parentTurn = this.modelTurns.get(parentAgentId);
    const parentStep = parentTurn?.parentStep ?? parentTurn?.currentStep;
    if (turnId !== undefined && parentStep !== undefined) this.modelTurns.set(agentId, { turnId, steps: new Map(), parentStep });
    const next: AgentRequestAttribution = {
      ...current,
      userInputId: parent.userInputId ?? current.userInputId,
      parentRequestId: parent.activeRequestId ?? current.parentRequestId,
    };
    this.agents.set(agentId, next);
    return next;
  }

  noteModel(agentId: string, turnId: number, step: number, model: RequestModel): void {
    let turn = this.modelTurns.get(agentId);
    if (turn?.turnId !== turnId) {
      turn = { turnId, steps: new Map() };
      this.modelTurns.set(agentId, turn);
    }
    const current: ObservedStep = { request: { ...model, step, role: 'step' }, subagents: [] };
    turn.steps.set(step, current);
    turn.currentStep = current;
    const parent = turn.parentStep;
    if (parent !== undefined && !parent.subagents.some(other => other.model === model.model && other.provider === model.provider && other.isKfc === model.isKfc)) {
      parent.subagents.push({ ...model, role: 'subagent', step: parent.request.step });
    }
  }

  finishModelSteps(agentId: string, turnId: number): TurnModelStep[] | undefined {
    const turn = this.modelTurns.get(agentId);
    if (turn?.turnId !== turnId) return undefined;
    this.modelTurns.delete(agentId);
    if (!turn.steps.size) return undefined;
    return Array.from(turn.steps.values()).flatMap(step => [step.request, ...step.subagents]);
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionRequestAttributionService,
  SessionRequestAttributionService,
  ScopeActivation.OnDemand,
  'requestAttribution',
);
