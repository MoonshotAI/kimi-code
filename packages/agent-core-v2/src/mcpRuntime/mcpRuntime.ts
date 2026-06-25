import type { Tool as KosongTool } from '@moonshot-ai/kosong';

import { createDecorator, type IDisposable } from "#/_base/di";
import type {
  McpConnectionManager,
  McpServerEntry,
} from '../../../mcp/connection-manager';
import type { McpOAuthService } from '../../../mcp/oauth';
import type { MCPClient } from '../../../mcp/types';

export interface McpResolvedServer {
  readonly client: MCPClient;
  readonly tools: readonly KosongTool[];
  readonly enabledNames: ReadonlySet<string>;
}

export interface IMcpRuntimeService {
  readonly oauthService: McpOAuthService | undefined;

  waitForInitialLoad(signal?: AbortSignal): Promise<void>;
  initialLoadDurationMs(): number;
  list(): readonly McpServerEntry[];
  resolved(name: string): McpResolvedServer | undefined;
  getRemoteServerUrl(name: string): string | undefined;
  reconnect(name: string, signal?: AbortSignal): Promise<void>;
  onStatusChange(listener: (entry: McpServerEntry) => void): IDisposable;
}

export interface McpRuntimeServiceOptions {
  readonly manager?: McpConnectionManager;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IMcpRuntimeService = createDecorator<IMcpRuntimeService>('agentMcpRuntimeService');
