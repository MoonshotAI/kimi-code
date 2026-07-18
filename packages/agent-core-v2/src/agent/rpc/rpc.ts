import { createDecorator } from "#/_base/di/instantiation";
import type {
  AgentAPI,
  SessionAPI,
} from './core-api';
import type { PromisableMethods } from "#/_base/utils/types";

export interface IAgentRPCService extends PromisableMethods<AgentAPI> {
  readonly _serviceBrand: undefined;
}

export interface ISessionRPCService extends PromisableMethods<SessionAPI> {
  readonly _serviceBrand: undefined;
}

export const IAgentRPCService =
  createDecorator<IAgentRPCService>('agentRPCService');

export const ISessionRPCService =
  createDecorator<ISessionRPCService>('agentSessionRPCService');
