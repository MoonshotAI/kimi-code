import { LifecycleScope } from '#/app/scopes';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';

import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IConfigService } from '#/app/config/config';
import { IEventDispatcher } from '#/state/eventDispatcher';
import {
  IAgentPermissionRulesService,
  type PermissionApprovalResultRecord,
  type PermissionRule,
} from './permissionRules';
import {
  PERMISSION_SECTION,
  readUserPermissionRules,
  type PermissionConfig,
} from './configSection';
import { IProjectPermissionRulesService } from './projectPermissionRules';
import {
  PermissionRecordApprovalResult,
  PermissionRulesAdd,
  permissionRulesKey,
} from './permissionRulesOps';

export class AgentPermissionRulesService implements IAgentPermissionRulesService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentStateService private readonly agentState: IAgentStateService,
    @IConfigService private readonly config: IConfigService,
    @IProjectPermissionRulesService private readonly projectRules: IProjectPermissionRulesService,
  ) {
    this.agentState.contributeState(permissionRulesKey);
  }

  get rules(): readonly PermissionRule[] {
    return dedupePermissionRules([
      ...this.agentState.get(permissionRulesKey).rules,
      ...this.projectRules.rules,
      ...readUserPermissionRules(this.config),
    ]);
  }

  get sessionApprovalRulePatterns(): readonly string[] {
    return [...this.agentState.get(permissionRulesKey).sessionApprovalRulePatterns];
  }

  async addRules(rules: readonly PermissionRule[]): Promise<void> {
    if (rules.length === 0) return;
    const runtimeRules = rules.filter(
      (rule) => rule.scope === 'turn-override' || rule.scope === 'session-runtime',
    );
    const userRules = rules.filter((rule) => rule.scope === 'user');
    const projectRules = missingPermissionRules(
      this.projectRules.rules,
      rules.filter((rule) => rule.scope === 'project'),
    );
    const writes: Promise<void>[] = [];
    if (runtimeRules.length > 0) {
      writes.push(this.dispatcher.dispatch(
        new PermissionRulesAdd({ agentId: this.scopeContext.agentId, rules: runtimeRules }),
      ));
    }
    if (userRules.length > 0) {
      writes.push(enqueueUserConfigWrite(this.config, async () => {
        const current = this.config.get<PermissionConfig | undefined>(PERMISSION_SECTION);
        const existing = current?.rules ?? [];
        const appended = missingPermissionRules(existing, userRules);
        if (appended.length > 0) {
          await this.config.replace(PERMISSION_SECTION, {
            ...current,
            rules: [...existing, ...appended],
          });
        }
      }));
    }
    if (projectRules.length > 0) writes.push(this.projectRules.appendRules(projectRules));
    await Promise.all(writes);
  }

  recordApprovalResult(record: PermissionApprovalResultRecord): void {
    void this.dispatcher.dispatch(
      new PermissionRecordApprovalResult({
        ...record,
        agentId: this.scopeContext.agentId,
      }),
    );
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
