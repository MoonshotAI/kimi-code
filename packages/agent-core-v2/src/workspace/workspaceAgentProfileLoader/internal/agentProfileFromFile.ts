/**
 * `workspaceAgentProfileLoader` domain — `AgentFileDefinition` → `AgentProfile` factory.
 *
 * The file body is a prompt template rendered against the shared variable
 * table: `${var}` placeholders substitute live context,
 * and `${base_prompt}` embeds the effective default profile's prompt so a file
 * can wrap the builtin behavior instead of replacing it. Explicit files are
 * marked as builtin overrides; directory files must opt in through frontmatter.
 * `tools` passes through as the allowlist (`undefined` = every tool active);
 * `disallowedTools` passes through as the tool denylist; `subagents` passes
 * through as the delegation allowlist; `model_preference` becomes the
 * symbolic default model used when the profile is delegated to.
 * `profilesFromDiscovery` packs a whole discovery pass into an
 * `AgentProfileContribution`, binding each profile's `${base_prompt}`
 * placeholder lazily at render time so it always reflects the effective
 * default profile (builtin, or the `SYSTEM.md` override) rather than any
 * file-based definition.
 */

import type {
  AgentProfile,
  AgentProfileContext,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { AgentProfileContribution } from '#/app/agentProfileCatalog/agentProfileContribution';
import { renderPromptTemplate } from '#/app/agentProfileCatalog/profile-shared';

import type { AgentFileDefinition, AgentFileDiscoveryResult } from './types';

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
    modelPreference: definition.modelPreference,
    systemPrompt: (context) =>
      renderPromptTemplate(definition.prompt, context, { skillActive }, basePrompt),
  };
}

export function profilesFromDiscovery(
  result: AgentFileDiscoveryResult,
  basePrompt: (context: AgentProfileContext) => string,
): AgentProfileContribution {
  return {
    profiles: result.agents.map((definition) => agentProfileFromFile(definition, basePrompt)),
    skipped: result.skipped,
    scannedRoots: result.scannedRoots,
  };
}
