import { Event } from '#/_base/event';
import { workspaceRootKey } from '#/_base/utils/workdir-slug';
import type { IEnvironmentService } from '#/app/environment/environment';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { isHostFsNotDirectory, isHostFsNotFound } from '#/os/interface/hostFsErrors';
import type { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import type { McpDirs } from '#/workspace/workspaceMcpConfig/workspaceMcpConfig';
import type { IWorkspaceTrust, WorkspaceTrustChange } from '#/workspace/workspaceTrust/workspaceTrust';

import type { ProgramDependencies } from './programDependencies';
import { ProgramMcp, type ProgramMcpLease } from './programMcp';

type OwnDir =
  | { readonly kind: 'primary' }
  | { readonly kind: 'checkout'; readonly dir: string }
  | { readonly kind: 'missing'; readonly dir: string };

const PRIMARY: OwnDir = { kind: 'primary' };

const MISSING_DIR_TRUST: IWorkspaceTrust = {
  _serviceBrand: undefined,
  ready: Promise.resolve(),
  get: () => Promise.resolve(false),
  isTrusted: () => false,
  trust: () => Promise.reject(new Error('a working directory that no longer exists cannot be trusted')),
  untrust: () => Promise.reject(new Error('a working directory that no longer exists cannot be untrusted')),
  onDidChange: Event.None as Event<WorkspaceTrustChange>,
};

export class ProgramMcpSets {
  private readonly primary: ProgramMcp;
  private readonly others = new Map<string, ProgramMcp>();
  private readonly missing = new Map<string, ProgramMcp>();
  private disposed = false;

  constructor(
    private readonly environments: IEnvironmentService,
    private readonly context: IWorkspaceContext,
    private readonly dependencies: ProgramDependencies,
    private readonly hostFs: IHostFileSystem,
    private readonly dirs: McpDirs,
    private readonly trust: IWorkspaceTrust,
  ) {
    this.primary = this.setFor(dirs, trust);
  }

  async acquire(workDir?: string): Promise<ProgramMcpLease> {
    const own = await this.ownDirOf(workDir);
    if (this.disposed) throw new Error('program MCP is disposed');
    switch (own.kind) {
      case 'primary':
        return this.primary.acquire();
      case 'checkout':
        return this.setAt(this.others, own.dir, this.trust).acquire();
      case 'missing':
        return this.setAt(this.missing, own.dir, MISSING_DIR_TRUST).acquire();
    }
  }

  async effectiveWorkDir(workDir?: string): Promise<string> {
    const own = await this.ownDirOf(workDir);
    return own.kind === 'primary' ? this.dirs.primary : own.dir;
  }

  servers(): Readonly<Record<string, McpServerConfig>> {
    return this.primary.servers();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all(
      [this.primary, ...this.others.values(), ...this.missing.values()].map((set) => set.dispose()),
    );
  }

  private async ownDirOf(workDir: string | undefined): Promise<OwnDir> {
    if (workDir === undefined) return PRIMARY;
    let dir: string;
    try {
      dir = await this.hostFs.realpath(workDir);
    } catch (error) {
      return isHostFsNotFound(error) || isHostFsNotDirectory(error) ? { kind: 'missing', dir: workDir } : PRIMARY;
    }
    const root = this.dirs.primary;
    const projectDir = await this.dependencies.workspaces.projectDirAt({ root }, dir);
    return projectDir === undefined || projectDir === root ? PRIMARY : { kind: 'checkout', dir: projectDir };
  }

  private setAt(sets: Map<string, ProgramMcp>, dir: string, trust: IWorkspaceTrust): ProgramMcp {
    const key = workspaceRootKey(dir);
    let set = sets.get(key);
    if (set === undefined) {
      set = this.setFor({ ready: Promise.resolve(), primary: dir, onDidChange: Event.None as Event<void> }, trust);
      sets.set(key, set);
    }
    return set;
  }

  private setFor(dirs: McpDirs, trust: IWorkspaceTrust): ProgramMcp {
    return new ProgramMcp(this.environments, this.context, this.dependencies, this.hostFs, dirs, trust);
  }
}
