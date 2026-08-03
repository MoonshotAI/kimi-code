/**
 * `agentProfileCatalog` domain — profile rendering contract.
 *
 * Renders a profile together with the environment facts disclosed by that
 * render. Bound at App scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type {
  AgentProfile,
  AgentProfileContext,
  SystemPromptRenderResult,
} from './agentProfileCatalog';

export interface IAgentProfileRenderer {
  readonly _serviceBrand: undefined;

  render(profile: AgentProfile, context: AgentProfileContext): SystemPromptRenderResult;
}

export const IAgentProfileRenderer: ServiceIdentifier<IAgentProfileRenderer> =
  createDecorator<IAgentProfileRenderer>('agentProfileRenderer');
