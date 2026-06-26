/**
 * `mcp` domain (L5) — manages MCP server connections.
 *
 * Defines the public contract of MCP: the `McpServerStatusEvent` model and the
 * `IMcpService` used to connect, disconnect, and list servers and observe
 * `onDidChangeServerStatus`. Session-scoped — one instance per session.
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
