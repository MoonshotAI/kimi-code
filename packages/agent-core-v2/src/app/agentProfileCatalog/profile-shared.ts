/**
 * `agentProfileCatalog` domain (L3) — shared prompt helpers for builtin profiles.
 *
 * Keeps the base system-prompt template and the task-agent role prefix in the
 * registry domain so profile contributions living in higher domains (`plan`,
 * `agentLifecycle`) can reuse them without upward imports.
 *
 * All system-prompt rendering — the builtin template, `SYSTEM.md`, and agent
 * files — shares one `${var}` substitution pass over one variable table
 * ({@link systemPromptVars}); unknown placeholders stay verbatim. Conditional
 * sections (Windows notes, additional directories, skills) are composed here
 * as pre-rendered blocks because the renderer has no conditional syntax. Raw
 * context fields render as empty strings when missing and the composed
 * `*_section` / `windows_notes` blocks are empty unless their content exists,
 * so templates can place them on their own line without leaving stray
 * headings behind. `renderPromptTemplate` renders a user-owned template (an
 * agent-file body or `SYSTEM.md`) against the table; `${base_prompt}` is
 * bound to the default profile's prompt when a `basePrompt` is given,
 * resolved lazily and only when the template actually references it. Also
 * shared: `skillActiveFor` (whether the Skill tool survives a profile's tool
 * list — drives skills injection) and the `subagents`-allowlist helpers
 * (`subagentAllowlistFor`, `subagentTypeNotAllowedMessage`).
 */

import { renderPrompt } from '#/_base/utils/render-prompt';

import type { AgentProfile, AgentProfileContext } from './agentProfileCatalog';

import SYSTEM_PROMPT_TEMPLATE from './system.md?raw';

export const TASK_AGENT_ROLE_PREFIX =
  'You are now running as a subagent. All the `user` messages are sent by the main agent. ' +
  'The main agent cannot see your context, it can only see your last message when you finish the task. ' +
  'You must treat the parent agent as your caller. Do not directly ask the end user questions. ' +
  'If something is unclear, explain the ambiguity in your final summary to the parent agent.';

export function skillActiveFor(tools: readonly string[]): boolean {
  return tools.includes('Skill');
}

export function subagentAllowlistFor(
  catalog: {
    getDefault(): Pick<AgentProfile, 'subagents'>;
  },
  caller: {
    readonly profileName?: string;
    readonly subagents?: readonly string[];
  },
): readonly string[] | undefined {
  return caller.profileName === undefined ? catalog.getDefault().subagents : caller.subagents;
}

export function subagentTypeNotAllowedMessage(
  name: string,
  allowlist: readonly string[],
): string {
  const allowed = allowlist.length === 0 ? 'none' : allowlist.join(', ');
  return `Subagent type "${name}" is not allowed for this agent. Allowed subagent types: ${allowed}.`;
}

const WINDOWS_NOTES =
  'IMPORTANT: You are on Windows. The Bash tool runs through Git Bash, so use Unix shell syntax inside Bash commands — `/dev/null` not `NUL`, and forward slashes in paths. For file operations, always prefer the built-in tools (Read, Write, Edit, Glob, Grep) over Bash commands — they work reliably across all platforms.';

const ADDITIONAL_DIRS_SECTION_PROSE =
  'The following directories have been added to the workspace. You can read, write, search, and glob files in these directories as part of your workspace scope.';

const SKILLS_SECTION_PROSE =
  'Skills are reusable, composable capabilities that enhance your abilities. Each skill is either a self-contained directory with a `SKILL.md` file or a standalone `.md` file that contains instructions, examples, and/or reference material.\n\n' +
  'Identify the skills relevant to your current task and read the skill file for its instructions; only read further skill details when needed, to conserve the context window.\n\n' +
  '## Available skills\n\n' +
  'Skills are grouped by scope (`Project`, `User`, `Extra`, `Built-in`) so you can tell where each came from. When the user refers to "the skill in this project" or "the user-scope skill", use the scope heading to disambiguate. When multiple scopes define a skill with the same name, the more specific scope takes precedence: **Project overrides User overrides Extra overrides Built-in**.';

export function systemPromptVars(
  context: AgentProfileContext,
  options: { readonly skillActive: boolean },
): Record<string, string> {
  const shellName = context.shellName ?? '';
  const shellPath = context.shellPath ?? '';
  const skillActive = context.skillActive ?? options.skillActive;
  const skills = skillActive ? (context.skills ?? '') : '';
  const additionalDirsInfo = context.additionalDirsInfo ?? '';
  return {
    role_additional: '',
    os: context.osKind ?? '',
    windows_notes: context.osKind === 'Windows' ? `\n\n${WINDOWS_NOTES}\n\n` : '',
    shell: shellName.length > 0 ? `${shellName} (\`${shellPath}\`)` : '',
    now: context.now ?? new Date().toISOString(),
    cwd: context.cwd ?? '',
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

export function renderPromptTemplate(
  template: string,
  context: AgentProfileContext,
  options: { readonly skillActive: boolean },
  basePrompt?: (context: AgentProfileContext) => string,
): string {
  const vars = systemPromptVars(context, options);
  if (basePrompt !== undefined && template.includes('${base_prompt}')) {
    vars['base_prompt'] = basePrompt(context);
  }
  return renderPrompt(template, vars);
}

export function renderSystemPrompt(
  roleAdditional: string,
  context: AgentProfileContext,
  options: { readonly skillActive: boolean },
): string {
  return renderPrompt(SYSTEM_PROMPT_TEMPLATE, {
    ...systemPromptVars(context, options),
    role_additional: roleAdditional,
  });
}
