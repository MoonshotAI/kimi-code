import type { RuntimeEvent } from '#/composition-api/index';

import type { OsHost } from '#/todo-features/os/host/index';

import type { McpServerConfig } from './core/config-schema';
import type { McpServerEntry, McpServerStatus } from './core/connection-manager';
import type { McpManagement } from './management';

export interface McpMediaStore {
  put(content: {
    readonly bytes: Uint8Array;
    readonly mimeType?: string;
    readonly filename?: string;
  }): Promise<{ readonly ref: string }>;
}

export interface CreateMcpProps {
  readonly workDir?: string;
  readonly HOME?: string;
  readonly host?: OsHost;
  readonly trusted?: boolean;
  readonly servers?: Record<string, McpServerConfig>;
  readonly mediaStore?: McpMediaStore;
  readonly providerType?: () => string | undefined;
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
