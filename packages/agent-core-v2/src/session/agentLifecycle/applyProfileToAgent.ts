/**
 * `agentLifecycle` domain (L6) — helper for applying a named
 * {@link AgentProfileDefinition} onto a freshly spawned child agent.
 *
 * Not a Service: `applyProfileToAgent` is a pure function borrowing the child
 * scope's `IAgentProfileService` from an accessor. The parent's profile has
 * already been copied by `IAgentLifecycleService.spawn`; this helper overlays
 * the named-profile fields (`activeToolNames`, `systemPromptOverlay`, and the
 * bookkeeping `profileName`) on top. Callers that need the per-invocation
 * prompt prefix or summary policy read those fields off the definition
 * separately — this helper does not touch prompt content.
 */

import type { IAgentScopeHandle } from '#/_base/di/scope';
import { IAgentProfileService } from '#/agent/profile';
import type { AgentProfileDefinition } from '#/app/agentProfileCatalog';

export function applyProfileToAgent(
  child: IAgentScopeHandle,
  profile: AgentProfileDefinition,
): void {
  const service = child.accessor.get(IAgentProfileService);
  const currentData = service.data();
  const activeToolNames = profile.activeToolNames ?? currentData.activeToolNames;
  const systemPrompt = profile.systemPromptOverlay
    ? `${currentData.systemPrompt}\n\n${profile.systemPromptOverlay}`
    : currentData.systemPrompt;
  service.update({
    profileName: profile.name,
    systemPrompt,
    activeToolNames,
  });
}
