/**
 * `externalHooks` domain (L6) — contract for configured external hook
 * commands.
 *
 * The service is intentionally observer-shaped: business domains expose their
 * own minimal hook contexts, and the L6 implementation listens to those hooks
 * to invoke configured external commands.
 */

import { createDecorator } from '#/_base/di/instantiation';

export interface RenderedExternalHookResult {
  readonly event: string;
  readonly message: string;
  readonly text: string;
}

export interface IAgentExternalHooksService {
  readonly _serviceBrand: undefined;
}

export const IAgentExternalHooksService =
  createDecorator<IAgentExternalHooksService>('agentExternalHooksService');
