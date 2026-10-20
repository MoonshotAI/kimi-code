import type { KimiRegion } from '@moonshot-ai/kimi-code-oauth';

import type { OsFsPort, OsProcessPort } from '#/features/os/host/index';

export interface CapabilityPluginSummary {
  readonly id: string;
  readonly enabled: boolean;
  readonly state: string;
  readonly version?: string;
  readonly enabledMcpServerCount: number;
  readonly mcpServerCount: number;
}

export interface CapabilityPluginServerInfo {
  readonly name: string;
  readonly enabled: boolean;
}

export interface CapabilityPluginsPort {
  listPlugins(): Promise<readonly CapabilityPluginSummary[]>;
  installPlugin(source: string): Promise<CapabilityPluginSummary>;
  setPluginEnabled(id: string, enabled: boolean): Promise<void>;
  setPluginMcpServerEnabled(id: string, server: string, enabled: boolean): Promise<void>;
  getPluginInfo(
    id: string,
  ): Promise<{ readonly mcpServers: readonly CapabilityPluginServerInfo[] }>;
}

export interface CapabilityEntryContext {
  readonly platform: string;
  readonly arch: string;
  readonly kimiHomeDir: string;
  readonly userHomeDir: string;
  readonly plugins: CapabilityPluginsPort;
  readonly hostProcess: OsProcessPort;
  readonly fs: OsFsPort;
  readonly fetchImpl?: typeof fetch;
  readonly applicationsDir?: string;
  readonly webbridgeBaseUrl?: string;
  readonly detectProbeTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
  readonly resolveRegion?: () => KimiRegion | Promise<KimiRegion>;
}
