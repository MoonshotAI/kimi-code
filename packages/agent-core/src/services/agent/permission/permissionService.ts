import { stat, readFile } from 'node:fs/promises';
import * as nodePath from 'node:path';
import * as posixPath from 'node:path/posix';
import * as win32Path from 'node:path/win32';

import type {
  ApprovalResponse,
  PermissionData,
  PermissionRule,
  PermissionRuleDecision,
  PermissionRuleScope,
} from '../../../agent/permission';
import {
  matchPermissionRule,
  type PermissionRuleMatch,
} from '../../../agent/permission/matches-rule';
import {
  Disposable,
  IInstantiationService,
  registerSingleton,
  SyncDescriptor,
} from '../../../di';
import type {
  AuthorizeToolExecutionResult,
  ResolvedToolExecutionHookContext,
} from '../../../loop';
import type { ToolFileAccess } from '../../../loop/tool-access';
import type { ToolInputDisplay } from '../../../tools/display';
import {
  isWithinDirectory,
  type PathClass,
} from '../../../tools/policies/path-access';
import { isSensitiveFile } from '../../../tools/policies/sensitive';
import { IApprovalService } from '../../approval/approval';
import { IEventBus } from '../eventBus/eventBus';
import { IPermissionModeService } from '../permissionMode/permissionMode';
import { IPermissionRulesService } from '../permissionRules/permissionRules';
import { IProfileService } from '../profile/profile';
import {
  IPermissionService,
  type PermissionGitWorkTreeMarker,
  type PermissionServiceOptions,
} from './permission';

const USER_CONFIGURED_SCOPES = new Set<PermissionRuleScope>([
  'turn-override',
  'project',
  'user',
]);

const DEFAULT_APPROVE_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'ReadMediaFile',
  'SetTodoList',
  'TodoList',
  'TaskList',
  'TaskOutput',
  'CronList',
  'WebSearch',
  'FetchURL',
  'Agent',
  'AskUserQuestion',
  'Skill',
  'GetGoal',
  'SetGoalBudget',
  'UpdateGoal',
]);

type PermissionPolicyResolution =
  | PermissionPolicyResult
  | ({ readonly kind: 'result' } & AuthorizeToolExecutionResult);

type PermissionPolicyResult =
  | {
      readonly kind: 'approve';
      readonly executionMetadata?: unknown;
    }
  | {
      readonly kind: 'deny';
      readonly message?: string;
    }
  | {
      readonly kind: 'ask';
      readonly resolveApproval?: (
        result: ApprovalResponse,
      ) => PermissionPolicyResolution | undefined;
      readonly resolveError?: (error: unknown) => PermissionPolicyResolution | undefined;
    };

interface PolicyEvaluation {
  readonly policyName: string;
  readonly result: PermissionPolicyResult;
}

interface PlanReviewOption {
  readonly label: string;
  readonly description: string;
}

interface PlanReviewDisplay {
  readonly plan: string;
  readonly path?: string | undefined;
  readonly options?: readonly PlanReviewOption[] | undefined;
}

interface PlanModeRuntimeState {
  isActive: boolean;
  planFilePath: string | null;
}

export class PermissionService extends Disposable implements IPermissionService {
  private readonly planModeState: PlanModeRuntimeState;
  private swarmModeActive: boolean;

  constructor(
    private readonly options: PermissionServiceOptions = {},
    @IPermissionModeService private readonly modeService: IPermissionModeService,
    @IPermissionRulesService private readonly rulesService: IPermissionRulesService,
    @IEventBus private readonly events: IEventBus,
    @IProfileService private readonly profile: IProfileService,
    @IInstantiationService private readonly instantiation: IInstantiationService,
  ) {
    super();
    this.planModeState = {
      isActive: options.planMode?.isActive ?? false,
      planFilePath: options.planMode?.planFilePath ?? null,
    };
    this.swarmModeActive = options.swarmMode?.isActive ?? false;
    if (options.initialMode !== undefined) {
      this.modeService.setMode(options.initialMode);
    }
    this._register(
      this.events.on((event) => {
        if (event.type === 'plan_mode.changed') {
          this.planModeState.isActive = event.isActive;
          this.planModeState.planFilePath = event.planFilePath;
          return;
        }
        if (event.type === 'swarm_mode.changed') {
          this.swarmModeActive = event.active !== null;
        }
      }),
    );
  }

  data(): PermissionData {
    return {
      mode: this.modeService.mode,
      rules: [...this.rulesService.rules],
    };
  }

  async authorize(
    context: ResolvedToolExecutionHookContext,
  ): Promise<AuthorizeToolExecutionResult | undefined> {
    const evaluation = await this.evaluatePolicies(context);
    if (evaluation === undefined) return undefined;
    return this.permissionPolicyResolutionToAuthorize(
      evaluation.result,
      context,
      evaluation.policyName,
    );
  }

  private async evaluatePolicies(
    context: ResolvedToolExecutionHookContext,
  ): Promise<PolicyEvaluation | undefined> {
    const ordered: Array<
      [
        string,
        (
          context: ResolvedToolExecutionHookContext,
        ) => PermissionPolicyResult | undefined | Promise<PermissionPolicyResult | undefined>,
      ]
    > = [
      ['agent-swarm-exclusive-deny', (ctx) => this.agentSwarmExclusiveDeny(ctx)],
      ['auto-mode-ask-user-question-deny', (ctx) => this.autoModeAskUserQuestionDeny(ctx)],
      ['plan-mode-guard-deny', (ctx) => this.planModeGuardDeny(ctx)],
      ['user-configured-deny', (ctx) => this.userConfiguredRule(ctx, 'deny')],
      ['auto-mode-approve', () => this.autoModeApprove()],
      ['session-approval-history', (ctx) => this.sessionApprovalHistory(ctx)],
      ['user-configured-ask', (ctx) => this.userConfiguredRule(ctx, 'ask')],
      ['user-configured-allow', (ctx) => this.userConfiguredRule(ctx, 'allow')],
      ['exit-plan-mode-review-ask', (ctx) => this.exitPlanModeReviewAsk(ctx)],
      ['goal-start-review-ask', (ctx) => this.goalStartReviewAsk(ctx)],
      ['plan-mode-tool-approve', (ctx) => this.planModeToolApprove(ctx)],
      ['sensitive-file-access-ask', (ctx) => this.sensitiveFileAccessAsk(ctx)],
      ['git-control-path-access-ask', (ctx) => this.gitControlPathAccessAsk(ctx)],
      ['yolo-mode-approve', () => this.yoloModeApprove()],
      ['swarm-mode-agent-swarm-approve', (ctx) => this.swarmModeAgentSwarmApprove(ctx)],
      ['default-tool-approve', (ctx) => this.defaultToolApprove(ctx)],
      ['git-cwd-write-approve', (ctx) => this.gitCwdWriteApprove(ctx)],
      ['fallback-ask', () => ({ kind: 'ask' })],
    ];

    for (const [policyName, evaluate] of ordered) {
      const result = await evaluate(context);
      if (result !== undefined) return { policyName, result };
    }
    return undefined;
  }

  private agentSwarmExclusiveDeny(
    context: ResolvedToolExecutionHookContext,
  ): PermissionPolicyResult | undefined {
    const agentSwarmCount = context.toolCalls.filter(
      (toolCall) => toolCall.name === 'AgentSwarm',
    ).length;
    if (agentSwarmCount === 0) return undefined;
    if (agentSwarmCount === 1 && context.toolCalls.length === 1) return undefined;

    return {
      kind: 'deny',
      message:
        agentSwarmCount > 1
          ? multipleAgentSwarmDeniedMessage(context.toolCalls.length > agentSwarmCount)
          : mixedAgentSwarmDeniedMessage(),
    };
  }

  private autoModeAskUserQuestionDeny(
    context: ResolvedToolExecutionHookContext,
  ): PermissionPolicyResult | undefined {
    if (this.modeService.mode !== 'auto') return undefined;
    if (context.toolCall.name !== 'AskUserQuestion') return undefined;
    return {
      kind: 'deny',
      message:
        'AskUserQuestion is disabled while auto permission mode is active. Make a reasonable decision and continue without asking the user.',
    };
  }

  private planModeGuardDeny(
    context: ResolvedToolExecutionHookContext,
  ): PermissionPolicyResult | undefined {
    if (!this.planModeActive()) return undefined;

    const toolName = context.toolCall.name;
    if (toolName === 'Write' || toolName === 'Edit') {
      const planFilePath = this.planFilePath();
      if (planFilePath !== null && writesOnlyPlanFile(context, planFilePath)) return undefined;
      return {
        kind: 'deny',
        message: planModeWriteDeniedMessage(planFilePath),
      };
    }

    if (toolName === 'TaskStop') {
      return {
        kind: 'deny',
        message:
          'TaskStop is not available in plan mode. Call ExitPlanMode to exit plan mode before stopping a background task.',
      };
    }

    if (toolName === 'CronCreate' || toolName === 'CronDelete') {
      return {
        kind: 'deny',
        message:
          `${toolName} is not available in plan mode because it would mutate scheduled work that runs after plan exit. Call ExitPlanMode first.`,
      };
    }

    return undefined;
  }

  private userConfiguredRule(
    context: ResolvedToolExecutionHookContext,
    decision: PermissionRuleDecision,
  ): PermissionPolicyResult | undefined {
    const match = this.firstMatchingRule(context, decision, USER_CONFIGURED_SCOPES);
    if (match === undefined) return undefined;
    if (decision === 'deny') {
      return {
        kind: 'deny',
        message: this.formatPermissionRuleDenyMessage(context.toolCall.name, match.rule.reason),
      };
    }
    if (decision === 'ask') return { kind: 'ask' };
    return { kind: 'approve' };
  }

  private autoModeApprove(): PermissionPolicyResult | undefined {
    return this.modeService.mode === 'auto' ? { kind: 'approve' } : undefined;
  }

  private sessionApprovalHistory(
    context: ResolvedToolExecutionHookContext,
  ): PermissionPolicyResult | undefined {
    for (const pattern of this.rulesService.sessionApprovalRulePatterns) {
      const match = matchPermissionRule({
        rule: {
          decision: 'allow',
          scope: 'session-runtime',
          pattern,
          reason: 'approve for session',
        },
        toolName: context.toolCall.name,
        execution: context.execution,
      });
      if (match !== undefined) return { kind: 'approve' };
    }
    return undefined;
  }

  private exitPlanModeReviewAsk(
    context: ResolvedToolExecutionHookContext,
  ): PermissionPolicyResult | undefined {
    if (context.toolCall.name !== 'ExitPlanMode') return undefined;
    if (this.modeService.mode === 'auto') return undefined;
    if (!this.planModeActive()) return undefined;
    const display = context.execution.display;
    if (display?.kind !== 'plan_review') return undefined;
    if (display.plan.trim().length === 0) return undefined;
    return {
      kind: 'ask',
      resolveApproval: (result) =>
        this.exitPlanModeApprovalResult(result, {
          plan: display.plan,
          path: display.path,
          options: display.options,
        }),
    };
  }

  private goalStartReviewAsk(
    context: ResolvedToolExecutionHookContext,
  ): PermissionPolicyResult | undefined {
    if (context.toolCall.name !== 'CreateGoal') return undefined;
    if (this.modeService.mode === 'auto') return undefined;
    if (context.execution.display?.kind !== 'goal_start') return undefined;
    return {
      kind: 'ask',
      resolveApproval: (result) => {
        if (result.decision !== 'approved') return undefined;
        const mode = toPermissionMode(result.selectedLabel);
        if (mode !== undefined && mode !== this.modeService.mode) {
          this.modeService.setMode(mode);
        }
        return undefined;
      },
    };
  }

  private planModeToolApprove(
    context: ResolvedToolExecutionHookContext,
  ): PermissionPolicyResult | undefined {
    const toolName = context.toolCall.name;
    if (toolName === 'EnterPlanMode') return { kind: 'approve' };

    const planFilePath = this.planFilePath();
    if (
      (toolName === 'Write' || toolName === 'Edit') &&
      this.planModeActive() &&
      planFilePath !== null &&
      writesOnlyPlanFile(context, planFilePath)
    ) {
      return { kind: 'approve' };
    }

    if (toolName === 'ExitPlanMode') {
      if (!this.planModeActive()) return { kind: 'approve' };
      if (context.execution.display?.kind !== 'plan_review') return { kind: 'approve' };
      if (context.execution.display.plan.trim().length === 0) return { kind: 'approve' };
    }

    return undefined;
  }

  private sensitiveFileAccessAsk(
    context: ResolvedToolExecutionHookContext,
  ): PermissionPolicyResult | undefined {
    const access = fileAccesses(context).find((fileAccess) => isSensitiveFile(fileAccess.path));
    return access === undefined ? undefined : { kind: 'ask' };
  }

  private async gitControlPathAccessAsk(
    context: ResolvedToolExecutionHookContext,
  ): Promise<PermissionPolicyResult | undefined> {
    const cwd = this.cwd();
    if (cwd.length === 0) return undefined;
    const pathClass = this.pathClass();
    const accesses = fileAccesses(context);
    if (accesses.length === 0) return undefined;

    const directGitAccess = accesses.find((fileAccess) =>
      hasGitPathComponent(fileAccess.path, cwd, pathClass),
    );
    if (directGitAccess !== undefined) return { kind: 'ask' };

    const marker = await this.findGitWorkTreeMarker(cwd);
    if (marker === null) return undefined;
    const access = accesses.find((fileAccess) =>
      isGitControlPath(fileAccess.path, marker, pathClass),
    );
    return access === undefined ? undefined : { kind: 'ask' };
  }

  private yoloModeApprove(): PermissionPolicyResult | undefined {
    return this.modeService.mode === 'yolo' ? { kind: 'approve' } : undefined;
  }

  private swarmModeAgentSwarmApprove(
    context: ResolvedToolExecutionHookContext,
  ): PermissionPolicyResult | undefined {
    if (context.toolCall.name !== 'AgentSwarm') return undefined;
    return this.swarmModeIsActive() ? { kind: 'approve' } : undefined;
  }

  private defaultToolApprove(
    context: ResolvedToolExecutionHookContext,
  ): PermissionPolicyResult | undefined {
    return DEFAULT_APPROVE_TOOLS.has(context.toolCall.name)
      ? { kind: 'approve' }
      : undefined;
  }

  private async gitCwdWriteApprove(
    context: ResolvedToolExecutionHookContext,
  ): Promise<PermissionPolicyResult | undefined> {
    const toolName = context.toolCall.name;
    if (toolName !== 'Write' && toolName !== 'Edit') return undefined;
    if (this.pathClass() !== 'posix') return undefined;

    const cwd = this.cwd();
    if (cwd.length === 0) return undefined;

    const writeAccesses = writeFileAccesses(context);
    if (writeAccesses.length === 0) return undefined;
    if (!writeAccesses.every((access) => isWithinDirectory(access.path, cwd, 'posix'))) {
      return undefined;
    }

    return (await this.findGitWorkTreeMarker(cwd)) === null ? undefined : { kind: 'approve' };
  }

  private async permissionPolicyResolutionToAuthorize(
    result: PermissionPolicyResolution,
    context: ResolvedToolExecutionHookContext,
    policyName?: string,
  ): Promise<AuthorizeToolExecutionResult | undefined> {
    switch (result.kind) {
      case 'approve':
        return result.executionMetadata === undefined
          ? undefined
          : { executionMetadata: result.executionMetadata };
      case 'deny':
        return {
          block: true,
          reason: result.message ?? this.formatPolicyDenyMessage(context.toolCall.name),
        };
      case 'ask':
        return this.requestToolApproval(context, result, policyName);
      case 'result': {
        const { kind: _kind, ...authorizeResult } = result;
        return authorizeResult;
      }
    }
  }

  private async requestToolApproval(
    context: ResolvedToolExecutionHookContext,
    result: Extract<PermissionPolicyResult, { kind: 'ask' }>,
    _policyName: string | undefined,
  ): Promise<AuthorizeToolExecutionResult | undefined> {
    const name = context.toolCall.name;
    const action = context.execution.description ?? `Call ${name}`;
    const display =
      context.execution.display ??
      ({
        kind: 'generic',
        summary: action,
        detail: context.args,
      } as ToolInputDisplay);

    let response: ApprovalResponse;
    const approvalService = this.tryApprovalService();
    if (approvalService === undefined) {
      response = { decision: 'approved' };
    } else {
      try {
        response = await approvalService.request({
          sessionId: this.options.sessionId ?? 'service-session',
          agentId: this.options.agentId ?? 'main',
          turnId: numericTurnId(context.turnId),
          toolCallId: context.toolCall.id,
          toolName: name,
          action,
          display,
        });
        context.signal.throwIfAborted();
      } catch (error) {
        const resolved = result.resolveError?.(error);
        if (resolved !== undefined) {
          return this.permissionPolicyResolutionToAuthorize(resolved, context, _policyName);
        }
        throw error;
      }
    }

    const sessionApprovalRule =
      response.decision === 'approved' && response.scope === 'session'
        ? context.execution.approvalRule
        : undefined;
    this.rulesService.recordApprovalResult({
      turnId: numericTurnId(context.turnId),
      toolCallId: context.toolCall.id,
      toolName: name,
      action,
      sessionApprovalRule,
      result: response,
    });

    const resolved = result.resolveApproval?.(response);
    if (resolved !== undefined) {
      return this.permissionPolicyResolutionToAuthorize(resolved, context, _policyName);
    }

    if (response.decision === 'approved') return undefined;
    return {
      block: true,
      reason: this.formatApprovalRejectionMessage(name, response),
    };
  }

  private exitPlanModeApprovalResult(
    result: ApprovalResponse,
    display: PlanReviewDisplay,
  ): PermissionPolicyResolution | undefined {
    if (result.decision !== 'approved') {
      return this.rejectedExitPlanModeApprovalResult(result);
    }

    const selected = selectedExitPlanModeOption(display.options, result.selectedLabel);
    const failed = this.exitPlanMode();
    if (failed !== undefined) {
      return { kind: 'result', syntheticResult: failed };
    }

    const optionPrefix =
      selected === undefined
        ? ''
        : `Selected approach: ${selected.label}\nExecute ONLY the selected approach. Do not execute any unselected alternatives.\n\n`;
    const savedTo = display.path !== undefined ? `Plan saved to: ${display.path}\n\n` : '';
    const formattedPlan = `Plan mode deactivated. All tools are now available.\n${savedTo}## Approved Plan:\n${display.plan}`;
    return {
      kind: 'result',
      syntheticResult: {
        isError: false,
        output: `Exited plan mode. ${optionPrefix}${formattedPlan}`,
      },
    };
  }

  private rejectedExitPlanModeApprovalResult(
    result: ApprovalResponse,
  ): PermissionPolicyResolution {
    if (result.decision === 'cancelled') {
      return {
        kind: 'result',
        syntheticResult: {
          isError: false,
          output: 'Plan approval dismissed. Plan mode remains active.',
        },
      };
    }

    if (result.selectedLabel === 'Reject and Exit') {
      const failed = this.exitPlanMode();
      return {
        kind: 'result',
        syntheticResult:
          failed ?? {
            isError: true,
            stopTurn: true,
            output: 'Plan rejected by user. Plan mode deactivated.',
          },
      };
    }

    const feedback = result.feedback ?? '';
    if (result.selectedLabel === 'Revise' || feedback.length > 0) {
      return {
        kind: 'result',
        syntheticResult: {
          isError: false,
          output:
            feedback.length > 0
              ? `User rejected the plan. Feedback:\n\n${feedback}`
              : 'User requested revisions. Plan mode remains active.',
        },
      };
    }

    return {
      kind: 'result',
      syntheticResult: {
        isError: true,
        stopTurn: true,
        output: 'Plan rejected by user. Plan mode remains active.',
      },
    };
  }

  private exitPlanMode(): { readonly isError: true; readonly output: string } | undefined {
    const planMode = this.options.planMode;
    if (planMode === undefined) return undefined;
    try {
      planMode.exit();
      return undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to exit plan mode.';
      return {
        isError: true,
        output: `Failed to exit plan mode: ${message}`,
      };
    }
  }

  private firstMatchingRule(
    context: ResolvedToolExecutionHookContext,
    decision: PermissionRuleDecision,
    scopes: ReadonlySet<PermissionRuleScope>,
  ): PermissionRuleMatch | undefined {
    const rules = this.rulesService.rules.filter((rule): rule is PermissionRule =>
      scopes.has(rule.scope),
    );
    for (const rule of rules) {
      if (rule.decision !== decision) continue;
      const match = matchPermissionRule({
        rule,
        toolName: context.toolCall.name,
        execution: context.execution,
      });
      if (match !== undefined) return match;
    }
    return undefined;
  }

  private planModeActive(): boolean {
    return this.options.planMode?.isActive ?? this.planModeState.isActive;
  }

  private planFilePath(): string | null {
    return this.options.planMode?.planFilePath ?? this.planModeState.planFilePath;
  }

  private swarmModeIsActive(): boolean {
    return this.options.swarmMode?.isActive ?? this.swarmModeActive;
  }

  private cwd(): string {
    return this.options.cwd ?? this.profile.data().cwd ?? '';
  }

  private pathClass(): PathClass {
    return this.options.pathClass ?? defaultPathClass();
  }

  private async findGitWorkTreeMarker(cwd: string): Promise<PermissionGitWorkTreeMarker | null> {
    if (this.options.gitWorkTreeMarker !== undefined) {
      return this.options.gitWorkTreeMarker(cwd);
    }
    return findLocalGitWorkTreeMarker(cwd);
  }

  private tryApprovalService(): IApprovalService | undefined {
    try {
      return this.instantiation.invokeFunction(
        (accessor) => accessor.get(IApprovalService) as IApprovalService | undefined,
      );
    } catch {
      return undefined;
    }
  }

  private formatPermissionRuleDenyMessage(
    tool: string,
    reason: string | undefined,
  ): string {
    const suffix = reason !== undefined && reason.length > 0 ? ` Reason: ${reason}` : '';
    if (this.options.agentType === 'sub') {
      return `Tool "${tool}" was denied.${suffix} Try a different approach — don't retry the same call, don't attempt to bypass the restriction.`;
    }
    return `Tool "${tool}" was denied by permission rule.${suffix}`;
  }

  private formatApprovalRejectionMessage(
    toolName: string,
    result: { decision: 'approved' | 'rejected' | 'cancelled'; feedback?: string },
  ): string {
    const suffix =
      result.feedback !== undefined && result.feedback.length > 0
        ? ` Reason: ${result.feedback}`
        : '';
    const prefix =
      result.decision === 'cancelled'
        ? `Tool "${toolName}" was not run because the approval request was cancelled.`
        : `Tool "${toolName}" was not run because the user rejected the approval request.`;
    if (this.options.agentType === 'sub') {
      return `${prefix}${suffix} Try a different approach — don't retry the same call, don't attempt to bypass the restriction.`;
    }
    return `${prefix}${suffix}`;
  }

  private formatPolicyDenyMessage(toolName: string): string {
    const prefix = `Tool "${toolName}" was denied by permission policy.`;
    if (this.options.agentType === 'sub') {
      return `${prefix} Try a different approach — don't retry the same call, don't attempt to bypass the restriction.`;
    }
    return prefix;
  }
}

function fileAccesses(context: ResolvedToolExecutionHookContext): ToolFileAccess[] {
  return (
    context.execution.accesses?.filter((access): access is ToolFileAccess => access.kind === 'file') ??
    []
  );
}

function writeFileAccesses(context: ResolvedToolExecutionHookContext): ToolFileAccess[] {
  return fileAccesses(context).filter(
    (access) => access.operation === 'write' || access.operation === 'readwrite',
  );
}

function writesOnlyPlanFile(
  context: ResolvedToolExecutionHookContext,
  planFilePath: string,
): boolean {
  const writeAccesses = writeFileAccesses(context);
  if (writeAccesses.length === 0) return false;
  return writeAccesses.every((access) => access.path === planFilePath);
}

function planModeWriteDeniedMessage(planFilePath: string | null): string {
  return (
    `Plan mode is active. You may only write to the current plan file: ${planFilePath ?? '(no plan file selected yet)'}. ` +
    'Call ExitPlanMode to exit plan mode before editing other files.'
  );
}

function hasGitPathComponent(
  targetPath: string,
  cwd: string,
  pathClass: PathClass,
): boolean {
  return relativePathParts(targetPath, cwd, pathClass).some(
    (part) => part.toLowerCase() === '.git',
  );
}

function isGitControlPath(
  targetPath: string,
  marker: PermissionGitWorkTreeMarker,
  pathClass: PathClass,
): boolean {
  return (
    isWithinDirectory(targetPath, marker.dotGitPath, pathClass) ||
    isWithinDirectory(targetPath, marker.controlDirPath, pathClass)
  );
}

function relativePathParts(targetPath: string, cwd: string, pathClass: PathClass): string[] {
  return pathMod(pathClass)
    .relative(cwd, targetPath)
    .split(/[\\/]+/)
    .filter((part) => part.length > 0);
}

function pathMod(pathClass: PathClass): typeof posixPath {
  return pathClass === 'win32' ? win32Path : posixPath;
}

function defaultPathClass(): PathClass {
  return process.platform === 'win32' ? 'win32' : 'posix';
}

function toPermissionMode(label: string | undefined): 'manual' | 'yolo' | 'auto' | undefined {
  if (label === 'auto' || label === 'yolo' || label === 'manual') return label;
  return undefined;
}

function selectedExitPlanModeOption(
  options: readonly PlanReviewOption[] | undefined,
  label: string | undefined,
): PlanReviewOption | undefined {
  if (options === undefined || label === undefined) return undefined;
  return options.find((option) => option.label === label);
}

function numericTurnId(turnId: string): number {
  const numeric = Number(turnId);
  return Number.isFinite(numeric) ? numeric : 0;
}

function multipleAgentSwarmDeniedMessage(hasOtherToolCalls: boolean): string {
  const suffix = hasOtherToolCalls
    ? ' AgentSwarm also must not be combined with other tools in the same response.'
    : '';
  return (
    'AgentSwarm must be called one swarm at a time. Multiple AgentSwarm calls are not forbidden, ' +
    'but issue them sequentially: call one AgentSwarm, wait for its result, then call the next; ' +
    `or merge the work into a single AgentSwarm when one swarm can cover it.${suffix}`
  );
}

function mixedAgentSwarmDeniedMessage(): string {
  return (
    'AgentSwarm must be the only tool call in a model response. Retry with a single AgentSwarm ' +
    'call by itself, then call any other tools after it returns.'
  );
}

async function findLocalGitWorkTreeMarker(
  cwd: string,
): Promise<PermissionGitWorkTreeMarker | null> {
  if (cwd.length === 0 || !nodePath.isAbsolute(cwd)) return null;

  let current = nodePath.normalize(cwd);
  for (let depth = 0; depth < 256; depth += 1) {
    const dotGitPath = nodePath.join(current, '.git');
    const marker = await probeLocalGitMarker(dotGitPath, current);
    if (marker !== null) return marker;

    const parent = nodePath.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

async function probeLocalGitMarker(
  dotGitPath: string,
  markerParent: string,
): Promise<PermissionGitWorkTreeMarker | null> {
  try {
    const markerStat = await stat(dotGitPath);
    if (markerStat.isDirectory()) return { dotGitPath, controlDirPath: dotGitPath };
    if (!markerStat.isFile()) return null;

    const content = await readFile(dotGitPath, 'utf8');
    const controlDirPath = parseLocalGitDir(content, markerParent);
    return controlDirPath === undefined ? null : { dotGitPath, controlDirPath };
  } catch {
    return null;
  }
}

function parseLocalGitDir(content: string, markerParent: string): string | undefined {
  const stripped = content.codePointAt(0) === 0xfeff ? content.slice(1) : content;
  const line = stripped.trimStart().split(/\r?\n/, 1)[0]?.trim();
  if (line === undefined || !line.startsWith('gitdir:')) return undefined;

  const rawPath = line.slice('gitdir:'.length).trim();
  if (rawPath.length === 0) return undefined;
  return nodePath.normalize(
    nodePath.isAbsolute(rawPath) ? rawPath : nodePath.join(markerParent, rawPath),
  );
}

registerSingleton(
  IPermissionService,
  new SyncDescriptor(PermissionService, [{}], true),
);
