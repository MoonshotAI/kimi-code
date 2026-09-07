import { createUserMessage } from '#/llm/message';
import type { Plugin } from '#/plugin';

import type { ToolSelectState } from './state';
import { createSelectToolsTool } from './tool';

export const LOADABLE_TOOLS_REMINDER_KEY = 'loadable-tools';
export const DYNAMIC_TOOL_SCHEMA_REMINDER_KEY = 'dynamic-tool-schemas';

export interface ToolSelectPlugin extends Plugin {
  readonly name: 'tool-select';
}

export function createToolSelectPlugin(state: ToolSelectState): ToolSelectPlugin {
  return {
    name: 'tool-select',
    tools: () => [createSelectToolsTool(state)],
    connect(target) {
      if (target.kind !== 'agent') return;
      target.on('turn.start', (event) => {
        if (event.type !== 'turn.start') return;
        if (!state.enabled()) return;
        const announcement = state.announcement();
        if (announcement === undefined) return;
        target.remind(LOADABLE_TOOLS_REMINDER_KEY, createUserMessage(announcement));
      });
      const pushSchemas = () => {
        if (!state.enabled()) return;
        const tools = state.pendingSchemas();
        if (tools.length === 0) return;
        target.remind(DYNAMIC_TOOL_SCHEMA_REMINDER_KEY, { role: 'system', content: [], tools });
      };
      target.on('tool.done', pushSchemas);
      target.on('tool.failed', pushSchemas);
      target.on('turn.remindersConsumed', (event) => {
        if (event.type !== 'turn.remindersConsumed') return;
        for (const entry of event.reminders) {
          if (entry.meta.key === LOADABLE_TOOLS_REMINDER_KEY) state.markAnnounced();
          if (entry.meta.key === DYNAMIC_TOOL_SCHEMA_REMINDER_KEY) state.markSchemasLanded();
        }
      });
      target.on('context.reset', () => {
        state.reset();
      });
    },
  };
}
