/**
 * English translations for UI components.
 *
 * One namespace object per component module. Keys follow the
 * `components.<component>.<phrase>` convention used by `i18n.t(...)`. Keep keys
 * stable — they are the contributor-facing contract shared with every locale.
 */

import type { MessageTree } from '../../i18n';

export const components: MessageTree = {
  footer: {
    context: 'context',
    thinking: 'thinking',
    taskRunning: '{count} task running',
    tasksRunning: '{count} tasks running',
    agentRunning: '{count} agent running',
    agentsRunning: '{count} agents running',
  },
};
