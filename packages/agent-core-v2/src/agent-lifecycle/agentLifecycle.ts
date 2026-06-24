/**
 * `agent-lifecycle` domain (L6) — session-scope agent factory + handle map.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IScopeHandle } from '#/_base/di/scope';

export interface CreateAgentOptions {
  readonly agentId?: string;
  readonly parentAgentId?: string;
  readonly cwd?: string;
}

export interface IAgentLifecycleService {
  readonly _serviceBrand: undefined;
  create(opts: CreateAgentOptions): Promise<IScopeHandle>;
  createMain(): Promise<IScopeHandle>;
  getHandle(agentId: string): IScopeHandle | undefined;
  list(): readonly IScopeHandle[];
  remove(agentId: string): Promise<void>;
}

export const IAgentLifecycleService: ServiceIdentifier<IAgentLifecycleService> =
  createDecorator<IAgentLifecycleService>('agentLifecycleService');
