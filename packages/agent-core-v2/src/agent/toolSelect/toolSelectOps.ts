/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { AgentEvent2 } from '#/app/event/event2';
import { defineState } from '#/state/state';
import type { ToolDisclosure, ToolSource } from '#/tool/toolContract';

export interface ToolSelectTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly source: ToolSource;
  readonly disclosure?: ToolDisclosure;
  readonly origin: 'initial' | 'runtime';
}

export interface ToolSelectChange {
  readonly added: readonly ToolSelectTool[];
  readonly removed: readonly ToolSelectTool[];
}

export interface ToolSelectModelState {
  readonly initial: readonly ToolSelectTool[] | undefined;
  readonly current: readonly ToolSelectTool[];
  readonly changes: readonly ToolSelectChange[];
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]),
  );
}

export function toolSelectSchemaSignature(
  tool: Pick<ToolSelectTool, 'name' | 'description' | 'parameters'>,
): string {
  return JSON.stringify([tool.name, tool.description, canonicalValue(tool.parameters)]);
}

export function toolSelectVersionSignature(tool: ToolSelectTool): string {
  return JSON.stringify([toolSelectSchemaSignature(tool), tool.source, tool.disclosure]);
}

const toolSchema = z.custom<ToolSelectTool>();

const toolSelectInitializedSchema = z.object({
  agentId: z.string(),
  tools: z.array(toolSchema).readonly(),
});

export class ToolSelectInitialized extends AgentEvent2<z.infer<typeof toolSelectInitializedSchema>> {
  static override readonly type = 'tool_select.initialized';
  static override readonly durable = true;
  static override readonly schema = toolSelectInitializedSchema;
}
export interface ToolSelectInitialized {
  readonly agentId: string;
  readonly tools: readonly ToolSelectTool[];
}

const toolSelectToolsChangedSchema = z.object({
  agentId: z.string(),
  added: z.array(toolSchema).readonly(),
  removed: z.array(toolSchema).readonly(),
});

export class ToolSelectToolsChanged extends AgentEvent2<z.infer<typeof toolSelectToolsChangedSchema>> {
  static override readonly type = 'tool_select.tools_changed';
  static override readonly durable = true;
  static override readonly schema = toolSelectToolsChangedSchema;
}
export interface ToolSelectToolsChanged {
  readonly agentId: string;
  readonly added: readonly ToolSelectTool[];
  readonly removed: readonly ToolSelectTool[];
}

function byName(left: ToolSelectTool, right: ToolSelectTool): number {
  return left.name.localeCompare(right.name);
}

export const toolSelectKey = defineState('toolSelect', (): ToolSelectModelState => ({
  initial: undefined,
  current: [],
  changes: [],
})).replayable({ schema: z.custom<ToolSelectModelState>() })
  .on(ToolSelectInitialized, (s, e) => {
    if (s.initial !== undefined) return;
    s.initial = e.tools.map((tool) => ({ ...tool }));
    s.current = e.tools.map((tool) => ({ ...tool }));
  })
  .on(ToolSelectToolsChanged, (s, e) => {
    const removed = new Set(e.removed.map((tool) => tool.name));
    s.current = [
      ...s.current.filter((tool) => !removed.has(tool.name)),
      ...e.added,
    ].toSorted(byName);
    s.changes.push({
      added: e.added.map((tool) => ({ ...tool })),
      removed: e.removed.map((tool) => ({ ...tool })),
    });
  });
