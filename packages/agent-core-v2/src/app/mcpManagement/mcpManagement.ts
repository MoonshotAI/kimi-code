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
  /**
   * Mutable (user-level) entries carry the full config so edit UIs can
   * prefill values; read-only entries are redacted to sorted key lists
   * (`envKeys` / `headerKeys`) and never disclose secret values.
   */
  readonly config: McpServerConfig | McpServerConfigView;
  readonly source: McpServerSource;
  readonly origin: string;
  readonly mutable: boolean;
  readonly plugin?: McpRegistryPluginOrigin;
}

export interface McpServerTestTarget {
  /** Registry-resolved by name when `server` is omitted. */
  readonly name?: string;
  /** Inline config probes as-is — nothing has to be saved first. */
  readonly server?: GlobalMcpServerConfig;
  /** Project layers join the resolution; also the stdio working directory. */
  readonly cwd?: string;
}

export interface McpServerTestResult {
  readonly success: boolean;
  readonly output: string;
}

/**
 * Stable address of one catalog entry: a global (file-layer) server by name,
 * or a plugin server by plugin id + manifest-local server name.
 */
export type McpServerLocator =
  | { readonly source: 'global'; readonly name: string }
  | { readonly source: 'plugin'; readonly pluginId: string; readonly serverName: string };

/** Locator-addressed catalog entry with the redacted config view. */
export interface McpServerDescriptor {
  /** `global:<name>` / `plugin:<pluginId>:<serverName>`, URL-encoded. */
  readonly serverId: string;
  readonly locator: McpServerLocator;
  readonly runtimeName: string;
  /** Canonical credential URL for remote servers; undefined for stdio. */
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
  /**
   * Omitted preserves implicit OAuth detection, `false` stays offline, and
   * `true` verifies every OAuth candidate through a real connection.
   */
  readonly verify?: boolean;
}

export interface IMcpManagementService {
  readonly _serviceBrand: undefined;

  listServers(query?: McpRegistryQuery): Promise<readonly McpManagedServer[]>;

  getServer(name: string, query?: McpRegistryQuery): Promise<McpManagedServer>;

  /** Writes the user-level file; rejects read-only collisions. Returns the refreshed list. */
  addServer(
    server: GlobalMcpServerConfig,
    query?: McpRegistryQuery,
  ): Promise<readonly McpManagedServer[]>;

  /** Updates an existing user-level entry; rejects read-only collisions. Returns the refreshed list. */
  updateServer(
    server: GlobalMcpServerConfig,
    query?: McpRegistryQuery,
  ): Promise<readonly McpManagedServer[]>;

  /** Removes a user-level entry; rejects read-only collisions. Returns the refreshed list. */
  removeServer(name: string, query?: McpRegistryQuery): Promise<readonly McpManagedServer[]>;

  testServer(target: McpServerTestTarget): Promise<McpServerTestResult>;

  /**
   * Legacy auth-status surface: per-server OAuth state over the registry
   * catalog. Omitted preserves the legacy implicit-OAuth probe for unpinned
   * servers without stored credentials; `verify: false` is fully offline;
   * `verify: true` probes every candidate. Probes may refresh or invalidate
   * stored credentials and broadcast the events.
   */
  listAuthStatuses(query?: McpAuthStatusQuery): Promise<readonly McpServerAuthStatus[]>;

  /**
   * The locator-addressed catalog plus a batched real-connection probe of
   * every OAuth candidate; a probe that hits an expired grant may refresh or
   * invalidate stored credentials and broadcast the events. A runtime name
   * shared by enabled entries cannot be probed (or credentialed)
   * unambiguously and reports `unavailable`.
   */
  inspectServers(
    targets?: readonly McpServerLocator[],
    query?: McpRegistryQuery,
  ): Promise<readonly McpServerInspection[]>;

  /**
   * Resolve a legacy name-only auth target: exactly one enabled entry may
   * own the runtime name — under a collision the caller cannot tell which
   * credential the flow acts on, so it rejects instead of guessing.
   */
  resolveServerByName(name: string, query?: McpRegistryQuery): Promise<McpServerLocator>;

  /** Begin an interactive OAuth flow for a remote server. */
  beginServerAuth(
    locator: McpServerLocator,
    query?: McpRegistryQuery,
  ): Promise<McpServerAuthBeginResult>;

  /** Await the browser callback and finish the code exchange. Unknown flow → request.invalid. */
  completeServerAuth(
    handle: McpServerAuthFlowHandle,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void>;

  /** Tear down a flow without finishing it; unknown flows are ignored. */
  cancelServerAuth(handle: Pick<McpServerAuthFlowHandle, 'flowId'>): Promise<void>;

  /** Clear stored credentials; the invalidation event reaches live sessions. */
  resetServerAuth(locator: McpServerLocator, query?: McpRegistryQuery): Promise<void>;
}

export const IMcpManagementService: ServiceIdentifier<IMcpManagementService> =
  createDecorator<IMcpManagementService>('mcpManagementService');
