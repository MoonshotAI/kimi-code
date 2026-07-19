/**
 * `sessionSkillCatalog` domain (L3) — extra `ISkillSource` producer.
 *
 * Discovers user-configured extra skill directories (`extraSkillDirs`) through
 * `ISkillDiscovery`, contributing them at priority 10 (above plugin / builtin,
 * below user / workspace). Relative paths resolve against the session project
 * root; `~` and `~/...` resolve against the bootstrap home dir. Hot-reloads on
 * both its config section (re-resolving the watched directories) and
 * filesystem changes in the configured roots (watched through `hostFsWatch`
 * via `SkillRootWatcher`). Bound at Session scope so each session reads its
 * own workspace root.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import {
  EXTRA_SKILL_DIRS_SECTION,
  type ExtraSkillDirsConfig,
} from '#/app/skillCatalog/configSection';
import { configuredRootCandidates, configuredRoots } from '#/app/skillCatalog/skillRoots';
import { ISkillDiscovery } from '#/app/skillCatalog/skillDiscovery';
import { SkillRootWatcher } from '#/app/skillCatalog/skillRootWatcher';
import { SKILL_SOURCE_PRIORITY, type ISkillSource, type SkillContribution } from '#/app/skillCatalog/skillSource';
import { IHostFsWatchService } from '#/os/interface/hostFsWatch';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

export interface IExtraFileSkillSource extends ISkillSource {
  readonly _serviceBrand: undefined;
}

export const IExtraFileSkillSource: ServiceIdentifier<IExtraFileSkillSource> =
  createDecorator<IExtraFileSkillSource>('extraFileSkillSource');

export class ExtraFileSkillSource extends Disposable implements IExtraFileSkillSource {
  declare readonly _serviceBrand: undefined;

  readonly id = 'extra';
  readonly priority = SKILL_SOURCE_PRIORITY.extra;
  private readonly onDidChangeEmitter = this._register(new Emitter<void>());
  readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;
  private readonly watcher: SkillRootWatcher;

  constructor(
    @ISkillDiscovery private readonly discovery: ISkillDiscovery,
    @IConfigService private readonly config: IConfigService,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostFsWatchService hostFsWatch: IHostFsWatchService,
  ) {
    super();
    this._register(
      this.config.onDidSectionChange((event) => {
        if (event.domain === EXTRA_SKILL_DIRS_SECTION) {
          this.onDidChangeEmitter.fire();
          void this.watcher.refresh();
        }
      }),
    );
    this.watcher = this._register(
      new SkillRootWatcher(
        hostFsWatch,
        () => this.watchCandidates(),
        () => this.onDidChangeEmitter.fire(),
      ),
    );
  }

  async load(): Promise<SkillContribution> {
    await this.config.ready;
    const extraSkillDirs = this.config.get<ExtraSkillDirsConfig>(EXTRA_SKILL_DIRS_SECTION) ?? [];
    return this.discovery.discover(
      await configuredRoots(extraSkillDirs, this.workspace.workDir, this.bootstrap.osHomeDir, 'extra'),
    );
  }

  private async watchCandidates(): Promise<readonly string[]> {
    await this.config.ready;
    const extraSkillDirs = this.config.get<ExtraSkillDirsConfig>(EXTRA_SKILL_DIRS_SECTION) ?? [];
    return configuredRootCandidates(extraSkillDirs, this.workspace.workDir, this.bootstrap.osHomeDir);
  }
}

registerScopedService(
  LifecycleScope.Session,
  IExtraFileSkillSource,
  ExtraFileSkillSource,
  InstantiationType.Eager,
  'sessionSkillCatalog',
);
