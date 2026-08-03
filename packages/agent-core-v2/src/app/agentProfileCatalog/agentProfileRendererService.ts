/**
 * `agentProfileCatalog` domain — `IAgentProfileRenderer` implementation.
 *
 * Prefers a profile's structured renderer and preserves compatibility with
 * profiles that only expose `systemPrompt` by recording no date disclosure.
 * Bound at App scope.
 */

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';

import type {
  AgentProfile,
  AgentProfileContext,
  SystemPromptRenderResult,
} from './agentProfileCatalog';
import { IAgentProfileRenderer } from './agentProfileRenderer';

export class AgentProfileRendererService implements IAgentProfileRenderer {
  declare readonly _serviceBrand: undefined;

  render(profile: AgentProfile, context: AgentProfileContext): SystemPromptRenderResult {
    return (
      profile.renderSystemPrompt?.(context) ?? {
        text: profile.systemPrompt(context),
        environment: {
          cwd: context.cwd ?? '',
          date: { disclosed: false },
        },
      }
    );
  }
}

registerScopedService(
  LifecycleScope.App,
  IAgentProfileRenderer,
  AgentProfileRendererService,
  ScopeActivation.OnScopeCreated,
  'agentProfileCatalog',
);
