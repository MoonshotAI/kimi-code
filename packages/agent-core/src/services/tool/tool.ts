/**
 * `IToolService` — daemon-facing read-only tool surface.
 *
 * Translates agent-core's `ToolInfo` (camelCase, includes `'user'` source
 * literal) into SCHEMAS §8 `ToolDescriptor` (snake_case, `'skill'` literal).
 * Adapter helpers (`toProtocolTool`, `AgentCoreToolInfoLike`) are co-located here.
 *
 * **REST.md §3.8 ?session_id behavior**: tool listing is session-scoped.
 * Missing session runtime is a migration TODO rather than an RPC fallback.
 *
 * **Anti-corruption**: imports `@moonshot-ai/agent-core` only for the
 * `createDecorator` value.
 */

import { createDecorator } from '../../di';
import type { ToolDescriptor, ToolSource } from '@moonshot-ai/protocol';

// ---------------------------------------------------------------------------
// Adapter helpers (tool side of former adapter/tool-adapter.ts)
// ---------------------------------------------------------------------------

/**
 * In-process minimal shape we accept for tool conversion. Mirrors
 * `@moonshot-ai/agent-core` `ToolInfo` without taking a runtime dependency on
 * its exact shape (the adapter is the boundary).
 */
export interface AgentCoreToolInfoLike {
  readonly name: string;
  readonly description: string;
  readonly source: 'builtin' | 'user' | 'mcp';
  /** agent-core may add fields like `active`; we ignore them. */
  readonly active?: boolean;
}

function mapToolSource(s: AgentCoreToolInfoLike['source']): ToolSource {
  switch (s) {
    case 'builtin':
      return 'builtin';
    case 'user':
      return 'skill';
    case 'mcp':
      return 'mcp';
  }
}

/**
 * Parse the server id segment from an MCP tool name. Current agent-core names
 * use `mcp__<server>__<tool>`.
 */
function parseMcpServerIdFromToolName(name: string): string | undefined {
  if (!name.startsWith('mcp__')) return undefined;
  const rest = name.slice('mcp__'.length);
  const sep = rest.indexOf('__');
  if (sep <= 0) return undefined;
  return rest.slice(0, sep);
}

export function toProtocolTool(info: AgentCoreToolInfoLike): ToolDescriptor {
  const source = mapToolSource(info.source);
  const base: ToolDescriptor = {
    name: info.name,
    description: info.description,
    // agent-core's ToolInfo lacks a JSON schema today; emit null so the
    // wire schema is honest about "unknown".
    input_schema: null,
    source,
  };
  if (source === 'mcp') {
    const serverId = parseMcpServerIdFromToolName(info.name);
    if (serverId !== undefined) {
      return { ...base, mcp_server_id: serverId };
    }
  }
  return base;
}

// ---------------------------------------------------------------------------
// Interface + implementation
// ---------------------------------------------------------------------------

export interface IToolService {
  readonly _serviceBrand: undefined;

  /**
   * Return the available tool descriptors. When `sessionId` is supplied, the
   * impl returns the session-effective subset from the agent runtime.
   */
  list(sessionId?: string): Promise<readonly ToolDescriptor[]>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IToolService = createDecorator<IToolService>('toolService');

void IToolService;
