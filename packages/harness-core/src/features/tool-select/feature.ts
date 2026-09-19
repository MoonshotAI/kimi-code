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
      if (!state.enabled()) {
        useAgentTools(...options.loadable());
        return;
      }
      useAgentTools(
        createSelectToolsTool(state),
        ...options.loadable().map((tool) => deferTool(tool, state)),
      );
      useMessageResolver(createToolSelectMessageResolver(state));
      let announcementInFlight = false;
      let schemaFlight: string[] | undefined;
      agent.on('turn.started', () => {
        if (!state.enabled() || announcementInFlight) return;
        const announcement = state.announcement();
        if (announcement === undefined) return;
        announcementInFlight = true;
        agent.remind(createUserMessage(announcement), { key: LOADABLE_TOOLS_REMINDER_KEY });
      });
      const pushSchemas = (): void => {
        if (!state.enabled() || schemaFlight !== undefined) return;
        const tools = state.pendingSchemas();
        if (tools.length === 0) return;
        schemaFlight = tools.map((tool) => tool.name);
        agent.remind({ role: 'system', content: [], tools }, { key: DYNAMIC_TOOL_SCHEMA_REMINDER_KEY });
      };
      agent.on('tool.done', pushSchemas);
      agent.on('turn.drained', (event) => {
        for (const entry of event.messages) {
          if (entry.meta?.source !== 'reminder') continue;
          if (entry.meta.key === LOADABLE_TOOLS_REMINDER_KEY) {
            announcementInFlight = false;
            state.markAnnounced();
          }
          if (entry.meta.key === DYNAMIC_TOOL_SCHEMA_REMINDER_KEY) {
            const landed = schemaFlight ?? [];
            schemaFlight = undefined;
            state.markSchemasLanded(landed);
          }
        }
        pushSchemas();
      });
    },
  });
}
