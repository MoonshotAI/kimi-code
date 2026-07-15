/**
 * `agentFileCatalog` domain (L3) — `AgentFileDefinition` → `AgentProfile` factory.
 *
 * `mode: replace` profiles return the file body verbatim as the full system
 * prompt — no agentsMd / skills context injection, the user owns the whole
 * prompt. `mode: append` profiles reuse the builtin render pipeline and inject
 * the body into the shared template's `ROLE_ADDITIONAL` slot, keeping the
 * context injection intact. `tools` passes through as the allowlist
 * (`undefined` = every tool active); `disallowedTools` passes through as the
 * denylist evaluated by `IAgentProfileService.isToolActive`.
 */

import type { AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { renderSystemPrompt } from '#/app/agentProfileCatalog/profile-shared';

import type { AgentFileDefinition } from './types';

// renderSystemPrompt only consults the list for `includes('Skill')`; inherit-all
// means the Skill tool is active, so probe with a list that answers true.
const SKILL_PROBE_ON_INHERIT = ['Skill'] as const;

export function agentProfileFromFile(definition: AgentFileDefinition): AgentProfile {
  return {
    name: definition.name,
    description: definition.description,
    whenToUse: definition.whenToUse,
    tools: definition.tools,
    disallowedTools: definition.disallowedTools,
    systemPrompt:
      definition.mode === 'append'
        ? (context) =>
            renderSystemPrompt(
              definition.prompt,
              context,
              definition.tools ?? SKILL_PROBE_ON_INHERIT,
            )
        : () => definition.prompt,
  };
}
