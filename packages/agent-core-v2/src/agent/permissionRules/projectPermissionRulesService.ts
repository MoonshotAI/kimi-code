import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { TimeoutTimer } from '#/_base/utils/timer';
import { subtreeWatchFilter } from '#/_base/utils/paths';
import { LifecycleScope } from '#/app/scopes';
import { IProjectLocalConfigService } from '#/app/projectLocalConfig/projectLocalConfig';
import { LOCAL_ENVIRONMENT_ID } from '#/environment/environment';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionWorkdir } from '#/session/workdir/workdir';
import { watchCandidates } from '#human/utils/watch';

import { PermissionRuleSchema } from './configSection';
import type { PermissionRule } from './permissionRules';
import { IProjectPermissionRulesService } from './projectPermissionRules';

const WATCH_DEBOUNCE_MS = 200;

export class ProjectPermissionRulesService extends Disposable implements IProjectPermissionRulesService {
  declare readonly _serviceBrand: undefined;

  private readonly cwd: string;
  private projectRoot: string;
  private configPath: string;
  private currentRules: readonly PermissionRule[] = [];
  readonly ready: Promise<void>;
  private readonly watchDebounce = this._register(new TimeoutTimer());
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    @ISessionContext session: ISessionContext,
    @ISessionWorkdir private readonly workdir: ISessionWorkdir,
    @IProjectLocalConfigService private readonly localConfig: IProjectLocalConfigService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this.cwd = workdir.cwd ?? session.cwd;
    this.projectRoot = this.cwd;
    this.configPath = '';
    this.ready = this.enqueue(() => this.reloadFromDisk());
    void this.ready.then(() => {
      this.watchLocalToml();
    });
  }

  get rules(): readonly PermissionRule[] {
    return this.currentRules;
  }

  appendRules(rules: readonly PermissionRule[]): Promise<void> {
    return this.enqueue(async () => {
      const appended = await this.localConfig.appendPermissionRules(this.cwd, rules);
      this.projectRoot = appended.projectRoot;
      this.configPath = appended.configPath;
      this.currentRules = parseProjectPermissionRules(appended.rules, this.log);
    });
  }

  private async reloadFromDisk(): Promise<void> {
    try {
      const loaded = await this.localConfig.readPermissionRules(this.cwd);
      this.projectRoot = loaded.projectRoot;
      this.configPath = loaded.configPath;
      this.currentRules = parseProjectPermissionRules(loaded.rules, this.log);
    } catch (error) {
      this.log.warn(`project permission rules load failed: ${String(error)}`);
      this.currentRules = [];
    }
  }

  private watchLocalToml(): void {
    if (this.workdir.environmentId !== LOCAL_ENVIRONMENT_ID || this.configPath === '') return;
    try {
      const handle = watchCandidates(this.projectRoot, [this.configPath], {
        ignored: subtreeWatchFilter(this.projectRoot, [this.configPath]),
      });
      this._register(handle);
      this._register(
        handle.onDidChange(() => {
          this.watchDebounce.cancelAndSet(() => {
            void this.enqueue(() => this.reloadFromDisk()).catch((error) => {
              this.log.warn(`local.toml permission rules reload failed: ${String(error)}`);
            });
          }, WATCH_DEBOUNCE_MS);
        }),
      );
    } catch (error) {
      this.log.warn(`cannot watch project-local config ${this.configPath}: ${String(error)}`);
    }
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

function parseProjectPermissionRules(
  raw: readonly unknown[],
  log: ILogService,
): readonly PermissionRule[] {
  const rules: PermissionRule[] = [];
  for (const entry of raw) {
    const withDefault =
      typeof entry === 'object' && entry !== null && !Array.isArray(entry)
        ? { scope: 'project', ...entry }
        : entry;
    const parsed = PermissionRuleSchema.safeParse(withDefault);
    if (parsed.success) {
      rules.push(parsed.data);
    } else {
      log.warn(`ignoring invalid project permission rule: ${JSON.stringify(entry)}`);
    }
  }
  return rules;
}

registerScopedService(
  LifecycleScope.Session,
  IProjectPermissionRulesService,
  ProjectPermissionRulesService,
  ScopeActivation.OnScopeCreated,
  'projectPermissionRules',
);
