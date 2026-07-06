import type { Tool as KosongTool } from '#/app/llmProtocol';

import { createDecorator, type IDisposable } from "#/_base/di";
import type {
  McpConnectionManager,
  McpServerEntry,
} from './connection-manager';
import type { McpOAuthService } from '#/agent/mcp/oauth';
import type { MCPClient } from './types';

export interface McpResolvedServer {
  readonly client: MCPClient;
  readonly tools: readonly KosongTool[];
  readonly enabledNames: ReadonlySet<string>;
}

export interface IAgentMcpService {
  readonly _serviceBrand: undefined;

  readonly oauthService: McpOAuthService | undefined;
  waitForInitialLoad(signal?: AbortSignal): Promise<void>;
  initialLoadDurationMs(): number;
  list(): readonly McpServerEntry[];
  resolved(name: string): McpResolvedServer | undefined;
  getRemoteServerUrl(name: string): string | undefined;
  reconnect(name: string, signal?: AbortSignal): Promise<void>;
  onStatusChange(listener: (entry: McpServerEntry) => void): IDisposable;
}

export interface McpServiceOptions {
  readonly manager?: McpConnectionManager;
  readonly originalsDir?: string;
}

export const IAgentMcpService = createDecorator<IAgentMcpService>('agentMcpService');
