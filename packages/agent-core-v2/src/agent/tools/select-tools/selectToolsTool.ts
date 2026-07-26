/**
 * `tools` domain (L7) — `SelectToolsTool` implementation (the `select_tools`
 * tool).
 *
 * The built-in tool that lets the model load dynamic schemas named in
 * loadable-tools announcements. Delegates loading to
 * `IAgentToolSelectService` (`toolSelect` domain); offered by the shaped tool
 * view only while the disclosure gate is open. The public contract (input
 * schema, `ISelectToolsTool`) lives in `./select-tools`.
 *
 * Registered via the module-level `registerAgentToolService(ISelectToolsTool,
 * SelectToolsTool)` at the bottom of this file — the same "import = register"
 * pattern used by every agent tool. Bound at Agent scope.
 */

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
  'All available tool names are listed in the <tools_added>/<tools_removed> announcements ' +
  'in the system context — fold them in order to get the current list. ' +
  'Pass the exact name(s) you need; their full definitions become available immediately, ' +
  'so you can call them directly in your next tool call.';

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

registerAgentToolService(ISelectToolsTool, SelectToolsTool, { name: SELECT_TOOLS_TOOL_NAME, domain: 'toolSelect' });
