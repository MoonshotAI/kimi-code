import {
  normalizeAgentProfile,
  type AgentProfile,
  type AgentProfileContext,
  type SystemPromptRenderResult,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { AgentProfileContribution } from '#/app/agentProfileCatalog/agentProfileContribution';
import { renderPromptTemplateResult } from '#/app/agentProfileCatalog/profile-shared';

import type { AgentFileDefinition, AgentFileDiscoveryResult } from './types';

export function agentProfileFromFile(
  definition: AgentFileDefinition,
  basePrompt: (context: AgentProfileContext) => SystemPromptRenderResult,
): AgentProfile {
  const skillActive =
    (definition.tools === undefined || definition.tools.includes('Skill')) &&
    !(definition.disallowedTools ?? []).includes('Skill');
  return normalizeAgentProfile({
    name: definition.name,
    description: definition.description,
    whenToUse: definition.whenToUse,
    override: definition.override || definition.source === 'explicit',
    tools: definition.tools,
    disallowedTools: definition.disallowedTools,
    subagents: definition.subagents,
    renderSystemPrompt: (context) =>
      renderPromptTemplateResult(definition.prompt, context, { skillActive }, basePrompt),
  });
}

export function profilesFromDiscovery(
  result: AgentFileDiscoveryResult,
  basePrompt: (context: AgentProfileContext) => SystemPromptRenderResult,
): AgentProfileContribution {
  return {
    profiles: result.agents.map((definition) => agentProfileFromFile(definition, basePrompt)),
    skipped: result.skipped,
    scannedRoots: result.scannedRoots,
  };
}
