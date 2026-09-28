import {
  createFeature,
  createUserMessage,
  useAgent,
  useAgentTools,
  useMessageResolver,
  type FeatureSpec,
} from '@moonshot-ai/agent-core';

import { createToolSelectMessageResolver } from './resolver';
import {
  createToolSelectState,
  type CreateToolSelectStateOptions,
} from './state';
import { createSelectToolsTool, deferTool } from './tool';

export const LOADABLE_TOOLS_REMINDER_KEY = 'loadable-tools';
export const DYNAMIC_TOOL_SCHEMA_REMINDER_KEY = 'dynamic-tool-schemas';

export function createToolSelect(options: CreateToolSelectStateOptions): FeatureSpec {
  return createFeature('tool-select', {
    agent() {
      const state = createToolSelectState(options);
      const agent = useAgent();
      useAgentTools(
        createSelectToolsTool(state),
        ...options.loadable().map((tool) => deferTool(tool, state)),
      );
      useMessageResolver(createToolSelectMessageResolver(state));
      agent.on('turn.started', () => {
        if (!state.enabled()) return;
        const announcement = state.announcement();
        if (announcement === undefined) return;
        agent.remind(LOADABLE_TOOLS_REMINDER_KEY, createUserMessage(announcement));
      });
      const pushSchemas = (): void => {
        if (!state.enabled()) return;
        const tools = state.pendingSchemas();
        if (tools.length === 0) return;
        agent.remind(DYNAMIC_TOOL_SCHEMA_REMINDER_KEY, { role: 'system', content: [], tools });
      };
      agent.on('tool.done', pushSchemas);
      agent.on('tool.failed', pushSchemas);
      agent.on('turn.drained', (event) => {
        for (const entry of event.messages) {
          if (entry.meta?.source !== 'reminder') continue;
          if (entry.meta.key === LOADABLE_TOOLS_REMINDER_KEY) state.markAnnounced();
          if (entry.meta.key === DYNAMIC_TOOL_SCHEMA_REMINDER_KEY) state.markSchemasLanded();
        }
      });
    },
  });
}
