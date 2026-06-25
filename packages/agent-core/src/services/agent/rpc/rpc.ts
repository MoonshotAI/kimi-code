import { createDecorator } from '../../../di';
import type {
  AgentAPI,
  SessionAPI,
} from '../../../rpc/core-api';
import type { PromisableMethods } from '../../../utils/types';

export interface IAgentRPCService extends PromisableMethods<AgentAPI> {}

export interface ISessionRPCService extends PromisableMethods<SessionAPI> {}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IAgentRPCService =
  createDecorator<IAgentRPCService>('agentRPCService');

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const ISessionRPCService =
  createDecorator<ISessionRPCService>('agentSessionRPCService');
