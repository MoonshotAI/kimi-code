

import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { globMatch } from '#/tool/rule-match';
import { IConfigService } from '#/app/config/config';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { LifecycleScope } from '#/app/scopes';

import { resolveSandboxConfig } from './configSection';
import type {
  ResolvedSandboxProfile,
  SandboxMode,
  SandboxNetworkPolicy,
  SandboxSpawnRequest,
} from './types';

const PROTECTED_METADATA_DIRS = ['.git', '.kimi-code', '.agents'] as const;

const SENSITIVE_HOME_SUBPATHS = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.docker',
  '.azure',
  '.config/gh',
  '.config/gcloud',
  '.kimi-code',
] as const;

export interface ISandboxProfileResolver {
  readonly _serviceBrand: undefined;

  resolve(request: SandboxSpawnRequest): ResolvedSandboxProfile | undefined;
  shouldSandbox(request: SandboxSpawnRequest): boolean;
  allowsUnsandboxedFallback(): boolean;
}

export const ISandboxProfileResolver: ServiceIdentifier<ISandboxProfileResolver> =
  createDecorator<ISandboxProfileResolver>('sandboxProfileResolver');

export class SandboxProfileResolver implements ISandboxProfileResolver {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IConfigService private readonly config: IConfigService,
    @IHostEnvironment private readonly env: IHostEnvironment,
  ) {}

  shouldSandbox(request: SandboxSpawnRequest): boolean {
    const cfg = resolveSandboxConfig(this.config);
    const mode = cfg?.mode ?? 'workspace-write';
    if (mode === 'off' || request.disabled === true) return false;
    if (
      request.command !== undefined &&
      (cfg?.excludedCommands ?? []).some((pattern) => globMatch(request.command!, pattern))
    ) {
      return false;
    }
    return true;
  }

  allowsUnsandboxedFallback(): boolean {
    return resolveSandboxConfig(this.config)?.allowUnsandboxedCommands ?? false;
  }

  resolve(request: SandboxSpawnRequest): ResolvedSandboxProfile | undefined {
    if (!this.shouldSandbox(request)) return undefined;
    const cfg = resolveSandboxConfig(this.config);
    const mode: SandboxMode = cfg?.mode ?? 'workspace-write';
    if (mode === 'off') return undefined;

    const workspaceRoots = dedupe(
      request.workspaceRoots.map((root) => this.expandPath(root, request.cwd)),
    );

    const denyWritePaths = dedupe([
      ...workspaceRoots.flatMap((root) =>
        PROTECTED_METADATA_DIRS.map((dir) => join(root, dir)),
      ),
      ...(cfg?.denyWrite ?? []).map((p) => this.expandPath(p, request.cwd)),
    ]);

    const denyReadPaths = dedupe([
      ...SENSITIVE_HOME_SUBPATHS.map((sub) => join(this.env.homeDir, sub)),
      ...(cfg?.denyRead ?? []).map((p) => this.expandPath(p, request.cwd)),
    ]);

    const network: SandboxNetworkPolicy = {
      mode: cfg?.network?.mode ?? 'all',
      allowedDomains: cfg?.network?.allowedDomains ?? [],
      deniedDomains: cfg?.network?.deniedDomains ?? [],
      allowLocalBinding: cfg?.network?.allowLocalBinding ?? true,
      allowUnixSockets: cfg?.network?.allowUnixSockets ?? [],
      proxyPorts:
        request.proxy === undefined
          ? undefined
          : { http: request.proxy.httpPort, socks: request.proxy.socksPort },
    };

    if (mode === 'danger-full-access') {
      return {
        mode,
        cwd: request.cwd,
        writableRoots: ['/'],
        readableRoots: [],
        denyWritePaths: [],
        denyReadPaths: [],
        network: { ...network, mode: 'all' },
      };
    }

    const writableRoots =
      mode === 'workspace-write'
        ? dedupe([
            ...workspaceRoots,
            ...this.tmpRoots(),
            ...(cfg?.writableRoots ?? []).map((p) => this.expandPath(p, request.cwd)),
          ])
        : dedupe(this.tmpRoots());

    return {
      mode,
      cwd: request.cwd,
      writableRoots,
      readableRoots: (cfg?.readableRoots ?? []).map((p) => this.expandPath(p, request.cwd)),
      denyWritePaths,
      denyReadPaths,
      network,
    };
  }

  private expandPath(path: string, cwd: string): string {
    if (path === '~' || path.startsWith('~/')) {
      return join(this.env.homeDir, path.slice(1));
    }
    return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  }

  private tmpRoots(): string[] {
    const roots = [tmpdir(), '/tmp', process.env['TMPDIR']].filter(
      (p): p is string => p !== undefined && p.length > 0,
    );
    if (process.platform === 'darwin') roots.push('/private/tmp');
    return dedupe(roots);
  }
}

function dedupe(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

registerScopedService(
  LifecycleScope.App,
  ISandboxProfileResolver,
  SandboxProfileResolver,
  ScopeActivation.OnDemand,
  'os/sandbox',
);
