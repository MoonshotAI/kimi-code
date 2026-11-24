import { ref, type LiveRef } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { ILogService } from '#/_base/log/log';
import { abortable, createDeadlineAbortSignal } from '#/_base/utils/abort';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
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
  AutoReviewCompleted,
  AutoReviewStarted,
  autoReviewApprovedCallsKey,
} from './autoReviewEvents';
import { createAutoReviewReviewer } from './autoReviewGate';
import { AUTO_REVIEW_SECTION, type AutoReviewConfig } from './configSection';
import {
  buildReviewMessages,
  extractAuthorization,
  sameAuthorization,
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
const EMPTY_APPROVED_CALL_IDS: ReadonlySet<string> = new Set();

interface ReviewSnapshot {
  readonly history: readonly ContextMessage[];
  readonly authorization: readonly ReviewText[];
  readonly cwd: string;
  readonly messages: readonly Message[];
}

interface AncestorReviewSnapshot {
  readonly inherited: readonly ReviewText[];
  readonly approvedCallIds: ReadonlySet<string>;
}

export class AutoReviewService extends Service implements IAutoReviewService {
  declare readonly _serviceBrand: undefined;
  private readonly inherited: readonly ReviewText[];
  private readonly inheritedApprovedCallIds: ReadonlySet<string>;

  constructor(
    @IFlagService flags: IFlagService,
    @IAgentPermissionModeService modeService: IAgentPermissionModeService,
    @IAgentPermissionPolicyService policyService: IAgentPermissionPolicyService,
    @IAgentPermissionGate permissionGate: IAgentPermissionGate,
    @IAgentStateService private readonly states: IAgentStateService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentFullCompactionService private readonly compaction: IAgentFullCompactionService,
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
    const ancestor = this.snapshotAncestorState(agentLifecycle);
    this.inherited = ancestor.inherited;
    this.inheritedApprovedCallIds = ancestor.approvedCallIds;
    this._register(this.states.contributeState(autoReviewApprovedCallsKey));
    this._register(
      permissionGate.registerReviewer(
        createAutoReviewReviewer(flags, modeService, policyService, this),
      ),
    );
  }

  inheritedAuthorization(): readonly ReviewText[] {
    return this.inherited;
  }

  humanAuthorization(): readonly ReviewText[] {
    const own = extractAuthorization(this.loop.history())
      .filter((entry) => entry.role === 'human-instruction');
    return this.inherited.length === 0 ? own : [...this.inherited, ...own];
  }

  approvedToolCallIds(): ReadonlySet<string> {
    const own = this.states.get(autoReviewApprovedCallsKey);
    if (this.inheritedApprovedCallIds.size === 0) return new Set(own);
    return new Set([...this.inheritedApprovedCallIds, ...own]);
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
          const current = this.authorizationOf(latestHistory);
          if (!sameAuthorization(snapshot.authorization, current)) {
            if (!appended && sameAuthorization(snapshot.authorization, current.slice(0, snapshot.authorization.length))) {
              appended = true;
              continue;
            }
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
    if (outcome.decision === 'failed' && outcome.contextOverflow === true) {
      this.compaction.begin({ source: 'auto' });
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

  private authorizationOf(history: readonly ContextMessage[]): readonly ReviewText[] {
    const own = extractAuthorization(history);
    return this.inherited.length === 0 ? own : [...this.inherited, ...own];
  }

  private snapshotAncestorState(agentLifecycle: IAgentLifecycleService): AncestorReviewSnapshot {
    const { agentId, meta, forkedFrom } = this.scopeContext;
    if (agentId === MAIN_AGENT_ID) {
      return { inherited: [], approvedCallIds: EMPTY_APPROVED_CALL_IDS };
    }
    const forkSourceId = meta?.forkedFrom ?? forkedFrom;
    if (forkSourceId !== undefined) {
      const source = agentLifecycle.handleOf(forkSourceId);
      if (source === undefined) return { inherited: [], approvedCallIds: EMPTY_APPROVED_CALL_IDS };
      const sourceReviewer = source.accessor.get(IAutoReviewService);
      return {
        inherited: sourceReviewer.inheritedAuthorization(),
        approvedCallIds: new Set(sourceReviewer.approvedToolCallIds()),
      };
    }
    const parentId = subagentParentAgentId(meta) ?? meta?.parentAgentId ?? MAIN_AGENT_ID;
    const parent = agentLifecycle.handleOf(parentId);
    if (parent === undefined) return { inherited: [], approvedCallIds: EMPTY_APPROVED_CALL_IDS };
    return {
      inherited: parent.accessor.get(IAutoReviewService).humanAuthorization(),
      approvedCallIds: EMPTY_APPROVED_CALL_IDS,
    };
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
      authorization,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
