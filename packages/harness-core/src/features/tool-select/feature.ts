import { createFeature, useAgent, type Feature } from '@moonshot-ai/agent-core/app/index';
import { createUserMessage } from '@moonshot-ai/agent-core/llm/message';
import type { Agent } from '@moonshot-ai/agent-core/session/index';

import { useAgentTools, useLoopEvent, useMessageResolver } from '#/runtime/index';

import { createToolSelectMessageResolver } from './resolver';
import {
  createToolSelectState,
  type CreateToolSelectStateOptions,
  type ToolSelectState,
} from './state';
import { createSelectToolsTool, deferTool } from './tool';

export const LOADABLE_TOOLS_REMINDER_KEY = 'loadable-tools';
export const DYNAMIC_TOOL_SCHEMA_REMINDER_KEY = 'dynamic-tool-schemas';

export function createToolSelect(options: CreateToolSelectStateOptions): Feature<void> {
  const states = new WeakMap<Agent, ToolSelectState>();
  return createFeature('tool-select', {
    agent() {
      const agent = useAgent();
      const memoized = states.get(agent);
      const state = memoized ?? createToolSelectState(options);
      if (memoized === undefined) states.set(agent, state);
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
      useLoopEvent('turn.started', () => {
        if (!state.enabled() || announcementInFlight) return;
        const announcement = state.announcement();
        if (announcement === undefined) return;
        announcementInFlight = true;
        queueMicrotask(() => {
          agent.loop.remind({
            message: createUserMessage(announcement),
            meta: { key: LOADABLE_TOOLS_REMINDER_KEY },
          });
        });
      });
      const pushSchemas = (): void => {
        if (!state.enabled() || schemaFlight !== undefined) return;
        const tools = state.pendingSchemas();
        if (tools.length === 0) return;
        schemaFlight = tools.map((tool) => tool.name);
        queueMicrotask(() => {
          agent.loop.remind({
            message: { role: 'system', content: [], tools },
            meta: { key: DYNAMIC_TOOL_SCHEMA_REMINDER_KEY },
          });
        });
      };
      useLoopEvent('tool.ended', pushSchemas);
      useLoopEvent('tool.async_ended', pushSchemas);
      useLoopEvent('message.appended', (event) => {
        if (event.source !== 'remind') return;
        if (event.entry.meta?.key === LOADABLE_TOOLS_REMINDER_KEY) {
          announcementInFlight = false;
          state.markAnnounced();
        }
        if (event.entry.meta?.key === DYNAMIC_TOOL_SCHEMA_REMINDER_KEY) {
          schemaFlight = undefined;
          const landed =
            event.entry.message.role === 'system'
              ? (event.entry.message.tools ?? []).map((tool) => tool.name)
              : [];
          state.markSchemasLanded(landed);
        }
        pushSchemas();
      });
    },
  });
}
