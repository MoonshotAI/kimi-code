

import {
  createDecorator,
  type ServiceIdentifier,
} from '#/_base/di/instantiation';
import type {
  CommandVerdict,
  ExecRule,
  SegmentDecision,
  UnsourcedRule,
} from '@moonshot-ai/exec-policy';

export interface ExecPolicyEvaluation {
  readonly verdict: CommandVerdict;
  readonly segments: readonly SegmentDecision[];

  readonly matchedRule?: ExecRule;
  readonly segmentCount: number;
}

export interface IAgentExecPolicyService {
  readonly _serviceBrand: undefined;

  evaluate(command: string): Promise<ExecPolicyEvaluation>;

  evaluateHost(host: string, protocol?: string): Promise<SegmentDecision>;

  addSessionRule(rule: UnsourcedRule): void;
}

export const IAgentExecPolicyService: ServiceIdentifier<IAgentExecPolicyService> =
  createDecorator<IAgentExecPolicyService>('agentExecPolicyService');
