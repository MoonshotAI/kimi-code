import { assign, setup, type Snapshot } from 'xstate';

import {
  defineAgentRuntimeContract,
  defineAgentRuntimeProvider,
  type AgentRuntimeContext,
  type AgentRuntimeRestoreEvent,
} from '#/actor/agentRuntime';
import { IConfigService } from '#/app/config/config';

import { PERMISSION_SECTION, type PermissionConfig } from './configSection';
import { matchPermissionRule } from './internal/matchesRule';
import {
  PermissionRecordApprovalResult,
  PermissionRulesAdd,
  type PermissionRulesState,
} from './permissionRulesOps';
import type {
  ApprovalPattern,
  PermissionApprovalResultRecord,
  PermissionRequest,
  PermissionRule,
  PermissionRuleDecision,
  PermissionRuleMatch,
  PermissionRuleScope,
} from './types';

const USER_CONFIGURED_SCOPES: ReadonlySet<PermissionRuleScope> = new Set([
  'turn-override',
  'project',
  'user',
]);

interface PermissionRulesActorContext {
  readonly ledger: PermissionRulesState;
}

interface PermissionRulesCommitEvent {
  readonly type: 'permissionRules.commit';
  readonly ledger: PermissionRulesState;
}

type PermissionRulesActorSnapshot = Snapshot<unknown> & {
  readonly context: PermissionRulesActorContext;
};

const permissionRulesActorLogic = setup({
  types: {} as {
    context: PermissionRulesActorContext;
    input: AgentRuntimeContext<PermissionRulesState>;
    events: PermissionRulesCommitEvent | AgentRuntimeRestoreEvent;
  },
}).createMachine({
  context: () => ({
    ledger: { rules: [], sessionApprovalRulePatterns: [] },
  }),
  on: {
    'permissionRules.commit': {
      actions: assign({ ledger: ({ event }) => event.ledger }),
    },
  },
});

export class PermissionRulesRuntime {
  constructor(private readonly context: AgentRuntimeContext<PermissionRulesState>) {}

  rules(): readonly PermissionRule[] {
    return [...this.configRules(), ...this.context.getState().rules];
  }

  approvalPatterns(): readonly ApprovalPattern[] {
    return this.context.getState().sessionApprovalRulePatterns.map((pattern) => ({ pattern }));
  }

  addRules(rules: readonly PermissionRule[]): Promise<void> {
    if (rules.length === 0) return Promise.resolve();
    return this.context
      .dispatch(
        new PermissionRulesAdd({ agentId: this.context.agent.agentId, rules: [...rules] }),
      )
      .then(() => undefined);
  }

  recordApproval(record: PermissionApprovalResultRecord): Promise<void> {
    return this.context
      .dispatch(
        new PermissionRecordApprovalResult({ ...record, agentId: this.context.agent.agentId }),
      )
      .then(() => undefined);
  }

  evaluate(request: PermissionRequest): PermissionRuleDecision {
    if (this.evaluateRule(request, 'deny') !== undefined) return 'deny';
    if (this.evaluateApproval(request) !== undefined) return 'allow';
    if (this.evaluateRule(request, 'ask') !== undefined) return 'ask';
    if (this.evaluateRule(request, 'allow') !== undefined) return 'allow';
    return 'ask';
  }

  evaluateRule(
    request: PermissionRequest,
    decision: PermissionRuleDecision,
  ): PermissionRuleMatch | undefined {
    for (const rule of this.rules()) {
      if (rule.decision !== decision || !USER_CONFIGURED_SCOPES.has(rule.scope)) continue;
      const match = matchPermissionRule({
        rule,
        toolName: request.toolName,
        execution: request.execution,
      });
      if (match !== undefined) return match;
    }
    return undefined;
  }

  evaluateApproval(request: PermissionRequest): PermissionRuleMatch | undefined {
    for (const { pattern } of this.approvalPatterns()) {
      const match = matchPermissionRule({
        rule: {
          decision: 'allow',
          scope: 'session-runtime',
          pattern,
          reason: 'approve for session',
        },
        toolName: request.toolName,
        execution: request.execution,
      });
      if (match !== undefined) return match;
    }
    return undefined;
  }

  private configRules(): readonly PermissionRule[] {
    return this.context.get(IConfigService).get<PermissionConfig>(PERMISSION_SECTION)?.rules ?? [];
  }
}

export const AgentPermissionRules =
  defineAgentRuntimeContract<PermissionRulesRuntime>('permissionRules');

export const permissionRulesAgentRuntimeProvider = defineAgentRuntimeProvider<
  PermissionRulesState,
  PermissionRulesRuntime
>(AgentPermissionRules, {
  id: 'permissionRules',
  logic: permissionRulesActorLogic,
  durable: {
    events: [PermissionRulesAdd, PermissionRecordApprovalResult],
    undoable: false,
    transition: (state, event) => {
      if (event instanceof PermissionRulesAdd) {
        if (event.rules.length === 0) return;
        state.rules = [...state.rules, ...event.rules];
        return;
      }
      if (event instanceof PermissionRecordApprovalResult) {
        const pattern = event.sessionApprovalRule;
        if (
          event.result.decision !== 'approved' ||
          event.result.scope !== 'session' ||
          pattern === undefined ||
          state.sessionApprovalRulePatterns.includes(pattern)
        ) {
          return;
        }
        state.sessionApprovalRulePatterns = [...state.sessionApprovalRulePatterns, pattern];
      }
    },
    read: (snapshot) => (snapshot as PermissionRulesActorSnapshot).context.ledger,
    commit: (actor, ledger) => {
      actor.send({ type: 'permissionRules.commit', ledger });
    },
  },
  createApi: (context) => new PermissionRulesRuntime(context),
  inspect: (snapshot) => (snapshot as PermissionRulesActorSnapshot).context.ledger.rules.length,
});
