import { toInputJsonSchema } from '#/tool/input-schema';
import type { ToolExecution } from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { IAgentToolSelectService, SELECT_TOOLS_TOOL_NAME } from '#/agent/toolSelect/toolSelect';

import {
  ISelectToolsTool,
  SelectToolsInputSchema,
  type SelectToolsInput,
} from './select-tools';

const DESCRIPTION =
  'Load one or more tools by name so you can call them. ' +
  'The loadable names are listed in the <tools_added>/<tools_removed> announcements ' +
  'in the system context — fold them in order to get the current list. ' +
  'Pass the exact tool name(s) you need — plugin, skill, or category names do not work. ' +
  'The full definitions become available immediately, so you can call them directly ' +
  'in your next tool call. ' +
  'Only announced names are loadable — tools you already have available are called ' +
  'directly, never passed to select_tools.';

export class SelectToolsTool implements ISelectToolsTool {
  declare readonly _serviceBrand: undefined;
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
        const { toLoad, alreadyAvailable, alreadyCallable, unknown, suggestions, loadable } =
          this.toolSelect.load(args.names);

        const lines: string[] = [];
        if (toLoad.length > 0) lines.push(`Loaded: ${toLoad.join(', ')}`);
        if (alreadyAvailable.length > 0) {
          lines.push(`Already available: ${alreadyAvailable.join(', ')}`);
        }
        for (const name of alreadyCallable) {
          lines.push(
            `"${name}" is already available — call it directly; ` +
              'select_tools is only for names in the <tools_added> announcements.',
          );
        }
        for (const name of unknown) {
          const candidates = suggestions[name];
          if (candidates !== undefined && candidates.length > 0) {
            lines.push(`Unknown tool: ${name}. Did you mean: ${candidates.join(', ')}?`);
          } else if (loadable.length === 0) {
            lines.push(
              `Unknown tool: ${name}. No tools can be loaded in this session — ` +
                'use the tools you already have.',
            );
          } else if (loadable.length <= 5) {
            lines.push(`Unknown tool: ${name}. Loadable tools: ${loadable.join(', ')}.`);
          } else {
            lines.push(`Unknown tool: ${name}. Pick from the latest announced tools list.`);
          }
        }
        const isError =
          toLoad.length === 0 && alreadyAvailable.length === 0 && alreadyCallable.length === 0;
        return isError ? { output: lines.join('\n'), isError } : { output: lines.join('\n') };
      },
    };
  }
}

registerAgentToolService(ISelectToolsTool, SelectToolsTool, { name: SELECT_TOOLS_TOOL_NAME, domain: 'toolSelect' });
