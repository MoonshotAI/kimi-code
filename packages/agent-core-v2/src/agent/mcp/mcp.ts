import type { Tool as KosongTool } from '#/kosong/contract/tool';

import { createDecorator } from "#/_base/di/instantiation";
import { type IDisposable } from "#/_base/di/lifecycle";
import type { McpServerEntry } from '#/mcpCore/connection-manager';
import type { McpOAuthService } from '#/mcpCore/oauth/service';
import type { MCPClient, MCPToolDefinition } from '#/mcpCore/types';

export interface McpResolvedServer {
  readonly client: MCPClient;
  readonly tools: readonly KosongTool[];
  readonly rawTools: readonly MCPToolDefinition[];
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

export const IAgentMcpService = createDecorator<IAgentMcpService>('agentMcpService');
