import type { ServiceRegistration } from '#/_base/di/test';
import {
  IAgentToolResultTruncationService,
  type IAgentToolResultTruncationService as ToolResultTruncationServiceStub,
} from '#/agent/toolResultTruncation/toolResultTruncation';

export function stubToolResultTruncationService(): ToolResultTruncationServiceStub {
  return {
    _serviceBrand: undefined,
    truncateForModel: async ({ result }) => result,
  };
}

export function registerToolResultTruncationServices(reg: ServiceRegistration): void {
  reg.defineInstance(IAgentToolResultTruncationService, stubToolResultTruncationService());
}
