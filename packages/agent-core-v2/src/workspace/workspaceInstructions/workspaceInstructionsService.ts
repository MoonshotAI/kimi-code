/**
 * `workspaceInstructions` domain (L4) — `IWorkspaceInstructionsService`
 * implementation.
 *
 * Loads the workspace root's AGENTS.md hierarchy at construction through the
 * `profile` domain's pure loader (over the os `hostFs`, the host home dir,
 * and the `bootstrap` brand dir), then watches the loader's probe set
 * (`agentsMdWatchRoots` — brand / user-generic / project-root→leaf chain,
 * each plan root watched recursively and pruned to its candidates so files
 * created later inside not-yet-existing directories are still caught)
 * through `hostFsWatch` and reloads debounced; the change event fires only
 * when the combined content or warning actually changed. The snapshot is shared by every session of
 * the handler through the `ISessionInstructionsProvider` seed
 * (`sessionProvider()`), a live read view over this service. The plain-data
 * state (`current`) is registered into `workspaceState`
 * (`IWorkspaceStateService`) and read/written through it. Bound at
 * Workspace scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { defineState } from '#/_base/state/stateRegistry';
import { TimeoutTimer } from '#/_base/utils/timer';
import { subtreeWatchFilter } from '#/_base/utils/paths';
import { agentsMdWatchRoots, loadAgentsMdForRoots } from '#/agent/profile/context';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostFsWatchService } from '#/os/interface/hostFsWatch';
import type { ISessionInstructionsProvider } from '#/session/sessionInstructions/instructionsProvider';
import { IWorkspaceStateService } from '#/workspace/state/workspaceState';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';

import {
  IWorkspaceInstructionsService,
  type WorkspaceInstructionsSnapshot,
} from './workspaceInstructions';

const WATCH_DEBOUNCE_MS = 200;

export const workspaceInstructionsCurrentKey = defineState<WorkspaceInstructionsSnapshot>(
  'workspaceInstructions.current',
  () => ({ agentsMd: undefined, agentsMdWarning: undefined }),
);

export class WorkspaceInstructionsService
  extends Disposable
  implements IWorkspaceInstructionsService
{
  declare readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  private readonly onDidChangeEmitter = this._register(new Emitter<void>());
  readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;
  private readonly watchDebounce = this._register(new TimeoutTimer());
  private reloadTail: Promise<void> = Promise.resolve();

  constructor(
    @IWorkspaceContext private readonly workspace: IWorkspaceContext,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IHostEnvironment private readonly env: IHostEnvironment,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostFsWatchService private readonly fsWatch: IHostFsWatchService,
    @ILogService private readonly log: ILogService,
    @IWorkspaceStateService private readonly states: IWorkspaceStateService,
  ) {
    super();
    this.states.register(workspaceInstructionsCurrentKey);
    this.ready = this.reload();
    void this.watchCandidateFiles();
  }

  private get current(): WorkspaceInstructionsSnapshot {
    return this.states.get(workspaceInstructionsCurrentKey);
  }

  private set current(value: WorkspaceInstructionsSnapshot) {
    this.states.set(workspaceInstructionsCurrentKey, value);
  }

  get snapshot(): WorkspaceInstructionsSnapshot {
    return this.current;
  }

  reload(): Promise<void> {
    const tail = this.reloadTail.catch(() => undefined).then(async () => {
      const result = await loadAgentsMdForRoots(
        { fs: this.fs, homeDir: this.env.homeDir },
        this.bootstrap.homeDir,
        [this.workspace.cwd],
      );
      const next: WorkspaceInstructionsSnapshot = {
        agentsMd: result.content,
        agentsMdWarning: result.warning,
      };
      if (
        next.agentsMd !== this.current.agentsMd ||
        next.agentsMdWarning !== this.current.agentsMdWarning
      ) {
        this.current = next;
        this.onDidChangeEmitter.fire();
      }
    });
    this.reloadTail = tail;
    return tail;
  }

  sessionProvider(): ISessionInstructionsProvider {
    const currentAgentsMd = (): string | undefined => this.current.agentsMd;
    const currentWarning = (): string | undefined => this.current.agentsMdWarning;
    return {
      _serviceBrand: undefined,
      ready: this.ready,
      onDidChange: this.onDidChange,
      get agentsMd() {
        return currentAgentsMd();
      },
      get agentsMdWarning() {
        return currentWarning();
      },
    };
  }

  private async watchCandidateFiles(): Promise<void> {
    // Watch each plan root recursively, pruned to its candidate files:
    // watching a candidate file directly never fires when its parent
    // directory (`.kimi-code` / `.agents`) does not exist yet either.
    const plan = await agentsMdWatchRoots(
      { fs: this.fs, homeDir: this.env.homeDir },
      this.workspace.cwd,
      this.bootstrap.homeDir,
    );
    for (const { root, candidates } of plan) {
      try {
        const handle = this.fsWatch.watch(root, {
          ignored: subtreeWatchFilter(root, candidates),
        });
        this._register(handle);
        this._register(
          handle.onDidChange(() => {
            this.watchDebounce.cancelAndSet(() => {
              void this.reload().catch((error) => {
                this.log.warn(`AGENTS.md reload failed: ${String(error)}`);
              });
            }, WATCH_DEBOUNCE_MS);
          }),
        );
      } catch (error) {
        this.log.warn(`cannot watch instruction root ${root}: ${String(error)}`);
      }
    }
  }
}

registerScopedService(
  LifecycleScope.Workspace,
  IWorkspaceInstructionsService,
  WorkspaceInstructionsService,
  ScopeActivation.OnScopeCreated,
  'workspaceInstructions',
);
