import { Event } from '#/_base/event';
import { workspaceRootKey } from '#/_base/utils/workdir-slug';
import type { IEnvironmentService } from '#/app/environment/environment';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { isHostFsNotDirectory, isHostFsNotFound } from '#/os/interface/hostFsErrors';
import type { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import type { McpDirs } from '#/workspace/workspaceMcpConfig/workspaceMcpConfig';
import type { IWorkspaceTrust } from '#/workspace/workspaceTrust/workspaceTrust';

import type { ProgramDependencies } from './programDependencies';
import { ProgramMcp, type ProgramMcpLease } from './programMcp';

export class ProgramMcpSets {
  private readonly primary: ProgramMcp;
  private readonly others = new Map<string, ProgramMcp>();
  private disposed = false;

  constructor(
    private readonly environments: IEnvironmentService,
    private readonly context: IWorkspaceContext,
    private readonly dependencies: ProgramDependencies,
    private readonly hostFs: IHostFileSystem,
    private readonly dirs: McpDirs,
    private readonly trust: IWorkspaceTrust,
  ) {
    this.primary = this.setFor(dirs);
  }

  async acquire(workDir?: string): Promise<ProgramMcpLease> {
    const dir = await this.ownDirOf(workDir);
    if (this.disposed) throw new Error('program MCP is disposed');
    return dir === undefined ? this.primary.acquire() : this.setAt(dir).acquire();
  }

  async effectiveWorkDir(workDir?: string): Promise<string> {
    return (await this.ownDirOf(workDir)) ?? this.dirs.primary;
  }

  servers(): Readonly<Record<string, McpServerConfig>> {
    return this.primary.servers();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all([this.primary, ...this.others.values()].map((set) => set.dispose()));
  }

  private async ownDirOf(workDir: string | undefined): Promise<string | undefined> {
    if (workDir === undefined) return undefined;
    let dir: string;
    try {
      dir = await this.hostFs.realpath(workDir);
    } catch (error) {
      return isHostFsNotFound(error) || isHostFsNotDirectory(error) ? workDir : undefined;
    }
    const root = this.dirs.primary;
    const projectDir = await this.dependencies.workspaces.projectDirAt({ root }, dir);
    return projectDir === root ? undefined : projectDir;
  }

  private setAt(dir: string): ProgramMcp {
    const key = workspaceRootKey(dir);
    let set = this.others.get(key);
    if (set === undefined) {
      set = this.setFor({ ready: Promise.resolve(), primary: dir, onDidChange: Event.None as Event<void> });
      this.others.set(key, set);
    }
    return set;
  }

  private setFor(dirs: McpDirs): ProgramMcp {
    return new ProgramMcp(this.environments, this.context, this.dependencies, this.hostFs, dirs, this.trust);
  }
}
