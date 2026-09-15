import type {
  GlobalMcpServerConfig,
  McpServerAuthBeginResult,
  McpServerAuthState,
  McpServerDescriptor,
  McpServerInspection,
  McpServerLocator,
  McpServerTestResult,
} from '@moonshot-ai/agent-core-v2/app/mcpManagement/mcpManagement';
import type {
  McpRegistryPluginOrigin,
  McpServerSource,
} from '@moonshot-ai/agent-core-v2/app/mcpRegistry/mcpRegistry';
import type { McpServerConfigView } from '@moonshot-ai/agent-core-v2/mcpCore/configView';

export type { McpServerSource };
export type { McpServerLocator };
export type McpTestResult = McpServerTestResult;
export type BeginGlobalMcpServerAuthResult = McpServerAuthBeginResult;
export type AppMcpServerAuthState = McpServerAuthState;
export type AppMcpServerConfig = McpServerConfigView;
export type AppMcpServerDescriptor = McpServerDescriptor;
export type AppMcpServerInspection = McpServerInspection;
export type McpServerConfig = GlobalMcpServerConfig;

export type GlobalMcpServerAuthState = Exclude<AppMcpServerAuthState, 'unavailable'>;

export interface GlobalMcpServerAuthStatus {
  readonly name: string;
  readonly authStatus: GlobalMcpServerAuthState;
}

export type McpManagedServerInfo = McpServerConfig & {
  readonly source: McpServerSource;
  readonly origin: string;
  readonly mutable: boolean;
  readonly plugin?: McpRegistryPluginOrigin;
  readonly envKeys?: readonly string[];
  readonly headerKeys?: readonly string[];
};

export interface McpServerInfo {
  readonly name: string;
  readonly transport: 'stdio' | 'http' | 'sse';
  readonly status: 'pending' | 'connected' | 'failed' | 'disabled' | 'needs-auth' | 'removed';
  readonly toolCount: number;
  readonly error?: string;
  readonly source?: McpServerSource;
  readonly config?: AppMcpServerConfig;
}

export interface McpStartupMetrics {
  readonly durationMs: number;
}
