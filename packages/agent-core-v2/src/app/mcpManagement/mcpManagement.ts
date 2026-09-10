import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { McpServerConfig } from '#/mcpCore/config-schema';
import type { McpServerConfigView } from '#/mcpCore/configView';
import type {
  McpRegistryPluginOrigin,
  McpRegistryQuery,
  McpServerSource,
} from '#/app/mcpRegistry/mcpRegistry';

export type GlobalMcpServerConfig = McpServerConfig & { readonly name: string };

export interface McpManagedServer {
  readonly name: string;
  readonly config: McpServerConfig | McpServerConfigView;
  readonly source: McpServerSource;
  readonly origin: string;
  readonly mutable: boolean;
  readonly plugin?: McpRegistryPluginOrigin;
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

export type McpServerLocator =
  | { readonly source: 'global'; readonly name: string }
  | { readonly source: 'plugin'; readonly pluginId: string; readonly serverName: string };

export interface McpServerDescriptor {
  readonly serverId: string;
  readonly locator: McpServerLocator;
  readonly runtimeName: string;
  readonly canonicalUrl?: string;
  readonly origin: McpServerSource;
  readonly config: McpServerConfigView;
  readonly enabled: boolean;
  readonly editable: boolean;
}

export type McpServerAuthState =
  | 'not-applicable'
  | 'bearer-token'
  | 'oauth-required'
  | 'oauth-authorized'
  | 'oauth-expired'
  | 'unavailable';

export interface McpServerInspection extends McpServerDescriptor {
  readonly authStatus: McpServerAuthState;
  readonly checkedAt?: number;
  readonly error?: string;
}

export interface McpServerAuthStatus {
  readonly name: string;
  readonly authStatus: McpServerAuthState;
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

export interface McpAuthStatusQuery extends McpRegistryQuery {
  readonly verify?: boolean;
}

export interface IMcpManagementService {
  readonly _serviceBrand: undefined;

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

  listAuthStatuses(query?: McpAuthStatusQuery): Promise<readonly McpServerAuthStatus[]>;

  inspectServers(
    targets?: readonly McpServerLocator[],
    query?: McpRegistryQuery,
  ): Promise<readonly McpServerInspection[]>;

  resolveServerByName(name: string, query?: McpRegistryQuery): Promise<McpServerLocator>;

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
}

export const IMcpManagementService: ServiceIdentifier<IMcpManagementService> =
  createDecorator<IMcpManagementService>('mcpManagementService');
