import { defineTool, type ToolDefinition } from '#/tool/tool';

import { SELECT_TOOLS_TOOL_NAME, type ToolSelectState } from './state';

const DESCRIPTION =
  'Load one or more tools by name so you can call them. ' +
  'All available tool names are listed in the <tools_added>/<tools_removed> announcements ' +
  'in the system context — fold them in order to get the current list. ' +
  'Pass the exact name(s) you need; their full definitions become available immediately, ' +
  'so you can call them directly in your next tool call.';

export function createSelectToolsTool(state: ToolSelectState): ToolDefinition {
  return defineTool({
    name: SELECT_TOOLS_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        names: {
          type: 'array',
          description: 'Exact tool names to load, taken from the latest announced tool list.',
          items: { type: 'string' },
          minItems: 1,
        },
      },
      required: ['names'],
      additionalProperties: false,
    },
    async execute({ toolCall }) {
      if (!state.enabled()) {
        return {
          content: [
            { type: 'text', text: 'select_tools is not available for the current model.' },
          ],
          isError: true,
        };
      }
      const args = JSON.parse(toolCall.arguments ?? '{}') as { names?: unknown };
      const names = Array.isArray(args.names)
        ? args.names.filter((name): name is string => typeof name === 'string')
        : [];
      if (names.length === 0) {
        return {
          content: [{ type: 'text', text: 'Provide at least one tool name in names.' }],
          isError: true,
        };
      }
      const { toLoad, alreadyAvailable, unknown } = state.load(names);
      const lines: string[] = [];
      if (toLoad.length > 0) lines.push(`Loaded: ${toLoad.join(', ')}`);
      if (alreadyAvailable.length > 0) {
        lines.push(`Already available: ${alreadyAvailable.join(', ')}`);
      }
      for (const name of unknown) {
        lines.push(`Unknown tool: ${name}. Pick from the latest announced tools list.`);
      }
      const isError = toLoad.length === 0 && alreadyAvailable.length === 0;
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        isError: isError ? true : undefined,
      };
    },
  });
}

export function deferTool(tool: ToolDefinition, state: ToolSelectState): ToolDefinition {
  return defineTool({
    ...tool,
    deferred: true,
    async execute(input) {
      if (!state.isLoaded(tool.name)) {
        return {
          content: [
            {
              type: 'text',
              text:
                `Tool "${tool.name}" is available but not loaded. ` +
                `Call select_tools with ["${tool.name}"] first, then call the tool.`,
            },
          ],
          isError: true,
        };
      }
      return tool.execute(input);
    },
  });
}
