/**
 * `sessionTitle` domain (L6) — title prompt projection contract.
 *
 * Defines the Agent-scoped `IAgentTitlePromptSource` used to read the first
 * active natural-language prompts from the live conversation context.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IAgentTitlePromptSource {
  readonly _serviceBrand: undefined;

  firstUserPrompts(limit: number): Promise<readonly string[]>;
}

export const IAgentTitlePromptSource: ServiceIdentifier<IAgentTitlePromptSource> =
  createDecorator<IAgentTitlePromptSource>('agentTitlePromptSource');
