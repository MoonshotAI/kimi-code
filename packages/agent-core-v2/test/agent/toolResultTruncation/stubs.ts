import type { ServiceRegistration } from '#/_base/di/test';
import {
  IAgentToolResultTruncationService,
  type IAgentToolResultTruncationService as ToolResultTruncationServiceStub,
} from '#/agent/toolResultTruncation/toolResultTruncation';
import { ISessionToolResultTruncationService } from '#/agent/toolResultTruncation/sessionToolResultTruncationService';

export function stubToolResultTruncationService(): ToolResultTruncationServiceStub {
  return {
    _serviceBrand: undefined,
    truncateForModel: async ({ result }) => result,
  };
}

export function registerToolResultTruncationServices(reg: ServiceRegistration): void {
  const impl = stubToolResultTruncationService();
  reg.defineInstance(IAgentToolResultTruncationService, impl);
  reg.defineInstance(ISessionToolResultTruncationService, {
    _serviceBrand: undefined,
    attach: () => {},
    of: () => impl,
  } as ISessionToolResultTruncationService);
}
