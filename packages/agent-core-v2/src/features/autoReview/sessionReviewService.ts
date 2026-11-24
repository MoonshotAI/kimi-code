import { z } from 'zod';

import { ref, type LiveRef } from '#/_base/di/instantiation';
import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { abortable, createDeadlineAbortSignal, type DeadlineAbortSignal } from '#/_base/utils/abort';
import { sleepForRetry } from '#/_base/utils/retry';
import { IAgentLoopService } from '#/agent/loop/loop';
import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { IConfigService } from '#/app/config/config';
import { THINKING_SECTION } from '#/app/kosongConfig/configSection';
import { Error2, ErrorCodes } from '#/errors';
import { llmMessageFromError } from '#/llm-adapter/contract/errors';
import { IModelCatalog } from '#/llm-adapter/model/catalog';
import { resolveMaxOutputTokens } from '#/llm-adapter/model/completion-budget';
import type { ModelOverrides } from '#/llm-adapter/model/model.types';
import { requiresStrictThinkingValidation, type ThinkingConfig } from '#/llm-adapter/model/thinking';
import { IProtocolAdapterRegistry } from '#/llm-adapter/protocol/protocol';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { subagentParentAgentId } from '#/session/agentLifecycle/subagentMetadata';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionInstructionsProvider } from '#/session/sessionInstructions/instructionsProvider';
import { resolveSubagentModelPool } from '#/session/subagent/configSection';
import { ISessionUsageService } from '#/session/usage/sessionUsage';
import { ISessionWorkdir } from '#/session/workdir/workdir';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import type { Message } from '@moonshot-ai/core/llm/message';
import { credentialRecovery } from '@moonshot-ai/core/llm/policy/credentials';
import { readRetryAfterMs, retryBackoffDelay } from '@moonshot-ai/core/llm/policy/retry';
import type { InitializedLlmRequestPart } from '@moonshot-ai/core/llm/requester';
import type { LlmOutcome } from '@moonshot-ai/core/llm/response';
import { resolveThinkingEffortForModel, resolveThinkingKeep } from '@moonshot-ai/core/llm/thinking';

import REVIEW_POLICY from './auto-review-policy.md?raw';
import { AUTO_REVIEW_SECTION, type AutoReviewConfig } from './configSection';
import {
  buildReviewMessages,
  extractAuthorization,
  sameAuthorization,
  type ReviewGitStatus,
  type ReviewText,
} from './context';
import {
  ISessionAutoReviewService,
  type AutoReviewOutcome,
  type SessionReviewInput,
  type SessionReviewRun,
} from './review';

const AUTO_REVIEW_REQUEST_KIND = 'auto_review';
const MAX_REVIEW_ATTEMPTS = 3;
const MAX_CONCURRENT_REVIEWS = 4;
const MAX_GIT_STATUS_ENTRIES = 50;

const DecisionSchema = z.union([
  z.object({
    risk: z.enum(['low', 'medium']),
    decision: z.literal('allow'),
    reason: z.null(),
  }).strict().transform(({ risk }) => ({ decision: 'allow' as const, risk })),
  z.object({
    risk: z.enum(['medium', 'high']),
    decision: z.literal('deny'),
    reason: z.string().nullable(),
  }).strict().transform(({ risk, reason }) => ({
    decision: 'deny' as const,
    risk,
    reason: reason === null ? undefined : reason.slice(0, 1000),
  })),
]);

const RESPONSE_FORMAT = {
  type: 'json_schema',
  jsonSchema: {
    name: 'auto_review_decision',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        risk: { type: 'string', enum: ['low', 'medium', 'high'] },
        decision: { type: 'string', enum: ['allow', 'deny'] },
        reason: { type: ['string', 'null'] },
      },
      required: ['risk', 'decision', 'reason'],
      additionalProperties: false,
    },
  },
} as const;

interface ProjectInstructions {
  readonly agentsMd?: string;
  readonly agentsMdPaths?: readonly string[];
}

type AttemptResult =
  | AutoReviewOutcome
  | { readonly decision: 'appended' }
  | { readonly decision: 'retry'; readonly reason: string; readonly retryAfterMs?: number };

export class SessionAutoReviewService extends Service implements ISessionAutoReviewService {
  declare readonly _serviceBrand: undefined;
  private projectInstructions: Promise<ProjectInstructions> | undefined;
  private activeReviews = 0;
  private readonly reviewSlots: Array<() => void> = [];
  private readonly inheritedByAgent = new Map<string, readonly ReviewText[]>();

  constructor(
    @IConfigService private readonly configService: IConfigService,
    @IModelCatalog private readonly models: IModelCatalog,
    @IProtocolAdapterRegistry private readonly protocols: IProtocolAdapterRegistry,
    @ISessionUsageService private readonly usage: ISessionUsageService,
    @ISessionContext private readonly session: ISessionContext,
    @ISessionInstructionsProvider private readonly instructions: ISessionInstructionsProvider,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @ref(ISessionWorkdir) private readonly workdir: LiveRef<ISessionWorkdir>,
  ) {
    super();
    this.assertConfiguredModelValid();
  }

  snapshotParentInstructions(scopeContext: IAgentScopeContext): IDisposable {
    const own = this.inheritedAuthorization(scopeContext);
    if (own.length === 0) return Disposable.None;
    return toDisposable(() => {
      this.inheritedByAgent.delete(scopeContext.agentId);
    });
  }

  private assertConfiguredModelValid(): void {
    const model = this.configService.get<AutoReviewConfig>(AUTO_REVIEW_SECTION)?.model;
    if (model === undefined) return;
    try {
      this.models.get(model);
    } catch (error) {
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        `[auto_review].model "${model}" could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error, details: { section: AUTO_REVIEW_SECTION, field: 'model', model } },
      );
    }
  }

  async execute(input: SessionReviewInput): Promise<SessionReviewRun> {
    const config = this.configService.get<AutoReviewConfig>(AUTO_REVIEW_SECTION);
    const modelAlias =
      config?.model ??
      resolveSubagentModelPool(this.configService)?.defaultModel ??
      input.mainModelAlias;
    const outcome = await this.runWithDeadline(input, modelAlias, config?.timeoutMs ?? 30000);
    return { modelAlias, outcome };
  }

  private async runWithDeadline(
    input: SessionReviewInput,
    modelAlias: string,
    timeoutMs: number,
  ): Promise<AutoReviewOutcome> {
    const { context } = input;
    const deadline = createDeadlineAbortSignal(context.signal, timeoutMs);
    let acquired = false;
    try {
      const projectInstructions = await this.loadProjectInstructions();
      await this.acquireSlot(deadline.signal);
      acquired = true;
      let appended = false;
      for (let attempt = 1; attempt <= MAX_REVIEW_ATTEMPTS; attempt += 1) {
        const result = await this.reviewOnce(input, modelAlias, projectInstructions, deadline);
        if (result.decision === 'appended') {
          if (appended) return { decision: 'failed', reason: 'Authorization changed during review.' };
          appended = true;
          continue;
        }
        if (result.decision !== 'retry') return result;
        if (attempt === MAX_REVIEW_ATTEMPTS) return { decision: 'failed', reason: result.reason };
        const delayMs = Math.min(
          result.retryAfterMs ?? retryBackoffDelay(attempt - 1),
          deadline.remainingMs(),
        );
        if (delayMs <= 0 || deadline.signal.aborted) return deadlineFailure(deadline);
        await sleepForRetry(delayMs, deadline.signal);
      }
      return { decision: 'failed', reason: 'Review timed out.' };
    } catch (error) {
      context.signal.throwIfAborted();
      if (deadline.signal.aborted) return deadlineFailure(deadline);
      return { decision: 'failed', reason: error instanceof Error ? error.message : String(error) };
    } finally {
      if (acquired) this.releaseSlot();
      deadline.clear();
    }
  }

  private async reviewOnce(
    input: SessionReviewInput,
    modelAlias: string,
    projectInstructions: ProjectInstructions,
    deadline: DeadlineAbortSignal,
  ): Promise<AttemptResult> {
    const history = input.readHistory();
    const inherited = this.inheritedAuthorization(input.scopeContext);
    const authorization = inherited.length === 0
      ? extractAuthorization(history)
      : [...inherited, ...extractAuthorization(history)];
    const cwd = this.workspace.workDir;
    const gitStatus = await abortable(this.readGitStatus(cwd, input.context), deadline.signal);
    const messages = buildReviewMessages(
      history,
      authorization,
      projectInstructions.agentsMd,
      projectInstructions.agentsMdPaths,
      cwd,
      input.context,
      input.readApprovedIds(),
      gitStatus,
    );
    let outcome: LlmOutcome;
    try {
      outcome = await this.sendRequest(modelAlias, messages, deadline.signal);
    } catch (error) {
      input.context.signal.throwIfAborted();
      if (deadline.signal.aborted) return deadlineFailure(deadline);
      const mapped = llmMessageFromError(error);
      if (mapped !== undefined) return classifyLlmError(mapped);
      throw error;
    }
    input.context.signal.throwIfAborted();
    if (outcome.type === 'aborted') return deadlineFailure(deadline);
    if (outcome.type === 'failed') return classifyFailedOutcome(outcome, deadline);
    void this.usage.record(input.agentContext, modelAlias, outcome.usage, {
      type: 'operation',
      turnId: input.context.turnId,
      requestKind: AUTO_REVIEW_REQUEST_KIND,
    });
    if (this.workspace.workDir !== cwd) {
      return { decision: 'failed', reason: 'Authorization changed during review.' };
    }
    const latestHistory = input.readHistory();
    if (latestHistory !== history) {
      const current = inherited.length === 0
        ? extractAuthorization(latestHistory)
        : [...inherited, ...extractAuthorization(latestHistory)];
      if (!sameAuthorization(authorization, current)) {
        return sameAuthorization(authorization, current.slice(0, authorization.length))
          ? { decision: 'appended' }
          : { decision: 'failed', reason: 'Authorization changed during review.' };
      }
    }
    if (outcome.message.toolCalls.length > 0) {
      return { decision: 'failed', reason: 'The reviewer attempted a tool call.' };
    }
    const text = outcome.message.content.filter((part) => part.type === 'text').map((part) => part.text).join('');
    const parsed = DecisionSchema.safeParse(parseJson(text));
    if (!parsed.success) {
      return { decision: 'retry', reason: 'The reviewer returned an invalid decision.' };
    }
    return parsed.data;
  }

  private sendRequest(
    modelAlias: string,
    messages: readonly Message[],
    signal: AbortSignal,
  ): Promise<LlmOutcome> {
    const model = this.models.get(modelAlias);
    const overrides = this.configService.get<ModelOverrides>('modelOverrides');
    const thinkingConfig = this.configService.get<ThinkingConfig>(THINKING_SECTION);
    const strict = requiresStrictThinkingValidation(this.protocols, model.protocol, model.providerType);
    const thinkingEffort = resolveThinkingEffortForModel('off', undefined, model.spec, strict);
    const sampling =
      overrides?.temperature === undefined && overrides?.topP === undefined
        ? undefined
        : { temperature: overrides.temperature, topP: overrides.topP };
    const params: InitializedLlmRequestPart = {
      model: {
        cacheKey: `${this.session.sessionId}:${AUTO_REVIEW_REQUEST_KIND}`,
        sampling,
        thinking: {
          effort: thinkingEffort,
          keep: resolveThinkingKeep(overrides?.thinkingKeep, thinkingConfig?.keep, thinkingEffort),
        },
        maxOutputTokens: resolveMaxOutputTokens({
          maxOutputSize: model.maxOutputSize,
          maxCompletionTokensCap: overrides?.maxCompletionTokens,
        }),
      },
    };
    return this.protocols.request(model, params).with({
      model: { responseFormat: RESPONSE_FORMAT },
      profile: { systemPrompt: REVIEW_POLICY, tools: [] },
      content: { messages },
      policy: {
        retry: { maxAttemptsPerStep: 1 },
        recoveries: [credentialRecovery],
      },
    }).generate({}, { signal });
  }

  private loadProjectInstructions(): Promise<ProjectInstructions> {
    if (this.projectInstructions === undefined) {
      this.projectInstructions = this.instructions.ready.then(() => ({
        agentsMd: this.instructions.agentsMd,
        agentsMdPaths: this.instructions.agentsMdPaths === undefined
          ? undefined
          : [...this.instructions.agentsMdPaths],
      }));
      void this.projectInstructions.catch(() => undefined);
    }
    return this.projectInstructions;
  }

  private inheritedAuthorization(scopeContext: IAgentScopeContext): readonly ReviewText[] {
    if (
      scopeContext.agentId === MAIN_AGENT_ID ||
      (scopeContext.meta?.forkedFrom ?? scopeContext.forkedFrom) !== undefined
    ) {
      return [];
    }
    const cached = this.inheritedByAgent.get(scopeContext.agentId);
    if (cached !== undefined) return cached;
    const resolved = this.readParentHumanInstructions(scopeContext.meta);
    if (resolved.length > 0) this.inheritedByAgent.set(scopeContext.agentId, resolved);
    return resolved;
  }

  private readParentHumanInstructions(meta: IAgentScopeContext['meta']): readonly ReviewText[] {
    const parentId = subagentParentAgentId(meta) ?? meta?.parentAgentId ?? MAIN_AGENT_ID;
    const parent = this.agentLifecycle.handleOf(parentId);
    if (parent === undefined) return [];
    const inherited = this.inheritedByAgent.get(parentId) ?? [];
    const own = extractAuthorization(parent.accessor.get(IAgentLoopService).history())
      .filter((entry) => entry.role === 'human-instruction');
    return inherited.length === 0 ? own : [...inherited, ...own];
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

  private acquireSlot(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason as Error);
    if (this.activeReviews < MAX_CONCURRENT_REVIEWS) {
      this.activeReviews += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const grant = () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        const index = this.reviewSlots.indexOf(grant);
        if (index >= 0) this.reviewSlots.splice(index, 1);
        reject(signal.reason as Error);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.reviewSlots.push(grant);
    });
  }

  private releaseSlot(): void {
    const next = this.reviewSlots.shift();
    if (next !== undefined) {
      next();
      return;
    }
    this.activeReviews -= 1;
  }
}

function classifyFailedOutcome(
  outcome: Extract<LlmOutcome, { readonly type: 'failed' }>,
  deadline: DeadlineAbortSignal,
): AttemptResult {
  if (deadline.signal.aborted) return deadlineFailure(deadline);
  const error = (outcome.rawError !== undefined ? llmMessageFromError(outcome.rawError) : undefined) ?? outcome.error;
  return classifyLlmError(error);
}

function classifyLlmError(
  error: Extract<LlmOutcome, { readonly type: 'failed' }>['error'],
): AttemptResult {
  if (error.kind === 'context_overflow') {
    return { decision: 'failed', reason: 'The review context exceeded the model window.', contextOverflow: true };
  }
  if (error.kind !== 'syntax' && error.kind !== 'abort' && error.retryable) {
    return { decision: 'retry', reason: error.message, retryAfterMs: readRetryAfterMs(error) };
  }
  return { decision: 'failed', reason: error.message };
}

function deadlineFailure(deadline: DeadlineAbortSignal): AutoReviewOutcome {
  return {
    decision: 'failed',
    reason: deadline.timedOut() ? 'Review timed out.' : 'Review cancelled.',
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
