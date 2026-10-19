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
  'If you have not seen a <tools_added> announcement in this session, no tools are currently loadable — do not call select_tools. ' +
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
        const {
          toLoad,
          alreadyAvailable,
          alreadyCallable,
          staleLoaded,
          policyDenied,
          unknown,
          escalated,
          consecutiveFailures,
          suggestions,
          loadable,
        } = this.toolSelect.load(args.names);

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
        for (const name of staleLoaded) {
          lines.push(
            `"${name}" was previously selected or loaded but is no longer registered. ` +
              'select_tools cannot restore it. Do not select it again unless a new ' +
              '<tools_added> announcement lists it.',
          );
        }
        for (const name of policyDenied) {
          lines.push(
            `"${name}" is disabled by the current tool policy. select_tools cannot enable it. ` +
              'Do not retry unless the policy changes; use an available tool instead.',
          );
        }
        for (const name of unknown) {
          const reason =
            `Unknown tool: ${name}. This name is not in the current loadable tool list. ` +
            'select_tools only loads exact announced names; it cannot search for capabilities or install tools. ';
          const candidates = suggestions[name];
          if (candidates !== undefined && candidates.length > 0) {
            lines.push(`${reason}Did you mean: ${candidates.join(', ')}? Use an exact listed name.`);
          } else {
            const available = loadable.length === 0
              ? 'No additional tools can be loaded right now; use the tools you already have.'
              : loadable.length <= 5
                ? `Loadable tools: ${loadable.join(', ')}.`
                : 'Select only exact names from the current announcements.';
            lines.push(
              `${reason}${available} Do not guess aliases; use an available tool ` +
                'or tell the user what capability is missing.',
            );
          }
        }
        for (const [name, attempts] of Object.entries(escalated)) {
          lines.push(
            `"${name}" has already failed selection ${attempts} times. ` +
              'Stop retrying this name until its availability changes.',
          );
        }
        if (consecutiveFailures >= 3) {
          lines.push(
            `${consecutiveFailures} consecutive select_tools calls failed without making any tool available. ` +
              'Stop guessing names or retrying unavailable tools. Use only exact names from the current ' +
              'announcements, use tools already available, or tell the user what capability is missing.',
          );
        }
        const isError =
          toLoad.length === 0 && alreadyAvailable.length === 0 && alreadyCallable.length === 0;
        return isError ? { output: lines.join('\n'), isError } : { output: lines.join('\n') };
      },
    };
  }
}

registerAgentToolService(ISelectToolsTool, SelectToolsTool, { name: SELECT_TOOLS_TOOL_NAME, domain: 'toolSelect' });
