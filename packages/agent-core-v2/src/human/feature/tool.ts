import { toValue, watch } from '@vue/reactivity';

import {
  buildStoreHandle,
  createCollection,
  NodeEnrichment,
  pushCleanup,
  type FaceEventMeta,
  type StoreResolution,
  type Token,
  type UnitNode,
  type UnitRecipe,
  type UnitSetup,
} from '#/kernel/index';
import type { ToolExecuteInput, ToolResult } from '#/tool/executor';
import { defineTool, type ToolDefinition } from '#/tool/tool';

export interface ToolMeta {
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export interface ToolBody {
  execute(input: ToolExecuteInput): Promise<ToolResult>;
}

export interface ToolStateEvent {
  readonly type: 'tool.state';
  readonly tool: string;
  readonly agentId?: string;
  readonly sessionId?: string;
  readonly state: Record<string, unknown>;
}

export const ToolDefinitions = createCollection<ToolDefinition>('agent.toolDefinitions');

export interface ToolRecipe<S = any, P = void> extends Omit<UnitRecipe<P>, 'setup'> {
  readonly key: string;
  readonly type?: StoreResolution<S>;
  readonly tool: true;
  readonly toolName: string;
  readonly meta: ToolMeta;
  readonly faceEvent: FaceEventMeta;
  readonly onMount: (recipe: UnitRecipe<any>, node: UnitNode) => void;
  readonly setup: UnitSetup<P>;
}

export function createTool<S extends ToolBody>(
  name: string,
  meta: ToolMeta,
  setup: () => S,
): ToolRecipe<S> {
  const recipe: ToolRecipe<S> = {
    name: `tool:${name}`,
    key: `tool:${name}`,
    tool: true,
    toolName: name,
    meta,
    faceEvent: { type: 'tool.state', payloadKey: 'tool', name },
    onMount: (mounted, node) => {
      bindToolFaceWatchers(name, node);
      const parent = node.parent;
      if (parent === null) {
        return;
      }
      const definition = assembleToolDefinition(mounted as ToolRecipe<any, any>, node);
      const withdrawDefinition = parent.contribute(ToolDefinitions, definition, 0);
      pushCleanup(node, withdrawDefinition);
      const handle = buildStoreHandle(name, node);
      const withdrawHandle = parent.provide(mounted as unknown as Token<unknown>, handle);
      pushCleanup(node, withdrawHandle);
    },
    setup: setup as UnitSetup<void>,
  };
  return recipe;
}

export function isToolRecipe(recipe: unknown): recipe is ToolRecipe<any, any> {
  return (recipe as { tool?: boolean }).tool === true;
}

export function assembleToolDefinition(
  recipe: ToolRecipe<any, any>,
  record: UnitNode,
): ToolDefinition {
  return defineTool({
    name: recipe.toolName,
    description: recipe.meta.description,
    parameters: recipe.meta.parameters,
    execute: (input) => {
      const face = record.setupResult as ToolBody | undefined;
      if (face === undefined || typeof face.execute !== 'function') {
        throw new Error(`tool '${recipe.toolName}' has no execute face`);
      }
      return face.execute(input);
    },
  });
}

function bindToolFaceWatchers(name: string, node: UnitNode): void {
  const face = node.setupResult;
  if (face === null || typeof face !== 'object') {
    return;
  }
  const record = face as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => typeof record[key] !== 'function');
  node.scope.run(() => {
    for (const key of keys) {
      watch(
        () => toValue(record[key]),
        () => {
          node.fire({
            type: 'tool.state',
            tool: name,
            ...resolveEnrichment(node),
            state: nonFunctionFields(record),
          });
          if (node.faceWatchers !== undefined) {
            for (const listener of Array.from(node.faceWatchers)) {
              listener(face);
            }
          }
        },
      );
    }
  });
}

function nonFunctionFields(face: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(face)) {
    if (typeof value !== 'function') {
      out[key] = toValue(value);
    }
  }
  return out;
}

function resolveEnrichment(node: UnitNode): Record<string, unknown> {
  try {
    return node.resolve(NodeEnrichment);
  } catch {
    return {};
  }
}
