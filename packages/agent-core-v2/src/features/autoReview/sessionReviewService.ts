import {
  isManagedKimiCode,
  isManagedKimiCodeBaseUrl,
  KIMI_CODE_PLATFORM_ID,
} from '@moonshot-ai/kimi-code-oauth';
import { z } from 'zod';

import { Service } from '#/_base/di/service';
import { sliceOnCodePointBoundary } from '#/_base/text/code-points';
import { type DeadlineAbortSignal } from '#/_base/utils/abort';
import { sleepForRetry } from '#/_base/utils/retry';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { PROVIDERS_SECTION, THINKING_SECTION } from '#/app/kosongConfig/configSection';
import { Error2, ErrorCodes } from '#/errors';
import { llmMessageFromError } from '#/provider-catalog/errors';
import type { Model } from '#/provider-catalog/model/catalog';
import { resolveMaxOutputTokens } from '#/provider-catalog/model/completion-budget';
import type { ModelOverrides } from '#/provider-catalog/model/model.types';
import {
  drivesThinkingThroughTraits,
  requiresStrictThinkingValidation,
  type ThinkingConfig,
} from '#/provider-catalog/model/thinking';
import type { ProvidersSection } from '#/provider-catalog/provider/provider';
import { IProviderCatalogService } from '#/provider-catalog/providerCatalogService';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionInstructionsProvider } from '#/session/sessionInstructions/instructionsProvider';
import {
  assertModelSupportsConfiguredEffort,
  resolveSubagentThinking,
} from '#/session/subagent/configSection';
import { ISessionUsageService } from '#/session/usage/sessionUsage';
import { credentialRecovery } from '@moonshot-ai/core/llm/policy/credentials';
import { createLlmRequesterExecution } from '@moonshot-ai/core/llm/policy/policy';
import { isRetryableError, readRetryAfterMs, retryBackoffDelay } from '@moonshot-ai/core/llm/policy/retry';
import type { InitializedLlmRequestPart } from '@moonshot-ai/core/llm/requester';
import type { LlmOutcome } from '@moonshot-ai/core/llm/response';
import {
  modelSupportsThinkingEffort,
  normalizeRequestedThinkingEffort,
  resolveForcedThinkingEffort,
  resolveThinkingEffortForModel,
  resolveThinkingKeep,
} from '@moonshot-ai/core/llm/thinking';

import REVIEW_POLICY from './auto-review-policy.md?raw';
import {
  DEFAULT_AUTO_REVIEW_TIMEOUT_MS,
  IAutoReviewCloudConfigService,
} from './cloudConfig';
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
    reason: z.string().nullable(),
  }).strict().transform(({ risk }) => ({ decision: 'allow' as const, risk })),
  z.object({
    risk: z.enum(['low', 'medium', 'high']),
    decision: z.literal('deny'),
    reason: z.string().nullable(),
  }).strict().transform(({ risk, reason }) => ({
    decision: 'deny' as const,
    risk,
    reason: reason === null ? undefined : sliceOnCodePointBoundary(reason, 1000),
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

interface ReviewBinding {
  readonly modelAlias: string;
  readonly effort?: string;
}

type AttemptResult =
  | AutoReviewOutcome
  | { readonly decision: 'retry'; readonly reason: string; readonly retryAfterMs?: number };

export class SessionAutoReviewService extends Service implements ISessionAutoReviewService {
  declare readonly _serviceBrand: undefined;
  private cachedInstructions: Promise<ProjectInstructions> | undefined;
  private activeReviews = 0;
  private readonly reviewSlots: Array<() => void> = [];
  private readonly requesterExecution = createLlmRequesterExecution();

  constructor(
    @IFlagService private readonly flags: IFlagService,
    @IConfigService private readonly configService: IConfigService,
    @IProviderCatalogService private readonly providerCatalog: IProviderCatalogService,
    @ISessionUsageService private readonly usage: ISessionUsageService,
    @ISessionContext private readonly session: ISessionContext,
    @ISessionInstructionsProvider private readonly instructions: ISessionInstructionsProvider,
    @IAutoReviewCloudConfigService private readonly cloudConfig: IAutoReviewCloudConfigService,
  ) {
    super();
    this._register(this.instructions.onDidChange(() => {
      this.cachedInstructions = undefined;
    }));
    if (this.flags.enabled(AUTO_REVIEW_FLAG_ID)) {
      this.assertConfigValid();
      if (this.hasManagedKimiProvider()) {
        this.cloudConfig.warm();
      }
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

  async resolveTimeoutMs(mainModelAlias: string, signal?: AbortSignal): Promise<number> {
    const configured = this.configService.get<AutoReviewConfig | undefined>(AUTO_REVIEW_SECTION)?.timeoutMs;
    if (configured !== undefined) return configured;
    const mainModel = this.tryGetModel(mainModelAlias);
    if (mainModel !== undefined && isManagedKimiModel(mainModel)) {
      const cloud = this.cloudConfig.peek() ?? (await this.cloudConfig.load(signal));
      if (cloud?.timeout_ms !== undefined) return cloud.timeout_ms;
    }
    return DEFAULT_AUTO_REVIEW_TIMEOUT_MS;
  }

  async execute(input: SessionReviewInput): Promise<SessionReviewRun> {
    const binding = await this.bindingFor(input.mainModelAlias, input.deadline.signal);
    this.assertReviewModelValid(binding.modelAlias);
    const outcome = await this.runWithDeadline(input, binding);
    return { modelAlias: binding.modelAlias, outcome };
  }

  assertConfigValid(): void {
    const configured = this.configService.get<AutoReviewConfig>(AUTO_REVIEW_SECTION)?.model;
    if (configured !== undefined) this.assertReviewModelValid(configured);
  }

  private async bindingFor(
    mainModelAlias: string,
    signal: AbortSignal,
  ): Promise<ReviewBinding> {
    const config = this.configService.get<AutoReviewConfig>(AUTO_REVIEW_SECTION);
    if (config?.model !== undefined) return { modelAlias: config.model, effort: config.effort };
    const mainModel = this.tryGetModel(mainModelAlias);
    if (mainModel !== undefined && isManagedKimiModel(mainModel)) {
      const cloud = this.cloudConfig.peek() ?? (await this.cloudConfig.load(signal));
      if (cloud !== undefined) {
        if (cloud.model !== undefined) {
          const resolved = this.resolveManagedModelAlias(cloud.model, mainModel);
          if (
            resolved !== undefined &&
            (config?.effort === undefined || safeCloudEffort(resolved.model, config.effort) !== undefined)
          ) {
            return {
              modelAlias: resolved.alias,
              effort: config?.effort ?? safeCloudEffort(resolved.model, cloud.effort),
            };
          }
          return { modelAlias: mainModelAlias, effort: config?.effort };
        }
        return {
          modelAlias: mainModelAlias,
          effort: config?.effort ?? safeCloudEffort(mainModel, cloud.effort),
        };
      }
    }
    return { modelAlias: mainModelAlias, effort: config?.effort };
  }

  private hasManagedKimiProvider(): boolean {
    const providers = this.configService.get<ProvidersSection | undefined>(PROVIDERS_SECTION);
    if (providers === undefined) return false;
    return Object.entries(providers).some(
      ([id, provider]) => isManagedKimiCode(id) || isManagedKimiCodeBaseUrl(provider.baseUrl),
    );
  }

  private tryGetModel(alias: string): Model | undefined {
    try {
      return this.providerCatalog.get(alias);
    } catch {
      return undefined;
    }
  }

  private resolveManagedModelAlias(
    target: string,
    mainModel: Model,
  ): { readonly alias: string; readonly model: Model } | undefined {
    const byName = this.providerCatalog.findByName(target);
    const candidates = new Set<string>([
      ...byName,
      `${KIMI_CODE_PLATFORM_ID}/${target}`,
      target,
    ]);
    let fallback: { readonly alias: string; readonly model: Model } | undefined;
    for (const alias of candidates) {
      const model = this.tryGetModel(alias);
      if (model === undefined || !isManagedKimiModel(model)) continue;
      if (model.providerName === mainModel.providerName) {
        return { alias, model };
      }
      fallback ??= { alias, model };
    }
    return fallback;
  }

  private assertReviewModelValid(modelAlias: string): void {
    const config = this.configService.get<AutoReviewConfig>(AUTO_REVIEW_SECTION);
    if (modelAlias !== config?.model && config?.effort === undefined) return;
    let model;
    try {
      model = this.providerCatalog.get(modelAlias);
    } catch (error) {
      const source = modelAlias === config?.model ? '[auto_review].model' : 'Auto Review model';
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        `${source} "${modelAlias}" could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error, details: { section: AUTO_REVIEW_SECTION, field: 'model', model: modelAlias } },
      );
    }
    if (config?.effort === undefined) return;
    assertModelSupportsConfiguredEffort(
      { section: AUTO_REVIEW_SECTION, field: 'effort', key: '[auto_review].effort' },
      config.effort,
      modelAlias,
      model,
    );
  }

  private async runWithDeadline(
    input: SessionReviewInput,
    binding: ReviewBinding,
  ): Promise<AutoReviewOutcome> {
    const { deadline } = input;
    let acquired = false;
    try {
      await this.acquireSlot(deadline.signal);
      acquired = true;
      for (let attempt = 1; ; attempt += 1) {
        const result = await this.reviewOnce(input, binding);
        if (result.decision !== 'retry') return result;
        if (attempt === MAX_REVIEW_ATTEMPTS) return { decision: 'failed', reason: result.reason };
        const remainingMs = deadline.remainingMs();
        if (remainingMs <= 0 || deadline.signal.aborted) return deadlineFailure(deadline);
        if (result.retryAfterMs !== undefined && result.retryAfterMs >= remainingMs) {
          return { decision: 'failed', reason: result.reason };
        }
        const delayMs = Math.min(result.retryAfterMs ?? retryBackoffDelay(attempt - 1), remainingMs);
        await sleepForRetry(delayMs, deadline.signal);
      }
    } catch (error) {
      if (deadline.signal.aborted) return deadlineFailure(deadline);
      return { decision: 'failed', reason: error instanceof Error ? error.message : String(error) };
    } finally {
      if (acquired) this.releaseSlot();
    }
  }

  private async reviewOnce(
    input: SessionReviewInput,
    binding: ReviewBinding,
  ): Promise<AttemptResult> {
    const { deadline } = input;
    let outcome: LlmOutcome;
    try {
      outcome = await this.sendRequest(input, binding, deadline.signal);
    } catch (error) {
      if (deadline.signal.aborted) return deadlineFailure(deadline);
      const mapped = llmMessageFromError(error);
      if (mapped !== undefined) return classifyLlmError(mapped);
      throw error;
    }
    if (outcome.type === 'aborted') return deadlineFailure(deadline);
    if (outcome.type === 'failed') return classifyFailedOutcome(outcome, deadline);
    void this.usage.record(input.agentContext, binding.modelAlias, outcome.usage, {
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
    input: SessionReviewInput,
    binding: ReviewBinding,
    signal: AbortSignal,
  ): Promise<LlmOutcome> {
    const model = this.providerCatalog.get(binding.modelAlias);
    const overrides = this.configService.get<ModelOverrides>('modelOverrides');
    const thinkingConfig = this.configService.get<ThinkingConfig>(THINKING_SECTION);
    const strict = requiresStrictThinkingValidation(this.providerCatalog, model.protocol, model.providerType);
    const requestedEffort = resolveSubagentThinking(this.configService, model, binding.effort);
    const resolvedEffort = resolveThinkingEffortForModel(requestedEffort, thinkingConfig, model.spec, strict);
    const thinkingEffort = binding.effort !== undefined
      ? resolvedEffort
      : (resolveForcedThinkingEffort(
          thinkingConfig?.forcedEffort,
          resolvedEffort,
          drivesThinkingThroughTraits(model.providerType),
        ) ?? resolvedEffort);
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
    return this.providerCatalog.createRequester(model, params, this.requesterExecution).with({
      model: { responseFormat: RESPONSE_FORMAT },
      profile: { systemPrompt: REVIEW_POLICY, tools: [] },
      content: { messages: input.messages },
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

function isManagedKimiModel(model: Model): boolean {
  return isManagedKimiCode(model.providerName) || isManagedKimiCodeBaseUrl(model.endpoint.baseUrl);
}

function safeCloudEffort(model: Model, configured: string | undefined): string | undefined {
  const effort = normalizeRequestedThinkingEffort(configured);
  if (effort === undefined) return undefined;
  if (effort === 'off') {
    if (model.spec.thinking?.alwaysThinking === true) return undefined;
    if (model.spec.thinking?.supportEfforts !== undefined && model.spec.thinking.offEffort === undefined) {
      return undefined;
    }
  }
  if (!modelSupportsThinkingEffort(effort, model.spec, true)) return undefined;
  return configured;
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
  if (isRetryableError(error)) {
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
