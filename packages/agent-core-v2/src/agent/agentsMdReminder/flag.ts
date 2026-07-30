/**
 * `agentsMdReminder` domain — registers the `agents-md-reminder` experimental
 * flag into `flag`.
 *
 * Gates the discovery reminder: the `onDidExecuteTool` hook is always
 * registered and checks this flag per tool call, so runtime config overrides
 * take effect without reconstructing the agent. Off by default; enable via
 * `KIMI_CODE_EXPERIMENTAL_AGENTS_MD_REMINDER`, the master
 * `KIMI_CODE_EXPERIMENTAL_FLAG`, or the `[experimental]` config section.
 * Imported for its side effect (registers the definition) from the package
 * barrel.
 */

import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const AGENTS_MD_REMINDER_FLAG_ID = 'agents-md-reminder';
export const AGENTS_MD_REMINDER_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_AGENTS_MD_REMINDER';

export const agentsMdReminderFlag: FlagDefinitionInput = {
  id: AGENTS_MD_REMINDER_FLAG_ID,
  title: 'AGENTS.md discovery reminder',
  description:
    'When a tool call touches a directory whose AGENTS.md was not part of the injected instructions, append a system reminder to the tool result suggesting the model read it (at most once per file per agent).',
  env: AGENTS_MD_REMINDER_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(agentsMdReminderFlag);
