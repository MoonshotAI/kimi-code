/**
 * `AgentFileDefinition` → `ResolvedAgentProfile` adapter.
 *
 * The file body is a prompt template rendered against the agent-file variable
 * table: `${var}` placeholders substitute live context, and `${base_prompt}`
 * embeds the builtin default profile's prompt so a file can wrap the builtin
 * behavior instead of replacing it. The variable names and semantics match
 * the v2 engine (and the user docs), so the same agent file works on both
 * engines. The renderer is a plain `${var}` substitution — NOT the nunjucks
 * renderer the builtin YAML profiles use — so a literal `{{...}}` or an
 * unknown `${...}` in a user template can never crash rendering.
 *
 * `tools` resolves to the effective allowlist here: an omitted `tools` means
 * the default profile's tool set (v1 profiles have no "every tool" sentinel).
 * `disallowedTools` passes through to the profile verbatim and is evaluated
 * by the tool manager on top of the allowlist — exact builtin/user names and
 * `mcp__…` glob patterns both work, including partial server denies such as
 * `mcp__github__*` under an `mcp__*` allow. `subagents` stays an allowlist
 * of names on the definition; the catalog links it into the resolved record
 * after merging.
 *
 * Ported from the v2 engine (`packages/agent-core-v2/src/app/agentFileCatalog/agentProfileFromFile.ts`)
 * — keep the two in sync: template variables and profile-mapping semantics
 * must land in both engines.
 */

import type { ResolvedAgentProfile, SystemPromptContext } from '../types';
import {
  ADDITIONAL_DIRS_SECTION_PROSE,
  SKILLS_SECTION_PROSE,
  WINDOWS_NOTES,
} from '../prompt-sections';

import type { AgentFileDefinition } from './types';

const PROMPT_VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function renderTemplateVars(template: string, vars: Record<string, string>): string {
  return template.replace(PROMPT_VARIABLE, (match: string, name: string) => {
    const value = vars[name];
    return typeof value === 'string' ? value : match;
  });
}

export function agentFilePromptVars(
  context: SystemPromptContext,
  options: { readonly skillActive: boolean },
): Record<string, string> {
  const shellName = context.osEnv.shellName ?? '';
  const shellPath = context.osEnv.shellPath ?? '';
  const skills = options.skillActive
    ? typeof context.skills === 'string'
      ? context.skills
      : (context.skills?.getModelSkillListing() ?? '')
    : '';
  const additionalDirsInfo = context.additionalDirsInfo ?? '';
  const now =
    context.now instanceof Date
      ? context.now.toISOString()
      : (context.now ?? new Date().toISOString());
  return {
    role_additional: context.roleAdditional ?? '',
    os: context.osEnv.osKind ?? '',
    windows_notes: context.osEnv.osKind === 'Windows' ? `\n\n${WINDOWS_NOTES}\n\n` : '',
    shell: shellName.length > 0 ? `${shellName} (\`${shellPath}\`)` : '',
    now,
    cwd: context.cwd,
    cwd_listing: context.cwdListing ?? '',
    agents_md: context.agentsMd ?? '',
    additional_dirs_info: additionalDirsInfo,
    additional_dirs_section:
      additionalDirsInfo.length > 0
        ? `\n\n## Additional Directories\n\n${ADDITIONAL_DIRS_SECTION_PROSE}\n\n${additionalDirsInfo}\n\n`
        : '',
    skills,
    skills_section:
      skills.length > 0 ? `\n\n# Skills\n\n${SKILLS_SECTION_PROSE}\n\n${skills}\n\n` : '',
  };
}

export function renderAgentFileTemplate(
  template: string,
  context: SystemPromptContext,
  options: { readonly skillActive: boolean },
  basePrompt?: (context: SystemPromptContext) => string,
): string {
  const vars = agentFilePromptVars(context, options);
  if (basePrompt !== undefined && template.includes('${base_prompt}')) {
    vars['base_prompt'] = basePrompt(context);
  }
  return renderTemplateVars(template, vars);
}

export function skillActiveForAgentFile(definition: AgentFileDefinition): boolean {
  return (
    (definition.tools === undefined || definition.tools.includes('Skill')) &&
    !(definition.disallowedTools ?? []).includes('Skill')
  );
}

/**
 * The effective tool allowlist for a file-defined profile: the file's own
 * `tools`, or the default profile's set when unrestricted. The denylist is
 * NOT folded in here — it rides the profile's `disallowedTools` so the tool
 * manager can evaluate glob patterns against resolved MCP tool names.
 */
export function agentFileTools(
  definition: AgentFileDefinition,
  defaultTools: readonly string[],
): string[] {
  return definition.tools === undefined ? [...defaultTools] : [...definition.tools];
}

export function agentProfileFromFile(
  definition: AgentFileDefinition,
  defaultTools: readonly string[],
  basePrompt: (context: SystemPromptContext) => string,
): ResolvedAgentProfile {
  const skillActive = skillActiveForAgentFile(definition);
  return {
    name: definition.name,
    description: definition.description,
    systemPrompt: (context) =>
      renderAgentFileTemplate(definition.prompt, context, { skillActive }, basePrompt),
    tools: agentFileTools(definition, defaultTools),
    disallowedTools:
      definition.disallowedTools === undefined ? undefined : [...definition.disallowedTools],
    whenToUse: definition.whenToUse,
    modelPreference: definition.modelPreference,
  };
}
