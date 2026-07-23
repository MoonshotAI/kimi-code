/**
 * `workspaceCommand` domain (L6) — `ISessionWorkspaceCommandService` implementation.
 *
 * Coordinates session-level workspace mutations: resolves and persists
 * project-local config through `projectLocalConfig`, updates
 * `workspaceContext`, and mirrors command output into the main agent through
 * `agentLifecycle` and `contextMemory`. Bound at Session scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IProjectLocalConfigService } from '#/app/projectLocalConfig/projectLocalConfig';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

import {
  type AddAdditionalDirInput,
  ISessionWorkspaceCommandService,
  type WorkspaceAdditionalDirsResult,
} from './workspaceCommand';

export class SessionWorkspaceCommandService
  extends Disposable
  implements ISessionWorkspaceCommandService
{
  declare readonly _serviceBrand: undefined;
  private readonly pendingMainInjections: ContextMessage[] = [];
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    @IProjectLocalConfigService
    private readonly localConfig: IProjectLocalConfigService,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @IAgentLifecycleService private readonly agents: IAgentLifecycleService,
  ) {
    super();
    this._register(
      this.agents.onDidCreate((handle) => {
        if (handle.id !== MAIN_AGENT_ID) return;
        if (this.pendingMainInjections.length === 0) return;
        const pending = this.pendingMainInjections.splice(0);
        handle.accessor.get(IAgentContextMemoryService).append(...pending);
      }),
    );
  }

  async addAdditionalDir(input: AddAdditionalDirInput): Promise<WorkspaceAdditionalDirsResult> {
    return this.enqueueMutation(() => this.applyAddAdditionalDir(input));
  }

  private async applyAddAdditionalDir(
    input: AddAdditionalDirInput,
  ): Promise<WorkspaceAdditionalDirsResult> {
    const persist = input.persist ?? true;

    if (persist) {
      const persisted = await this.localConfig.appendAdditionalDir(
        this.workspace.workDir,
        input.path,
      );
      this.workspace.setAdditionalDirs([
        ...this.workspace.additionalDirs,
        ...persisted.additionalDirs,
      ]);
      this.injectAdditionalDirAdded(input.path, true, persisted.configPath);
      return {
        projectRoot: persisted.projectRoot,
        configPath: persisted.configPath,
        additionalDirs: this.workspace.additionalDirs,
        persisted: true,
      };
    }

    const workspace = await this.localConfig.readAdditionalDirs(this.workspace.workDir);
    const resolved = await this.localConfig.resolveAdditionalDirs(this.workspace.workDir, [
      input.path,
    ]);
    this.workspace.setAdditionalDirs([...this.workspace.additionalDirs, ...resolved]);
    this.injectAdditionalDirAdded(input.path, false, workspace.configPath);
    return {
      projectRoot: workspace.projectRoot,
      configPath: workspace.configPath,
      additionalDirs: this.workspace.additionalDirs,
      persisted: false,
    };
  }

  private enqueueMutation<T>(work: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(work, work);
    this.mutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private injectAdditionalDirAdded(path: string, persisted: boolean, configPath: string): void {
    const stdout = persisted
      ? `Added workspace directory:\n  ${path}\n  Saved to:\n  ${configPath}`
      : `Added workspace directory:\n  ${path}\n  For this session only`;
    const text = `<local-command-stdout>\n${stdout.trim()}\n</local-command-stdout>`;
    const message: ContextMessage = {
      role: 'user',
      content: [{ type: 'text', text }],
      toolCalls: [],
      origin: { kind: 'injection', variant: 'local-command-stdout' },
    };

    const main = this.agents.get(MAIN_AGENT_ID);
    if (main !== undefined) {
      main.accessor.get(IAgentContextMemoryService).append(message);
      return;
    }
    this.pendingMainInjections.push(message);
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionWorkspaceCommandService,
  SessionWorkspaceCommandService,
  InstantiationType.Eager,
  'workspaceCommand',
);
