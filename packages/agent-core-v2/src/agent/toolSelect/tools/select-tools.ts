/**
 * `toolSelect` domain (L4) — `select_tools`, the load-by-exact-name primitive
 * of progressive tool disclosure.
 *
 * Registers the built-in tool that lets the model load MCP schemas named in
 * loadable-tools announcements. Delegates loading to
 * `IAgentToolSelectService`; offered by the shaped tool view only while the
 * disclosure gate is open.
 */

import { z } from 'zod';

import { toInputJsonSchema } from '#/tool/input-schema';
import type { BuiltinTool, ToolExecution } from '#/tool/toolContract';
import { registerTool } from '#/agent/toolRegistry/toolContribution';

import { IAgentToolSelectService, SELECT_TOOLS_TOOL_NAME } from '../toolSelect';

export const SelectToolsInputSchema = z
  .object({
    names: z
      .array(z.string())
      .min(1)
      .describe('Exact tool names to load, taken from the latest announced tool list.'),
  })
  .strict();

export type SelectToolsInput = z.infer<typeof SelectToolsInputSchema>;

const DESCRIPTION =
  'Load one or more tools by name so you can call them. ' +
  'All available tool names are listed in the <tools_added>/<tools_removed> announcements ' +
  'in the system context — fold them in order to get the current list. ' +
  'Pass the exact name(s) you need; their full definitions become available immediately, ' +
  'so you can call them directly in your next tool call.';

export class SelectToolsTool implements BuiltinTool<SelectToolsInput> {
  readonly name = SELECT_TOOLS_TOOL_NAME;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SelectToolsInputSchema);

  constructor(
    @IAgentToolSelectService private readonly toolSelect: IAgentToolSelectService,
  ) {}

  resolveExecution(args: SelectToolsInput): ToolExecution {
    return {
      description: `Loading ${args.names.join(', ')}`,
      approvalRule: this.name,
      execute: async () => {
        if (!this.toolSelect.enabled()) {
          return {
            output: 'select_tools is not available for the current model.',
            isError: true,
          };
        }
        const { toLoad, alreadyAvailable, unknown } = this.toolSelect.load(args.names);

        const lines: string[] = [];
        if (toLoad.length > 0) lines.push(`Loaded: ${toLoad.join(', ')}`);
        if (alreadyAvailable.length > 0) {
          lines.push(`Already available: ${alreadyAvailable.join(', ')}`);
        }
        for (const name of unknown) {
          lines.push(`Unknown tool: ${name}. Pick from the latest announced tools list.`);
        }
        const isError = toLoad.length === 0 && alreadyAvailable.length === 0;
        return isError ? { output: lines.join('\n'), isError } : { output: lines.join('\n') };
      },
    };
  }
}

registerTool(SelectToolsTool);
