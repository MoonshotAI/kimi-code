import { createDecorator } from '#/_base/di/instantiation';

export const OUTPUT_LIMIT_RECOVERY_VARIANT = 'output_limit_recovery';

export interface IAgentOutputLimitRecoveryService {
  readonly _serviceBrand: undefined;
}

export const IAgentOutputLimitRecoveryService =
  createDecorator<IAgentOutputLimitRecoveryService>('agentOutputLimitRecoveryService');
