import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { SerialQueue } from '#/_base/utils/serialQueue';
import { LifecycleScope } from '#/app/scopes';
import { IProjectLocalConfigService } from '#/app/projectLocalConfig/projectLocalConfig';
import { ErrorCodes, Error2 } from '#/errors';
import { LOCAL_ENVIRONMENT_ID } from '#/environment/environment';
import { ISessionWorkdir } from '#/session/workdir/workdir';
import { IWorkspaceTrust } from '#/workspace/workspaceTrust/workspaceTrust';

import { PersistedPermissionRuleSchema } from './configSection';
import type { PermissionRule } from './permissionRules';
import { IProjectPermissionRulesService } from './projectPermissionRules';

export class ProjectPermissionRulesService extends Disposable implements IProjectPermissionRulesService {
  declare readonly _serviceBrand: undefined;

  private readonly local: boolean;
  private currentRules: readonly PermissionRule[] = [];
  private trusted = false;
  readonly ready: Promise<void>;
  private readonly mutations = new SerialQueue();

  constructor(
    @ISessionWorkdir private readonly workdir: ISessionWorkdir,
    @IProjectLocalConfigService private readonly localConfig: IProjectLocalConfigService,
    @IWorkspaceTrust private readonly trust: IWorkspaceTrust,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this.local = workdir.environmentId === LOCAL_ENVIRONMENT_ID;
    this.ready = this.local ? this.mutations.run(() => this.loadFromDisk()) : Promise.resolve();
    if (this.local) {
      this._register(workdir.onDidChangeAnchor(() => {
        this.reloadAtMovedAnchor();
      }));
    }
  }

  get rules(): readonly PermissionRule[] {
    return this.currentRules;
  }

  appendRules(rules: readonly PermissionRule[]): Promise<void> {
    if (!this.local) {
      return Promise.reject(new Error('Project permission rules are not supported in remote environments'));
    }
    return this.mutations.run(async () => {
      parseProjectPermissionRules(rules);
      const appended = await this.localConfig.appendPermissionRules(this.workdir.anchor, rules);
      if (this.trusted) this.currentRules = parseProjectPermissionRules(appended.rules);
    });
  }

  private async loadFromDisk(): Promise<void> {
    this.trusted = await this.trust.get();
    this.currentRules = this.trusted
      ? parseProjectPermissionRules((await this.localConfig.readPermissionRules(this.workdir.anchor)).rules)
      : [];
  }

  private reloadAtMovedAnchor(): void {
    void this.mutations.run(async () => {
      try {
        await this.loadFromDisk();
      } catch (error) {
        this.log.warn('project permission rules reload failed; keeping the rules in effect', { anchor: this.workdir.anchor, error });
      }
    });
  }
}

function parseProjectPermissionRules(raw: readonly unknown[]): readonly PermissionRule[] {
  try {
    return raw.map((entry) => PersistedPermissionRuleSchema.parse(
      typeof entry === 'object' && entry !== null && !Array.isArray(entry)
        ? { scope: 'project', ...entry }
        : entry,
    ));
  } catch (error) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, 'Invalid project permission rule', { cause: error });
  }
}

registerScopedService(
  LifecycleScope.Session,
  IProjectPermissionRulesService,
  ProjectPermissionRulesService,
  ScopeActivation.OnScopeCreated,
  'projectPermissionRules',
);
