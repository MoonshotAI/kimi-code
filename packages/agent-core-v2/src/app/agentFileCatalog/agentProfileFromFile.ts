/**
 * `agentFileCatalog` domain (L3) — `AgentFileDefinition` → `AgentProfile` factory.
 *
 * `promptMode: replace` profiles return the file body verbatim as the full system
 * prompt — no agentsMd / skills context injection, the user owns the whole
 * prompt. `promptMode: append` profiles reuse the builtin render pipeline and inject
 * the body into the shared template's `ROLE_ADDITIONAL` slot, keeping the
 * context injection intact. Explicit files are marked as builtin overrides;
 * directory files must opt in through frontmatter. `tools` passes through as the allowlist
 * (`undefined` = every tool active); `disallowedTools` passes through as the
 * denylist evaluated by `IAgentToolPolicyService`.
 */

import type { AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { renderSystemPrompt } from '#/app/agentProfileCatalog/profile-shared';

import type { AgentFileDefinition } from './types';

export function agentProfileFromFile(definition: AgentFileDefinition): AgentProfile {
  const skillActive =
    (definition.tools === undefined || definition.tools.includes('Skill')) &&
    !(definition.disallowedTools ?? []).includes('Skill');
  return {
    name: definition.name,
    description: definition.description,
    whenToUse: definition.whenToUse,
    override: definition.override || definition.source === 'explicit',
    tools: definition.tools,
    disallowedTools: definition.disallowedTools,
    systemPrompt:
      definition.promptMode === 'append'
        ? (context) => renderSystemPrompt(definition.prompt, context, { skillActive })
        : () => definition.prompt,
  };
}
