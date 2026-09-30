import type { RuntimeEvent } from '@moonshot-ai/agent-core/kernel/index';

import type { MediaStore } from '#/features/media/store';
import type { OsHost } from '#/features/os/host/types';

import type { McpServerConfig } from './core/config-schema';
import type { McpServerEntry, McpServerStatus } from './core/connection-manager';
import type { McpManagement } from './management';

export interface CreateMcpProps {
  readonly workDir?: string;
  readonly home?: string;
  readonly host?: OsHost;
  readonly trusted?: boolean;
  readonly servers?: Record<string, McpServerConfig>;
  readonly mediaStore?: MediaStore;
  readonly sessionCwd?: (sessionId: string) => string | undefined;
}

export interface McpFacade extends Omit<McpManagement, 'dispose'> {
  list(): readonly McpServerEntry[];
  reconnect(name: string): Promise<void>;
  reload(): Promise<void>;
  connect(name: string, config: McpServerConfig, opts?: { cwd?: string }): Promise<void>;
  disconnect(name: string): Promise<void>;
}

export interface McpServerStateEvent extends RuntimeEvent {
  readonly type: 'mcp.server.state';
  readonly server: string;
  readonly state: McpServerStatus;
  readonly error?: string;
}

export interface McpOAuthAuthorizationUrlEvent extends RuntimeEvent {
  readonly type: 'mcp.oauth.authorization_url';
  readonly server: string;
  readonly authorizationUrl: string;
  readonly expiresAt?: number;
}

export type McpEvent = McpServerStateEvent | McpOAuthAuthorizationUrlEvent;
