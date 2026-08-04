/**
 * `skillCatalog` domain — user/brand `ISkillSource` producer.
 *
 * Discovers user skills from the bootstrap home directories through
 * `ISkillDiscovery`, contributing them at priority 20 (above extra / plugin /
 * builtin, below workspace). Reads home paths from `bootstrap`. Watches the
 * candidate root paths (existing or not) through a `SkillRootWatcher` and
 * re-fires `onDidChange` on debounced fs changes. Bound at App scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostFsWatchService } from '#/os/interface/hostFsWatch';

import {
  MERGE_ALL_AVAILABLE_SKILLS_SECTION,
  type MergeAllAvailableSkillsConfig,
} from './configSection';
import { ISkillDiscovery } from './skillDiscovery';
import { SkillRootWatcher } from './skillRootWatch';
import { resolveUserSkillRoots } from './skillRoots';
import {
  isSkillLoadAborted,
  SKILL_SOURCE_PRIORITY,
  type ISkillSource,
  type SkillContribution,
} from './skillSource';

export interface IUserFileSkillSource extends ISkillSource {
  readonly _serviceBrand: undefined;
}

export const IUserFileSkillSource: ServiceIdentifier<IUserFileSkillSource> =
  createDecorator<IUserFileSkillSource>('userFileSkillSource');

export class UserFileSkillSource extends Disposable implements IUserFileSkillSource {
  declare readonly _serviceBrand: undefined;

  readonly id = 'user';
  readonly priority = SKILL_SOURCE_PRIORITY.user;
  private readonly onDidChangeEmitter = this._register(new Emitter<void>());
  readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;
  private readonly watcher: SkillRootWatcher;

  constructor(
    @ISkillDiscovery private readonly discovery: ISkillDiscovery,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IConfigService private readonly config: IConfigService,
    @IHostFsWatchService hostFsWatch: IHostFsWatchService,
    @IHostFileSystem hostFs: IHostFileSystem,
  ) {
    super();
    this.watcher = this._register(
      new SkillRootWatcher(hostFsWatch, hostFs, () => {
        this.onDidChangeEmitter.fire();
      }),
    );
    this._register(
      this.config.onDidSectionChange((event) => {
        if (event.domain === MERGE_ALL_AVAILABLE_SKILLS_SECTION) this.onDidChangeEmitter.fire();
      }),
    );
  }

  async load(signal?: AbortSignal): Promise<SkillContribution> {
    if ((this.bootstrap.args.skillDirs?.length ?? 0) > 0) {
      return { skills: [] };
    }
    await this.config.ready;
    if (isSkillLoadAborted(signal)) return { skills: [] };
    const mergeAllAvailableSkills =
      this.config.get<MergeAllAvailableSkillsConfig>(MERGE_ALL_AVAILABLE_SKILLS_SECTION) ?? true;
    const resolution = await resolveUserSkillRoots(
      this.bootstrap.homeDir,
      this.bootstrap.osHomeDir,
      { mergeAllAvailableSkills },
    );
    if (isSkillLoadAborted(signal)) return { skills: [] };
    await this.watcher.setPaths(resolution.candidates);
    if (isSkillLoadAborted(signal)) return { skills: [] };
    return this.discovery.discover(resolution.roots, signal);
  }
}

registerScopedService(
  LifecycleScope.App,
  IUserFileSkillSource,
  UserFileSkillSource,
  ScopeActivation.OnScopeCreated,
  'skillCatalog',
);
