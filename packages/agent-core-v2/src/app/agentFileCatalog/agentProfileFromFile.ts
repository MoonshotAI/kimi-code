/**
 * `agentFileCatalog` domain (L3) — `AgentFileDefinition` → `AgentProfile` factory.
 *
 * The file body is a prompt template rendered against the shared variable
 * table (`systemPromptVars`): `${var}` placeholders substitute live context,
 * and `${base_prompt}` embeds the effective default profile's prompt so a file
 * can wrap the builtin behavior instead of replacing it. Explicit files are
 * marked as builtin overrides; directory files must opt in through frontmatter.
 * `tools` passes through as the allowlist (`undefined` = every tool active);
 * `disallowedTools` passes through as the denylist evaluated by
 * `IAgentToolPolicyService`; `subagents` passes through as the delegation
 * allowlist enforced by the `Agent` / `AgentSwarm` tools.
 */

import type {
  AgentProfile,
  AgentProfileContext,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import { renderPromptTemplate } from '#/app/agentProfileCatalog/profile-shared';

import type { AgentFileDefinition } from './types';

export function agentProfileFromFile(
  definition: AgentFileDefinition,
  basePrompt: (context: AgentProfileContext) => string,
): AgentProfile {
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
    subagents: definition.subagents,
    systemPrompt: (context) =>
      renderPromptTemplate(definition.prompt, context, { skillActive }, basePrompt),
  };
}
