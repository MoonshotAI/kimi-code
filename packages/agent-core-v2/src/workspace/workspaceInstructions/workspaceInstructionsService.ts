import { Disposable, DisposableStore } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { defineState } from '#/state/state';
import { TimeoutTimer } from '#/_base/utils/timer';
import { subtreeWatchFilter } from '#/_base/utils/paths';
import { agentsMdWatchRoots, loadAgentsMdForRoots } from '#/agent/profile/context';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IHostEnvironment, type HostEnvironmentInfo } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { ISessionInstructionsProvider } from '#/session/sessionInstructions/instructionsProvider';
import { IWorkspaceStateService } from '#/workspace/state/workspaceState';
import { IWorkspaceDirs } from '#/workspace/workspaceDirs/workspaceDirs';
import { watchCandidates, type WatchChange } from '#human/utils/watch';

import {
  IWorkspaceInstructionsService,
  type WorkspaceInstructionsSnapshot,
} from './workspaceInstructions';

const WATCH_DEBOUNCE_MS = 200;

export const workspaceInstructionsCurrentKey = defineState<WorkspaceInstructionsSnapshot>(
  'workspaceInstructions.current',
  () => ({ agentsMd: undefined, agentsMdWarning: undefined, agentsMdPaths: undefined }),
);

export class WorkspaceInstructionsService
  extends Disposable
  implements IWorkspaceInstructionsService
{
  declare readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  private readonly onDidChangeEmitter = this._register(new Emitter<readonly WatchChange[]>());
  readonly onDidChange: Event<readonly WatchChange[]> = this.onDidChangeEmitter.event;
  private readonly watchDebounce = this._register(new TimeoutTimer());
  private readonly dirsReloadDebounce = this._register(new TimeoutTimer());
  private reloadTail: Promise<void> = Promise.resolve();
  private reloading: Promise<void> | undefined;
  private reloadRequested = false;
  private loaded = false;
  private readonly pendingChanges = new Map<string, WatchChange>();
  private watchers: DisposableStore | undefined;
  private watchedPrimary: string | undefined;

  constructor(
    @IWorkspaceDirs private readonly dirs: Pick<IWorkspaceDirs, 'primary' | 'onDidChange'>,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IHostEnvironment private readonly env: HostEnvironmentInfo,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @ILogService private readonly log: ILogService,
    @IWorkspaceStateService private readonly states: IWorkspaceStateService,
    private readonly personalFs?: IHostFileSystem,
    private readonly watchEnabled = true,
  ) {
    super();
    this.states.contributeState(workspaceInstructionsCurrentKey);
    this._register(
      this.dirs.onDidChange(() => {
        this.dirsReloadDebounce.cancelAndSet(() => {
          void this.reload().catch((error) => {
            this.log.warn(`AGENTS.md reload failed: ${String(error)}`);
          });
        }, 0);
      }),
    );
    this.ready = this.reload();
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
    if (this.reloading !== undefined) {
      this.reloadRequested = true;
      return this.reloading;
    }
    const tail = this.reloadTail.catch(() => undefined).then(async () => {
      do {
        this.reloadRequested = false;
        await this.reloadNow();
      } while (this.reloadRequested);
    });
    this.reloading = tail;
    this.reloadTail = tail;
    void tail.then(
      () => {
        if (this.reloading === tail) this.reloading = undefined;
      },
      () => {
        if (this.reloading === tail) this.reloading = undefined;
      },
    );
    return tail;
  }

  private async reloadNow(): Promise<void> {
    const result = await loadAgentsMdForRoots(
      { fs: this.fs, homeDir: this.env.homeDir },
      this.bootstrap.homeDir,
      [this.dirs.primary],
      this.personalFs,
    );
    const next: WorkspaceInstructionsSnapshot = {
      agentsMd: result.content,
      agentsMdWarning: result.warning,
      agentsMdPaths: result.paths,
    };
    const changed =
      next.agentsMd !== this.current.agentsMd ||
      next.agentsMdWarning !== this.current.agentsMdWarning;
    this.current = next;
    await this.refreshWatchers();
    const changes = [...this.pendingChanges.values()];
    this.pendingChanges.clear();
    const loaded = this.loaded;
    this.loaded = true;
    if (changed && loaded) {
      this.onDidChangeEmitter.fire(changes);
    }
  }

  sessionProvider(): ISessionInstructionsProvider {
    const currentAgentsMd = (): string | undefined => this.current.agentsMd;
    const currentWarning = (): string | undefined => this.current.agentsMdWarning;
    const currentPaths = (): readonly string[] | undefined => this.current.agentsMdPaths;
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
      get agentsMdPaths() {
        return currentPaths();
      },
    };
  }

  private async refreshWatchers(): Promise<void> {
    if (!this.watchEnabled) return;
    const primary = this.dirs.primary;
    if (this.watchedPrimary === primary) return;
    const plan = await agentsMdWatchRoots(
      { fs: this.fs, homeDir: this.env.homeDir },
      primary,
      this.bootstrap.homeDir,
    );
    this.watchers?.dispose();
    const watchers = this._register(new DisposableStore());
    this.watchers = watchers;
    this.watchedPrimary = primary;
    for (const { root, candidates } of plan) {
      try {
        const handle = watchers.add(watchCandidates(root, candidates, {
          ignored: subtreeWatchFilter(root, candidates),
        }));
        watchers.add(
          handle.onDidChange((change) => {
            this.pendingChanges.set(change.path, change);
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

