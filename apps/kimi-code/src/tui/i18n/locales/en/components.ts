/**
 * English translations for UI components.
 *
 * One namespace object per component module. Keys follow the
 * `components.<component>.<phrase>` convention used by `i18n.t(...)`. Keep keys
 * stable — they are the contributor-facing contract shared with every locale.
 */

import type { MessageTree } from '../../i18n';

export const components: MessageTree = {
  welcome: {
    title: 'Welcome to Kimi Code!',
    getStarted: 'Run /login or /provider to get started.',
    helpHint: 'Send /help for help information.',
    modelNotSet: 'not set, run /login or /provider',
    labels: {
      directory: 'Directory',
      session: 'Session',
      model: 'Model',
      version: 'Version',
      mcp: 'MCP',
    },
  },
  footer: {
    context: 'context',
    thinking: 'thinking',
    taskRunning: '{count} task running',
    tasksRunning: '{count} tasks running',
    agentRunning: '{count} agent running',
    agentsRunning: '{count} agents running',
  },
  usage: {
    panelTitle: ' Usage ',
    sessionUsage: 'Session usage',
    noTokenUsage: 'No token usage recorded yet.',
    input: 'input',
    output: 'output',
    total: 'total',
    contextWindow: 'Context window',
    planUsage: 'Plan usage',
    noUsageData: 'No usage data available.',
    percentUsed: '{pct}% used',
  },
  status: {
    panelTitle: ' Status ',
    noContextData: 'No context window data available.',
    fields: {
      model: 'Model',
      directory: 'Directory',
      permissions: 'Permissions',
      planMode: 'Plan mode',
      session: 'Session',
      title: 'Title',
      warning: 'Warning',
    },
    values: {
      notSet: 'not set',
      none: 'none',
      on: 'on',
      off: 'off',
      thinking: 'thinking',
    },
  },
};
