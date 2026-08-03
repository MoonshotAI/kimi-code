/**
 * `sessionInit` domain (L6) — `/init` brief and completion reminder.
 *
 * Verbatim brief handed to the `coder` subagent that generates `AGENTS.md`
 * (`DEFAULT_INIT_PROMPT`), and the system reminder appended to the main agent
 * once `/init` finishes (`initCompletionReminder`), which carries the freshly
 * loaded AGENTS.md content back into the main conversation. Pure
 * constants/functions — no scoped state.
 *
 * Port of v1 `packages/agent-core/src/profile/default/init.md`
 * (`DEFAULT_INIT_PROMPT`) and the `initCompletionReminder` helper in
 * `packages/agent-core/src/session/index.ts`.
 */

import initMd from './init.md?raw';

export const DEFAULT_INIT_PROMPT = initMd;

export function initCompletionReminder(agentsMd: string): string {
  const latest =
    agentsMd.trim().length === 0
      ? 'No AGENTS.md content was found after `/init` completed.'
      : agentsMd;
  return [
    'The user just ran `/init` slash command.',
    'The system has analyzed the codebase and generated an `AGENTS.md` file.',
    '',
    'Latest AGENTS.md file content:',
    latest,
  ].join('\n');
}
