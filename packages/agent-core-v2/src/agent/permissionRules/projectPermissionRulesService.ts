import { AsyncSerialQueue } from '#/_base/utils/promise';
import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IProjectLocalConfigService } from '#/app/projectLocalConfig/projectLocalConfig';
import { ErrorCodes, Error2 } from '#/errors';
import { LOCAL_ENVIRONMENT_ID } from '#/environment/environment';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionWorkdir } from '#/session/workdir/workdir';
import { IWorkspaceTrust } from '#/workspace/workspaceTrust/workspaceTrust';

import { PersistedPermissionRuleSchema } from './configSection';
import type { PermissionRule } from './permissionRules';
import { IProjectPermissionRulesService } from './projectPermissionRules';

export class ProjectPermissionRulesService extends Disposable implements IProjectPermissionRulesService {
  declare readonly _serviceBrand: undefined;

  private readonly cwd: string;
  private readonly local: boolean;
  private currentRules: readonly PermissionRule[] = [];
  private loadError?: Error;
  readonly ready: Promise<void>;
  private readonly mutations = new AsyncSerialQueue();

  constructor(
    @ISessionContext session: ISessionContext,
    @ISessionWorkdir workdir: ISessionWorkdir,
    @IProjectLocalConfigService private readonly localConfig: IProjectLocalConfigService,
    @IWorkspaceTrust private readonly trust: IWorkspaceTrust,
  ) {
    super();
    this.cwd = workdir.cwd ?? session.cwd;
    this.local = workdir.environmentId === LOCAL_ENVIRONMENT_ID;
    this.ready = this.local ? this.mutations.run(() => this.loadFromDisk()) : Promise.resolve();
    if (this.local) {
      const reload = (): void => {
        this.currentRules = [];
        this.loadError = undefined;
        void this.mutations.run(() => this.loadFromDisk()).catch((error: unknown) => {
          this.loadError = error instanceof Error ? error : new Error(String(error));
        });
      };
      this._register(trust.onDidChange(reload));
      this._register(workdir.dirs.onDidChangeLocalConfig(reload));
    }
  }

  get rules(): readonly PermissionRule[] {
    if (!this.local || !this.trust.isTrusted()) return [];
    if (this.loadError !== undefined) throw this.loadError;
    return this.currentRules;
  }

  async refreshTrust(): Promise<void> {
    if (!this.local) return;
    if (this.currentRules.length > 0 || this.loadError !== undefined) await this.trust.get();
    await this.mutations.settled;
  }

  appendRules(rules: readonly PermissionRule[]): Promise<void> {
    if (!this.local) {
      return Promise.reject(new Error('Project permission rules are not supported in remote environments'));
    }
    return this.mutations.run(async () => {
      parseProjectPermissionRules(rules);
      const appended = await this.localConfig.appendPermissionRules(this.cwd, rules);
      if (this.trust.isTrusted()) {
        this.currentRules = parseProjectPermissionRules(appended.rules, appended.configPath);
        this.loadError = undefined;
      }
    });
  }

  private async loadFromDisk(): Promise<void> {
    if (!(await this.trust.get())) return;
    const loaded = await this.localConfig.readPermissionRules(this.cwd);
    this.currentRules = parseProjectPermissionRules(loaded.rules, loaded.configPath);
    this.loadError = undefined;
  }
}

function parseProjectPermissionRules(raw: readonly unknown[], path?: string): readonly PermissionRule[] {
  try {
    return raw.map((entry) => PersistedPermissionRuleSchema.parse(
      typeof entry === 'object' && entry !== null && !Array.isArray(entry)
        ? { scope: 'project', ...entry }
        : entry,
    ));
  } catch (error) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, path === undefined ? 'Invalid project permission rule' : `Invalid project permission rule in ${path}`, { cause: error });
  }
}

registerScopedService(
  LifecycleScope.Session,
  IProjectPermissionRulesService,
  ProjectPermissionRulesService,
  ScopeActivation.OnScopeCreated,
  'projectPermissionRules',
);
