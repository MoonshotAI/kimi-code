import { z } from 'zod';

import type { ToolResult } from '@moonshot-ai/agent-core/tool/index';

import {
  GitError,
  resolveTowerRepoRoot,
  TowerProtocolError,
  TowerStore,
  type TowerIo,
  type TowerState,
} from '../protocol/index';
import type { TowerHub } from '../hub';
import type { TowerRateLimiter } from '../rateLimit';

export const TOWER_MAIN_AGENT_ONLY =
  'Tower orchestration tools are only supported by the main agent.';

export const TOWER_MODE_USER_ENABLED_ONLY =
  'tower mode is not active — only the user can enable it (with /tower on), never the agent. ' +
  'Ask the user to turn tower mode on, then drive the tower protocol.';

export interface TowerToolDeps {
  readonly io: TowerIo;
  readonly workDir: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly isActive: () => boolean;
  readonly requestedBase: () => string | undefined;
  readonly isSessionLive: (sessionId: string) => boolean;
  readonly rateLimit: TowerRateLimiter;
  readonly hub: TowerHub;
  readonly running: ReadonlySet<string>;
}

export function newTowerStore(deps: Pick<TowerToolDeps, 'io' | 'workDir'>): TowerStore {
  return new TowerStore(resolveTowerRepoRoot(deps.workDir), deps.io);
}

export function callerName(agentId: string, store: TowerStore, state: TowerState): string {
  return store.resolveCallerName(state, agentId);
}

export function text(value: string): ToolResult {
  return { content: [{ type: 'text' as const, text: value }] };
}

export function errorText(value: string): ToolResult {
  return { content: [{ type: 'text' as const, text: value }], isError: true };
}

export async function runTowerTool(execute: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await execute();
  } catch (error) {
    if (error instanceof TowerProtocolError || error instanceof GitError) {
      return errorText(error.message);
    }
    throw error;
  }
}

export function toInputJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema, {
    target: 'draft-7',
    io: 'input',
  });
  closeObjectNodes(jsonSchema);
  return jsonSchema;
}

function closeObjectNodes(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) closeObjectNodes(item);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const node = value as Record<string, unknown>;
  if (node['type'] === 'object' && node['additionalProperties'] === undefined) {
    node['additionalProperties'] = false;
  }
  for (const child of Object.values(node)) {
    closeObjectNodes(child);
  }
}

export function parseTowerArgs<S extends z.ZodType>(
  schema: S,
  raw: string | null,
  toolName: string,
): { readonly args: z.infer<S> } | { readonly parseError: string } {
  let parsed: unknown = {};
  if (raw !== null && raw.trim() !== '') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { parseError: `invalid ${toolName} arguments: ${raw ?? ''}` };
    }
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    return { parseError: `invalid ${toolName} arguments: ${raw ?? ''}` };
  }
  return { args: result.data as z.infer<S> };
}
