import type { AgentFileDiscoveryResult } from '../discovery/discovery';
import type { ProfileFinderContribution } from '../discovery/finder';
import { renderPromptTemplateResult } from '../render/render';
import type { AgentFileDefinition } from './agent-file';
import {
  normalizeAgentProfile,
  type AgentProfile,
  type AgentProfileContext,
  type SystemPromptRenderResult,
} from './types';

export type AgentProfileBasePrompt = (
  context: AgentProfileContext,
) => SystemPromptRenderResult;

export function agentProfileFromFile(
  definition: AgentFileDefinition,
  basePrompt: AgentProfileBasePrompt,
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
  basePrompt: AgentProfileBasePrompt,
): ProfileFinderContribution {
  return {
    profiles: result.agents.map((definition) => agentProfileFromFile(definition, basePrompt)),
    skipped: result.skipped,
    scannedRoots: result.scannedRoots,
  };
}
