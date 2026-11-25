import { ref, type LiveRef } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { ILogService } from '#/_base/log/log';
import { abortable, createDeadlineAbortSignal } from '#/_base/utils/abort';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPermissionGate } from '#/agent/permissionGate/permissionGate';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentPermissionPolicyService } from '#/agent/permissionPolicy/permissionPolicy';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { subagentParentAgentId } from '#/session/agentLifecycle/subagentMetadata';
import { ISessionWorkdir } from '#/session/workdir/workdir';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IEventDispatcher } from '#/state/eventDispatcher';
import type { Message } from '@moonshot-ai/core/llm/message';

import {
  AutoReviewAncestryRecorded,
  AutoReviewCompleted,
  AutoReviewStarted,
  autoReviewAncestryKey,
  autoReviewApprovedCallsKey,
  type AutoReviewAncestry,
} from './autoReviewEvents';
import { createAutoReviewReviewer } from './autoReviewGate';
import { AUTO_REVIEW_SECTION, type AutoReviewConfig } from './configSection';
import {
  buildReviewMessages,
  detectAuthorizationDrift,
  extractAuthorization,
  type ReviewGitStatus,
  type ReviewText,
} from './context';
import {
  IAutoReviewService,
  ISessionAutoReviewService,
  type AutoReviewOutcome,
} from './review';

const MAX_GIT_STATUS_ENTRIES = 50;
const AUTHORIZATION_CHANGED_REASON = 'Authorization changed during review.';
const EMPTY_ANCESTRY: AutoReviewAncestry = { authorization: [], approvedToolCallIds: [] };

interface ReviewSnapshot {
  readonly history: readonly ContextMessage[];
  readonly authorization: readonly ReviewText[];
  readonly cwd: string;
  readonly messages: readonly Message[];
}

export class AutoReviewService extends Service implements IAutoReviewService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IFlagService flags: IFlagService,
    @IAgentPermissionModeService modeService: IAgentPermissionModeService,
    @IAgentPermissionPolicyService policyService: IAgentPermissionPolicyService,
    @IAgentPermissionGate permissionGate: IAgentPermissionGate,
    @IAgentStateService private readonly states: IAgentStateService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @ISessionAutoReviewService private readonly sessionReview: ISessionAutoReviewService,
    @IConfigService private readonly configService: IConfigService,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @IAgentLifecycleService agentLifecycle: IAgentLifecycleService,
    @ref(ISessionWorkdir) private readonly workdir: LiveRef<ISessionWorkdir>,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this._register(this.states.contributeState(autoReviewApprovedCallsKey));
    this._register(this.states.contributeState(autoReviewAncestryKey));
    this._register(dispatcher.hooks.onDidRestore.register('autoReview', async (_ctx, next) => {
      if (this.scopeContext.agentId !== MAIN_AGENT_ID && this.states.get(autoReviewAncestryKey) === undefined) {
        await this.dispatcher.dispatch(new AutoReviewAncestryRecorded({
          agentId: this.scopeContext.agentId,
          ...ancestrySnapshotOf(this.scopeContext, agentLifecycle),
        }));
      }
      await next();
    }));
    this._register(
      permissionGate.registerReviewer(
        createAutoReviewReviewer(flags, modeService, policyService, this),
      ),
    );
  }

  inheritedAuthorization(): readonly ReviewText[] {
    return this.ancestry().authorization;
  }

  humanAuthorization(): readonly ReviewText[] {
    const own = extractAuthorization(this.loop.history())
      .filter((entry) => entry.role === 'human-instruction');
    const inherited = this.inheritedAuthorization();
    return inherited.length === 0 ? own : [...inherited, ...own];
  }

  approvedToolCallIds(): ReadonlySet<string> {
    return new Set([...this.ancestry().approvedToolCallIds, ...this.states.get(autoReviewApprovedCallsKey)]);
  }

  async review(
    context: ResolvedToolExecutionHookContext,
    trigger: string,
  ): Promise<AutoReviewOutcome> {
    this.sessionReview.assertConfiguredModelValid();
    const startedAt = Date.now();
    void this.dispatcher.dispatch(new AutoReviewStarted({
      agentId: this.scopeContext.agentId,
      turnId: context.turnId,
      toolCallId: context.toolCall.id,
      toolName: context.toolCall.name,
    }));
    const timeoutMs = this.configService.get<AutoReviewConfig>(AUTO_REVIEW_SECTION)?.timeoutMs ?? 30000;
    const deadline = createDeadlineAbortSignal(context.signal, timeoutMs);
    let modelAlias = this.profile.resolveModelContext().modelAlias;
    let outcome: AutoReviewOutcome;
    try {
      let appended = false;
      while (true) {
        const snapshot = await this.takeSnapshot(context, deadline.signal);
        const run = await this.sessionReview.execute({
          agentContext: this.scopeContext.agentContext,
          turnId: context.turnId,
          mainModelAlias: modelAlias,
          deadline,
          messages: snapshot.messages,
        });
        context.signal.throwIfAborted();
        modelAlias = run.modelAlias;
        outcome = run.outcome;
        if (outcome.decision === 'failed') break;
        if (this.workspace.workDir !== snapshot.cwd) {
          outcome = { decision: 'failed', reason: AUTHORIZATION_CHANGED_REASON };
          break;
        }
        const latestHistory = this.loop.history();
        if (latestHistory !== snapshot.history) {
          const drift = detectAuthorizationDrift(snapshot.authorization, this.authorizationOf(latestHistory));
          if (drift === 'appended' && !appended) {
            appended = true;
            continue;
          }
          if (drift !== 'unchanged') {
            outcome = { decision: 'failed', reason: AUTHORIZATION_CHANGED_REASON };
          }
        }
        break;
      }
    } catch (error) {
      context.signal.throwIfAborted();
      outcome = deadline.signal.aborted
        ? { decision: 'failed', reason: deadline.timedOut() ? 'Review timed out.' : 'Review cancelled.' }
        : { decision: 'failed', reason: error instanceof Error ? error.message : String(error) };
    } finally {
      deadline.clear();
    }
    const durationMs = Date.now() - startedAt;
    const risk = 'risk' in outcome ? outcome.risk : undefined;
    const reason = 'reason' in outcome ? outcome.reason : undefined;
    void this.dispatcher.dispatch(new AutoReviewCompleted({
      agentId: this.scopeContext.agentId,
      turnId: context.turnId,
      toolCallId: context.toolCall.id,
      toolName: context.toolCall.name,
      triggerPolicy: trigger,
      model: modelAlias,
      decision: outcome.decision,
      ...(risk === undefined ? {} : { risk }),
      ...(reason === undefined ? {} : { reason }),
      durationMs,
    }));
    if (outcome.decision === 'failed') {
      this.log.warn('auto review failed', { model: modelAlias, tool: context.toolCall.name, reason: outcome.reason });
    }
    this.telemetry.track2('auto_review_decision', {
      turn_id: context.turnId,
      tool_call_id: context.toolCall.id,
      tool_name: context.toolCall.name,
      trigger_policy: trigger,
      model: modelAlias,
      decision: outcome.decision,
      ...(risk === undefined ? {} : { risk }),
      duration_ms: durationMs,
    });
    return outcome;
  }

  private ancestry(): AutoReviewAncestry {
    return this.states.get(autoReviewAncestryKey) ?? EMPTY_ANCESTRY;
  }

  private authorizationOf(history: readonly ContextMessage[]): readonly ReviewText[] {
    const own = extractAuthorization(history);
    const inherited = this.inheritedAuthorization();
    return inherited.length === 0 ? own : [...inherited, ...own];
  }

  private async takeSnapshot(
    context: ResolvedToolExecutionHookContext,
    signal: AbortSignal,
  ): Promise<ReviewSnapshot> {
    const history = this.loop.history();
    const authorization = this.authorizationOf(history);
    const cwd = this.workspace.workDir;
    const projectInstructions = await this.sessionReview.projectInstructions();
    const gitStatus = await abortable(this.readGitStatus(cwd, context), signal);
    const messages = buildReviewMessages(
      history,
      this.inheritedAuthorization(),
      projectInstructions.agentsMd,
      projectInstructions.agentsMdPaths,
      cwd,
      context,
      this.approvedToolCallIds(),
      gitStatus,
    );
    return { history, authorization, cwd, messages };
  }

  private async readGitStatus(
    cwd: string,
    context: ResolvedToolExecutionHookContext,
  ): Promise<ReviewGitStatus | undefined> {
    const git = this.workdir?.current?.git;
    if (git === undefined) return undefined;
    const argCwd = isRecord(context.args) && typeof context.args['cwd'] === 'string' && context.args['cwd'].length > 0
      ? context.args['cwd']
      : undefined;
    const targetCwd = argCwd === undefined ? cwd : this.workspace.resolve(argCwd);
    try {
      const status = await git.statusAt(targetCwd, { includePullRequest: false, includeStats: false });
      const keys = Object.keys(status.entries);
      if (keys.length === 0) return { branch: status.branch, clean: true };
      const entries = Object.fromEntries(
        keys.slice(0, MAX_GIT_STATUS_ENTRIES).map((key) => [key, status.entries[key]!]),
      );
      return { branch: status.branch, clean: false, entries };
    } catch {
      return undefined;
    }
  }
}

export function ancestrySnapshotOf(
  scope: Pick<IAgentScopeContext, 'meta' | 'forkedFrom'>,
  agentLifecycle: Pick<IAgentLifecycleService, 'handleOf'>,
): AutoReviewAncestry {
  const forkSourceId = scope.meta?.forkedFrom ?? scope.forkedFrom;
  if (forkSourceId !== undefined) {
    const source = agentLifecycle.handleOf(forkSourceId)?.accessor.get(IAutoReviewService);
    return source === undefined
      ? EMPTY_ANCESTRY
      : { authorization: source.inheritedAuthorization(), approvedToolCallIds: [...source.approvedToolCallIds()] };
  }
  const parentId = subagentParentAgentId(scope.meta) ?? scope.meta?.parentAgentId ?? MAIN_AGENT_ID;
  const parent = agentLifecycle.handleOf(parentId)?.accessor.get(IAutoReviewService);
  return parent === undefined ? EMPTY_ANCESTRY : { authorization: parent.humanAuthorization(), approvedToolCallIds: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
