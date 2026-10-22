import type { GlobalMcpServerConfig } from './config/store';
import type { McpServerConfig } from './core/config-schema';
import type { McpServerConfigView } from './core/config-view';

export type McpManagedServerSource = 'global' | 'plugin' | 'caller';

export interface McpRegistryQuery {
  readonly cwd?: string;
}

export interface McpManagedServer {
  readonly name: string;
  readonly config: McpServerConfig | McpServerConfigView;
  readonly source: McpManagedServerSource;
  readonly origin: string;
  readonly mutable: boolean;
  readonly plugin?: { readonly id: string; readonly name: string };
}

export type McpServerLocator =
  | { readonly source: 'global'; readonly name: string }
  | { readonly source: 'plugin'; readonly pluginId: string; readonly serverName: string };

export type McpServerAuthState =
  | 'not-applicable'
  | 'bearer-token'
  | 'oauth-required'
  | 'oauth-authorized'
  | 'oauth-expired'
  | 'unavailable';

export interface McpAuthStatusQuery extends McpRegistryQuery {
  readonly verify?: boolean;
}

export interface McpServerAuthStatus {
  readonly name: string;
  readonly authStatus: McpServerAuthState;
}

export interface McpServerTestTarget {
  readonly name?: string;
  readonly server?: GlobalMcpServerConfig;
  readonly cwd?: string;
}

export interface McpServerTestResult {
  readonly success: boolean;
  readonly output: string;
}

export interface McpServerInspection {
  readonly serverId: string;
  readonly locator: McpServerLocator;
  readonly runtimeName: string;
  readonly canonicalUrl?: string;
  readonly origin: McpManagedServerSource;
  readonly config: McpServerConfigView;
  readonly enabled: boolean;
  readonly editable: boolean;
  readonly authStatus: McpServerAuthState;
  readonly checkedAt?: number;
  readonly error?: string;
}

export type McpServerAuthBeginResult =
  | {
      readonly status: 'authorization-required';
      readonly flowId: string;
      readonly authorizationUrl: string;
    }
  | { readonly status: 'already-authorized' };

export interface McpServerAuthFlowHandle {
  readonly flowId: string;
  readonly timeoutMs?: number;
}

export interface McpManagement {
  listServers(query?: McpRegistryQuery): Promise<readonly McpManagedServer[]>;
  getServer(name: string, query?: McpRegistryQuery): Promise<McpManagedServer>;
  addServer(
    server: GlobalMcpServerConfig,
    query?: McpRegistryQuery,
  ): Promise<readonly McpManagedServer[]>;
  updateServer(
    server: GlobalMcpServerConfig,
    query?: McpRegistryQuery,
  ): Promise<readonly McpManagedServer[]>;
  removeServer(name: string, query?: McpRegistryQuery): Promise<readonly McpManagedServer[]>;
  testServer(target: McpServerTestTarget): Promise<McpServerTestResult>;
  inspectServers(
    targets?: readonly McpServerLocator[],
    query?: McpRegistryQuery,
  ): Promise<readonly McpServerInspection[]>;
  listAuthStatuses(query?: McpAuthStatusQuery): Promise<readonly McpServerAuthStatus[]>;
  beginServerAuth(
    locator: McpServerLocator,
    query?: McpRegistryQuery,
  ): Promise<McpServerAuthBeginResult>;
  completeServerAuth(
    handle: McpServerAuthFlowHandle,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void>;
  cancelServerAuth(handle: Pick<McpServerAuthFlowHandle, 'flowId'>): Promise<void>;
  resetServerAuth(locator: McpServerLocator, query?: McpRegistryQuery): Promise<void>;
  dispose(): void;
}
