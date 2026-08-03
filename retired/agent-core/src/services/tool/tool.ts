/**
 * `IToolService` — daemon-facing read-only tool surface.
 *
 * Wraps `ICoreProcessService.rpc.getTools` and translates agent-core's `ToolInfo`
 * (camelCase, includes `'user'` source literal) into SCHEMAS §8 `ToolDescriptor`
 * (snake_case, `'skill'` literal). Adapter helpers (`toProtocolTool`,
 * `AgentCoreToolInfoLike`) are co-located here.
 *
 * **CoreAPI surface used**:
 *   - `bridge.rpc.getTools({}) => readonly ToolInfo[]` (packages/agent-core/src/rpc/core-api.ts:333).
 *
 * **REST.md §3.8 ?session_id behavior**: when caller passes a session_id the
 * route currently returns the same global list — agent-core's `getTools`
 * doesn't differentiate per-session, and `setActiveTools` is the only
 * per-session knob. Documented gap in `ToolService`.
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
 * Parse the server id segment from an MCP tool name. Convention:
 * `mcp:<server>:<tool>` (kosong's `mcpRegistrar.qualifiedName`). Returns
 * `undefined` when the name does not match — caller omits `mcp_server_id`.
 */
function parseMcpServerIdFromToolName(name: string): string | undefined {
  if (!name.startsWith('mcp:')) return undefined;
  const rest = name.slice('mcp:'.length);
  const sep = rest.indexOf(':');
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
   * impl may return a session-effective subset; today it returns the global
   * list (CoreAPI gap documented in the impl).
   */
  list(sessionId?: string): Promise<readonly ToolDescriptor[]>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IToolService = createDecorator<IToolService>('toolService');

void IToolService;
