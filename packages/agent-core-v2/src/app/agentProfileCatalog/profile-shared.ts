/**
 * `agentProfileCatalog` domain (L3) — shared prompt helpers for builtin profiles.
 *
 * Keeps the base system-prompt template and the task-agent role prefix in the
 * registry domain so profile contributions living in higher domains (`plan`,
 * `agentLifecycle`) can reuse them without upward imports.
 *
 * All system-prompt rendering — the builtin template, `SYSTEM.md`, and agent
 * files — shares one `${var}` substitution pass over one variable table
 * ({@link systemPromptVars}); unknown placeholders stay verbatim. Workspace
 * payloads and the dynamic timestamp are *not* system vars: they ship as
 * request-time user fragments via {@link buildBaselineContextMessages}.
 * Conditional sections (Windows notes) are composed here as pre-rendered
 * blocks because the renderer has no conditional syntax. `renderPromptTemplate`
 * renders a user-owned template against the weighted table; `${base_prompt}` is
 * bound to the default profile's prompt when a `basePrompt` is given.
 */

import { renderPrompt } from '#/_base/utils/render-prompt';

import type { AgentProfile, AgentProfileContext } from './agentProfileCatalog';
import {
  buildBaselineContextMessages,
  type BaselineContextInput,
} from './baseline-context';

import SYSTEM_PROMPT_TEMPLATE from './system.md?raw';

export { buildBaselineContextMessages, type BaselineContextInput };

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

export function systemPromptVars(
  context: AgentProfileContext,
  _options: { readonly skillActive: boolean },
): Record<string, string> {
  const shellName = context.shellName ?? '';
  const shellPath = context.shellPath ?? '';
  // Workspace payloads and dynamic timestamp live in request-time baseline
  // user fragments (buildBaselineContextMessages). Keep placeholders empty
  // so custom agent-file templates cannot re-inject them into the trusted
  // system channel.
  return {
    role_additional: '',
    os: context.osKind ?? '',
    windows_notes: context.osKind === 'Windows' ? `\n\n${WINDOWS_NOTES}\n\n` : '',
    shell: shellName.length > 0 ? `${shellName} (\`${shellPath}\`)` : '',
    now: '',
    cwd: context.cwd ?? '',
    cwd_listing: '',
    agents_md: '',
    additional_dirs_info: '',
    additional_dirs_section: '',
    skills: '',
    skills_section: '',
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

export function baselineMessagesForContext(
  context: AgentProfileContext,
  options: { readonly skillActive: boolean },
): ReturnType<typeof buildBaselineContextMessages> {
  const skillActive = context.skillActive ?? options.skillActive;
  const input: BaselineContextInput = {
    now: context.now ?? new Date().toISOString(),
    cwdListing: context.cwdListing,
    agentsMd: context.agentsMd,
    additionalDirsInfo: context.additionalDirsInfo,
    skills: context.skills,
    includeSkills: skillActive,
  };
  return buildBaselineContextMessages(input);
}
