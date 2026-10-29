import { LifecycleScope } from '#/app/scopes';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';

import { ILogService } from '#/_base/log/log';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IConfigService } from '#/app/config/config';
import { IEventDispatcher } from '#/state/eventDispatcher';
import {
  IAgentPermissionRulesService,
  type PermissionApprovalResultRecord,
  type PermissionRule,
} from './permissionRules';
import { PERMISSION_SECTION, type PermissionConfig } from './configSection';
import { IProjectPermissionRulesService } from './projectPermissionRules';
import {
  PermissionRecordApprovalResult,
  PermissionRulesAdd,
  permissionRulesKey,
} from './permissionRulesOps';

export class AgentPermissionRulesService implements IAgentPermissionRulesService {
  declare readonly _serviceBrand: undefined;

  private persistTail: Promise<void> = Promise.resolve();

  constructor(
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentStateService private readonly agentState: IAgentStateService,
    @IConfigService private readonly config: IConfigService,
    @IProjectPermissionRulesService private readonly projectRules: IProjectPermissionRulesService,
    @ILogService private readonly log: ILogService,
  ) {
    this.agentState.contributeState(permissionRulesKey);
  }

  get rules(): readonly PermissionRule[] {
    const configRules = this.config.get<PermissionConfig | undefined>(PERMISSION_SECTION)?.rules ?? [];
    return dedupePermissionRules([
      ...this.agentState.get(permissionRulesKey).rules,
      ...this.projectRules.rules,
      ...configRules,
    ]);
  }

  get sessionApprovalRulePatterns(): readonly string[] {
    return [...this.agentState.get(permissionRulesKey).sessionApprovalRulePatterns];
  }

  addRules(rules: readonly PermissionRule[]): void {
    if (rules.length === 0) return;
    void this.dispatcher.dispatch(
      new PermissionRulesAdd({ agentId: this.scopeContext.agentId, rules: [...rules] }),
    );
    const userRules = rules.filter((rule) => rule.scope === 'user');
    const projectScopedRules = rules.filter((rule) => rule.scope === 'project');
    if (userRules.length === 0 && projectScopedRules.length === 0) return;
    this.persistTail = this.persistTail.then(
      () => this.persistRules(userRules, projectScopedRules),
      () => this.persistRules(userRules, projectScopedRules),
    );
  }

  recordApprovalResult(record: PermissionApprovalResultRecord): void {
    void this.dispatcher.dispatch(
      new PermissionRecordApprovalResult({
        ...record,
        agentId: this.scopeContext.agentId,
      }),
    );
  }

  private async persistRules(
    userRules: readonly PermissionRule[],
    projectRules: readonly PermissionRule[],
  ): Promise<void> {
    if (userRules.length > 0) {
      try {
        await enqueueUserConfigWrite(this.config, async () => {
          const current = this.config.get<PermissionConfig | undefined>(PERMISSION_SECTION);
          const existing = current?.rules ?? [];
          const appended = missingPermissionRules(existing, userRules);
          if (appended.length > 0) {
            await this.config.replace(PERMISSION_SECTION, {
              ...current,
              rules: [...existing, ...appended],
            });
          }
        });
      } catch (error) {
        this.log.warn(`failed to persist user permission rules: ${String(error)}`);
      }
    }
    if (projectRules.length > 0) {
      try {
        const appended = missingPermissionRules(this.projectRules.rules, projectRules);
        if (appended.length > 0) {
          await this.projectRules.appendRules(appended);
        }
      } catch (error) {
        this.log.warn(`failed to persist project permission rules: ${String(error)}`);
      }
    }
  }
}

const userConfigWriteTails = new WeakMap<IConfigService, Promise<void>>();

function enqueueUserConfigWrite(config: IConfigService, work: () => Promise<void>): Promise<void> {
  const previous = userConfigWriteTails.get(config) ?? Promise.resolve();
  const run = previous.then(work, work);
  userConfigWriteTails.set(config, run.then(
    () => undefined,
    () => undefined,
  ));
  return run;
}

function permissionRuleKey(rule: PermissionRule): string {
  return `${rule.decision}\u0000${rule.scope}\u0000${rule.pattern}\u0000${rule.reason ?? ''}`;
}

function missingPermissionRules(
  existing: readonly PermissionRule[],
  rules: readonly PermissionRule[],
): PermissionRule[] {
  const seen = new Set(existing.map(permissionRuleKey));
  const out: PermissionRule[] = [];
  for (const rule of rules) {
    const key = permissionRuleKey(rule);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rule);
  }
  return out;
}

function dedupePermissionRules(rules: readonly PermissionRule[]): PermissionRule[] {
  return missingPermissionRules([], rules);
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentPermissionRulesService,
  AgentPermissionRulesService,
  ScopeActivation.OnScopeCreated,
  'permissionRules',
);
