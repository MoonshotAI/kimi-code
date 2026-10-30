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

export class ProjectPermissionRulesService implements IProjectPermissionRulesService {
  declare readonly _serviceBrand: undefined;

  private readonly cwd: string;
  private readonly local: boolean;
  private currentRules: readonly PermissionRule[] = [];
  private trusted = false;
  readonly ready: Promise<void>;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    @ISessionContext session: ISessionContext,
    @ISessionWorkdir workdir: ISessionWorkdir,
    @IProjectLocalConfigService private readonly localConfig: IProjectLocalConfigService,
    @IWorkspaceTrust private readonly trust: IWorkspaceTrust,
  ) {
    this.cwd = workdir.cwd ?? session.cwd;
    this.local = workdir.environmentId === LOCAL_ENVIRONMENT_ID;
    this.ready = this.local ? this.enqueue(() => this.loadFromDisk()) : Promise.resolve();
  }

  get rules(): readonly PermissionRule[] {
    return this.currentRules;
  }

  appendRules(rules: readonly PermissionRule[]): Promise<void> {
    if (!this.local) {
      return Promise.reject(new Error('Project permission rules are not supported in remote environments'));
    }
    return this.enqueue(async () => {
      const appended = await this.localConfig.appendPermissionRules(this.cwd, rules);
      if (this.trusted) this.currentRules = parseProjectPermissionRules(appended.rules);
    });
  }

  private async loadFromDisk(): Promise<void> {
    this.trusted = await this.trust.get();
    if (!this.trusted) return;
    const loaded = await this.localConfig.readPermissionRules(this.cwd);
    this.currentRules = parseProjectPermissionRules(loaded.rules);
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(work, work);
    this.mutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
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
