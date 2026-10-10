

export type SandboxMode = 'off' | 'read-only' | 'workspace-write' | 'danger-full-access';

export type SandboxBackendName = 'seatbelt' | 'bwrap' | 'unsupported';

export type NetworkPolicyMode = 'off' | 'allowlist' | 'all';

export interface SandboxNetworkPolicy {
  readonly mode: NetworkPolicyMode;
  readonly allowedDomains: readonly string[];
  readonly deniedDomains: readonly string[];
  readonly allowLocalBinding: boolean;
  readonly allowUnixSockets: readonly string[];
  readonly proxyPorts?: {
    readonly http?: number;
    readonly socks?: number;
  };
}

export interface SandboxProxyEndpoint {
  readonly env: Record<string, string>;
  readonly httpPort: number;
  readonly socksPort: number;
  readonly token: string;
}

export interface SandboxSpawnRequest {
  readonly cwd: string;
  readonly workspaceRoots: readonly string[];
  readonly command?: string;
  readonly disabled?: boolean;

  readonly proxy?: SandboxProxyEndpoint;
}

export interface ResolvedSandboxProfile {
  readonly mode: Exclude<SandboxMode, 'off'>;
  readonly cwd: string;
  readonly writableRoots: readonly string[];
  readonly readableRoots: readonly string[];
  readonly denyWritePaths: readonly string[];
  readonly denyReadPaths: readonly string[];
  readonly network: SandboxNetworkPolicy;
}

export interface SandboxSpawnPlan {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
}

export interface SandboxProcessInfo {
  readonly backend: SandboxBackendName;
  readonly mode: string;
}
