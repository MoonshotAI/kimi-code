/**
 * `mcp` domain (L5) — session-scope MCP connection manager.
 */

import type { Event } from '#/_base/event';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface McpServerStatusEvent {
  readonly serverId: string;
  readonly status: string;
}

export interface IMcpService {
  readonly _serviceBrand: undefined;
  readonly onDidChangeServerStatus: Event<McpServerStatusEvent>;
  connect(serverId: string): Promise<void>;
  disconnect(serverId: string): Promise<void>;
  list(): readonly string[];
}

export const IMcpService: ServiceIdentifier<IMcpService> =
  createDecorator<IMcpService>('mcpService');
