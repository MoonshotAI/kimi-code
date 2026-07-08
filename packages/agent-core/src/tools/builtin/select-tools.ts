/**
 * select_tools — the load-by-exact-name primitive of progressive tool
 * disclosure. MCP tool schemas stay out of the immutable top-level `tools[]`;
 * the model reads the `<tools_added>/<tools_removed>` announcements, calls
 * this tool with exact names, and the full definitions are appended to the
 * conversation as a `role: 'system'` message carrying `tools` (the
 * `messages[].tools` wire contract). Loaded tools become executable the very
 * next step: the loop re-reads the executable tool table per step.
 *
 * Registered only when `agent.toolSelectEnabled` (capability × flag gate) and
 * deliberately NOT main-agent-only — subagents get the same disclosure.
 *
 * Concurrency: no `accesses` is declared, so the execution defaults to
 * `ToolAccesses.all()` and is serialized against every other tool in the same
 * batch. That is a design constraint, not an accident — two select_tools
 * calls settling concurrently could double-inject the same schema message.
 */

import { z } from 'zod';

import type { Agent } from '#/agent';
import { DYNAMIC_TOOL_SCHEMA_VARIANT } from '../../agent/context/dynamic-tools';
import type { BuiltinTool } from '../../agent/tool/types';
import type { ToolExecution } from '../../loop/types';
import { toInputJsonSchema } from '../support/input-schema';

export const SELECT_TOOLS_TOOL_NAME = 'select_tools';

export const SelectToolsInputSchema = z
  .object({
    names: z
      .array(z.string())
      .min(1)
      .describe('Exact tool names to load, taken from the latest announced tool list.'),
  })
  .strict();

export type SelectToolsInput = z.infer<typeof SelectToolsInputSchema>;

// The description sits inside the immutable top-level tools[] — it must stay
// byte-stable across the session. Anything that varies with the tool set
// (names, counts) belongs in the announcements, never here.
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

  constructor(private readonly agent: Agent) {}

  resolveExecution(args: SelectToolsInput): ToolExecution {
    return {
      description: `Loading ${args.names.join(', ')}`,
      approvalRule: this.name,
      execute: async () => {
        // The tool is registered unconditionally (the flag can flip at
        // runtime without a builtin refresh) but only offered while the
        // disclosure gate is open; guard the tiny window where the gate
        // closed between table build and execution.
        if (!this.agent.toolSelectEnabled) {
          return {
            output: 'select_tools is not available for the current model.',
            isError: true,
          };
        }
        const manager = this.agent.tools;
        const loadable = new Set(manager.loadableDynamicToolNames());
        const loaded = manager.loadedDynamicToolNames();

        // Mixed input settles per name: hits load, known-loaded report, and
        // unknowns error individually — never all-or-nothing, so the model
        // does not re-request the whole batch over one typo.
        const toLoad: string[] = [];
        const alreadyAvailable: string[] = [];
        const unknown: string[] = [];
        for (const name of new Set(args.names)) {
          if (loaded.has(name)) {
            alreadyAvailable.push(name);
          } else if (loadable.has(name)) {
            toLoad.push(name);
          } else {
            unknown.push(name);
          }
        }

        if (toLoad.length > 0) {
          // Schemas are read from the live registry at injection time and
          // sorted by name for byte-stable output. History is never used as a
          // schema source; an already-loaded name whose registry schema has
          // since changed is NOT re-injected (no runtime last-wins reliance) —
          // the stale copy lasts at most until the next compaction discards
          // the loaded set, after which a re-select injects the new schema.
          toLoad.sort((a, b) => a.localeCompare(b));
          const tools = toLoad
            .map((name) => manager.getMcpToolSchema(name))
            .filter((tool): tool is NonNullable<typeof tool> => tool !== undefined);
          this.agent.context.appendMessage({
            role: 'system',
            content: [],
            toolCalls: [],
            tools,
            origin: { kind: 'injection', variant: DYNAMIC_TOOL_SCHEMA_VARIANT },
          });
          // The schema message may sit in the deferred queue until this tool
          // exchange closes; the pending mark keeps the ledger ahead of the
          // history inside that window so a same-step re-select is a no-op.
          manager.markDynamicToolsLoaded(toLoad);
        }

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
