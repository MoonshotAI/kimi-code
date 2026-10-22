import type { PluginMutation } from '../types';

export const PLUGIN_CHANGE_REMIND_KEY = 'plugin-change';

const PLUGIN_CHANGE_VERBS: Record<PluginMutation['kind'], string> = {
  install: 'installed',
  enable: 'enabled',
  disable: 'disabled',
  remove: 'removed',
  'mcp-server': 'updated',
};

export function renderPluginChangeReminder(mutation: PluginMutation): string {
  return (
    `Plugin "${mutation.id}" was ${PLUGIN_CHANGE_VERBS[mutation.kind]}. ` +
    'This session keeps the prompt and tools it started with; ' +
    'run /new or /reload to apply the change, and tell the user if they expect it now.'
  );
}
