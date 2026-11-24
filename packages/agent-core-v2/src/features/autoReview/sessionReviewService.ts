import { z } from 'zod';

import { Service } from '#/_base/di/service';
import { type DeadlineAbortSignal } from '#/_base/utils/abort';
import { sleepForRetry } from '#/_base/utils/retry';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { THINKING_SECTION } from '#/app/kosongConfig/configSection';
import { Error2, ErrorCodes } from '#/errors';
import { llmMessageFromError } from '#/llm-adapter/contract/errors';
import { IModelCatalog } from '#/llm-adapter/model/catalog';
import { resolveMaxOutputTokens } from '#/llm-adapter/model/completion-budget';
import type { ModelOverrides } from '#/llm-adapter/model/model.types';
import { requiresStrictThinkingValidation, type ThinkingConfig } from '#/llm-adapter/model/thinking';
import { IProtocolAdapterRegistry } from '#/llm-adapter/protocol/protocol';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionInstructionsProvider } from '#/session/sessionInstructions/instructionsProvider';
import { resolveSubagentModelPool } from '#/session/subagent/configSection';
import { ISessionUsageService } from '#/session/usage/sessionUsage';
import type { Message } from '@moonshot-ai/core/llm/message';
import { credentialRecovery } from '@moonshot-ai/core/llm/policy/credentials';
import { readRetryAfterMs, retryBackoffDelay } from '@moonshot-ai/core/llm/policy/retry';
import type { InitializedLlmRequestPart } from '@moonshot-ai/core/llm/requester';
import type { LlmOutcome } from '@moonshot-ai/core/llm/response';
import { resolveThinkingEffortForModel, resolveThinkingKeep } from '@moonshot-ai/core/llm/thinking';

import REVIEW_POLICY from './auto-review-policy.md?raw';
import { AUTO_REVIEW_SECTION, type AutoReviewConfig } from './configSection';
import { AUTO_REVIEW_FLAG_ID } from './flag';
import {
  ISessionAutoReviewService,
  type AutoReviewOutcome,
  type ProjectInstructions,
  type SessionReviewInput,
  type SessionReviewRun,
} from './review';

const AUTO_REVIEW_REQUEST_KIND = 'auto_review';
const MAX_REVIEW_ATTEMPTS = 3;
const MAX_CONCURRENT_REVIEWS = 4;

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

type AttemptResult =
  | AutoReviewOutcome
  | { readonly decision: 'retry'; readonly reason: string; readonly retryAfterMs?: number };

export class SessionAutoReviewService extends Service implements ISessionAutoReviewService {
  declare readonly _serviceBrand: undefined;
  private cachedInstructions: Promise<ProjectInstructions> | undefined;
  private activeReviews = 0;
  private readonly reviewSlots: Array<() => void> = [];

  constructor(
    @IFlagService private readonly flags: IFlagService,
    @IConfigService private readonly configService: IConfigService,
    @IModelCatalog private readonly models: IModelCatalog,
    @IProtocolAdapterRegistry private readonly protocols: IProtocolAdapterRegistry,
    @ISessionUsageService private readonly usage: ISessionUsageService,
    @ISessionContext private readonly session: ISessionContext,
    @ISessionInstructionsProvider private readonly instructions: ISessionInstructionsProvider,
  ) {
    super();
    if (this.flags.enabled(AUTO_REVIEW_FLAG_ID)) {
      this.assertConfiguredModelValid();
    }
  }

  projectInstructions(): Promise<ProjectInstructions> {
    if (this.cachedInstructions === undefined) {
      this.cachedInstructions = this.instructions.ready.then(() => ({
        agentsMd: this.instructions.agentsMd,
        agentsMdPaths: this.instructions.agentsMdPaths === undefined
          ? undefined
          : [...this.instructions.agentsMdPaths],
      }));
      void this.cachedInstructions.catch(() => undefined);
    }
    return this.cachedInstructions;
  }

  async execute(input: SessionReviewInput): Promise<SessionReviewRun> {
    this.assertConfiguredModelValid();
    const config = this.configService.get<AutoReviewConfig>(AUTO_REVIEW_SECTION);
    const modelAlias =
      config?.model ??
      resolveSubagentModelPool(this.configService)?.defaultModel ??
      input.mainModelAlias;
    const outcome = await this.runWithDeadline(input, modelAlias);
    return { modelAlias, outcome };
  }

  assertConfiguredModelValid(): void {
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

  private async runWithDeadline(
    input: SessionReviewInput,
    modelAlias: string,
  ): Promise<AutoReviewOutcome> {
    const { deadline } = input;
    let acquired = false;
    try {
      await this.acquireSlot(deadline.signal);
      acquired = true;
      for (let attempt = 1; attempt <= MAX_REVIEW_ATTEMPTS; attempt += 1) {
        const result = await this.reviewOnce(input, modelAlias);
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
      if (deadline.signal.aborted) return deadlineFailure(deadline);
      return { decision: 'failed', reason: error instanceof Error ? error.message : String(error) };
    } finally {
      if (acquired) this.releaseSlot();
    }
  }

  private async reviewOnce(
    input: SessionReviewInput,
    modelAlias: string,
  ): Promise<AttemptResult> {
    const { deadline } = input;
    let outcome: LlmOutcome;
    try {
      outcome = await this.sendRequest(modelAlias, input.messages, deadline.signal);
    } catch (error) {
      if (deadline.signal.aborted) return deadlineFailure(deadline);
      const mapped = llmMessageFromError(error);
      if (mapped !== undefined) return classifyLlmError(mapped);
      throw error;
    }
    if (outcome.type === 'aborted') return deadlineFailure(deadline);
    if (outcome.type === 'failed') return classifyFailedOutcome(outcome, deadline);
    void this.usage.record(input.agentContext, modelAlias, outcome.usage, {
      type: 'operation',
      turnId: input.turnId,
      requestKind: AUTO_REVIEW_REQUEST_KIND,
    });
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
    return { decision: 'failed', reason: 'The review context exceeded the model window.' };
  }
  if (error.kind !== 'syntax' && error.kind !== 'abort' && error.retryable) {
    return { decision: 'retry', reason: error.message, retryAfterMs: readRetryAfterMs(error) };
  }
  return { decision: 'failed', reason: error.message };
}

function deadlineFailure(deadline: DeadlineAbortSignal): AutoReviewOutcome {
  if (deadline.signal.aborted && !deadline.timedOut()) {
    throw deadline.signal.reason;
  }
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
