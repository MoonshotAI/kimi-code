/**
 * `toolPolicy` domain (L4) — Agent-scope tool authorization contract.
 *
 * Combines profile, global configuration, and Session-owned restrictions into
 * one policy used by both provider schema projection and executor preflight.
 */

import { createDecorator } from '#/_base/di/instantiation';
import type { ToolSource } from '#/tool/toolContract';

export interface IAgentToolPolicyService {
  readonly _serviceBrand: undefined;

  isToolActive(name: string, source?: ToolSource): boolean;
  setSessionDisabledTools(names: readonly string[]): Promise<void>;
}

export const IAgentToolPolicyService =
  createDecorator<IAgentToolPolicyService>('agentToolPolicyService');
