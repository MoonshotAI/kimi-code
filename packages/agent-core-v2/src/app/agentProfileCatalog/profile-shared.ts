/**
 * `agentProfileCatalog` domain (L3) — shared prompt helpers for builtin profiles.
 *
 * Keeps the base system-prompt template and the task-agent role prefix in the
 * registry domain so profile contributions living in higher domains (`plan`,
 * `agentLifecycle`) can reuse them without upward imports.
 */

import { renderPrompt } from '#/_base/utils/render-prompt';

import type { AgentProfileContext } from './agentProfileCatalog';

import SYSTEM_PROMPT_TEMPLATE from './system.md?raw';

export const TASK_AGENT_ROLE_PREFIX =
  'You are now running as a subagent. All the `user` messages are sent by the main agent. ' +
  'The main agent cannot see your context, it can only see your last message when you finish the task. ' +
  'You must treat the parent agent as your caller. Do not directly ask the end user questions. ' +
  'If something is unclear, explain the ambiguity in your final summary to the parent agent.';

export function renderSystemPrompt(roleAdditional: string, context: AgentProfileContext): string {
  const shellName = context.shellName ?? '';
  const shellPath = context.shellPath ?? '';
  return renderPrompt(SYSTEM_PROMPT_TEMPLATE, {
    ROLE_ADDITIONAL: roleAdditional,
    KIMI_OS: context.osKind ?? '',
    KIMI_SHELL: shellName.length > 0 ? `${shellName} (\`${shellPath}\`)` : '',
    KIMI_NOW: context.now ?? new Date().toISOString(),
    KIMI_WORK_DIR: context.cwd ?? '',
    KIMI_WORK_DIR_LS: context.cwdListing ?? '',
    KIMI_AGENTS_MD: context.agentsMd ?? '',
    KIMI_ADDITIONAL_DIRS_INFO: context.additionalDirsInfo ?? '',
    KIMI_SKILLS: context.skills ?? '',
  });
}
