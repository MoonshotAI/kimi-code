import { ILogService } from '#/_base/log/log';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import {
  IAgentContextProjectorService,
  type MediaStripSnapshot,
  type ProjectionPolicy,
} from '#/agent/contextProjector/contextProjector';
import { IAgentMediaResolverService } from '#/agent/media/mediaResolver';
import { IAgentProfileService } from '#/agent/profile/profile';
import { WarningIssued } from '#/agent/profile/profileOps';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentToolSelectService } from '#/agent/toolSelect/toolSelect';
import { IConfigService } from '#/app/config/config';
import { ErrorCodes, Error2, unwrapErrorCause } from '#/errors';
import type {
  AgentLLMRequestFinish,
  AgentLLMRequestLogFields,
  AgentLLMRequestOverrides,
  AgentLLMRequestPartHandler,
  AgentLLMRequestSource,
  AgentLLMRequestTask,
  PreparedTurnRequestConfig,
} from '#/features/llmRequester/llmRequester';
import {
  APIRequestTooLargeError,
  isImageFormatError,
  isRecoverableRequestStructureError,
} from '#/kosong/contract/errors';
import { isToolCall, type Message, type StreamedMessagePart } from '#/kosong/contract/message';
import { type ThinkingEffort } from '#/kosong/contract/provider';
import type { LLMRequestTrace } from '#/kosong/contract/requestTrace';
import { type Tool } from '#/kosong/contract/tool';
import { emptyUsage, type TokenUsage } from '#/kosong/contract/usage';
import { IModelCatalog, type Model } from '#/kosong/model/catalog';
import { completionBudgetParams, resolveCompletionBudget } from '#/kosong/model/completionBudget';
import type { ModelOverrides } from '#/kosong/model/model.types';
import {
  effectiveMaxCompletionTokens,
  type ModelRequestEvent,
  type ModelRequestParams,
  type ModelRequester,
  type ModelRequestTiming,
} from '#/kosong/model/modelRequester';
import { ISessionTokenCountingService } from '#/session/tokenCounting/sessionTokenCounting';
import { ISessionUsageService } from '#/session/usage/sessionUsage';

import {
  type LlmRequesterOperationContext,
  type TurnRequestConfig,
} from './requestContext';
import {
  logFieldsForSource,
  logRequest,
  logRequestFailure,
  logResponse,
  projectionNameOf,
  recordRequest,
  trackApiError,
  type LLMRequestLogInput,
} from './requestRecording';
import type { ToolCallIdResponseNormalizer } from './toolCallIdNormalizer';

const EMPTY_TOOL_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {},
};

const noopOnPart: AgentLLMRequestPartHandler = () => {};

interface ResolvedLLMRequest {
  readonly requester: ModelRequester;
  readonly model: Model;
  readonly params: ModelRequestParams;
  readonly modelAlias: string;
  readonly thinkingEffort: ThinkingEffort;
  readonly systemPrompt: string;
  readonly tools: readonly Tool[];
  readonly messages: Message[];
  readonly source: AgentLLMRequestSource | undefined;
  readonly logFields: AgentLLMRequestLogFields;
}

export function prepareTurnConfig(
  context: LlmRequesterOperationContext,
  turnId: number,
): PreparedTurnRequestConfig | undefined {
  if (!context.runtime.get(IAgentProfileService).hasProvider()) return undefined;
  const config = getOrCreateTurnConfig(context, turnId);
  return { thinkingEffort: config.resolved.thinkingLevel };
}

export async function request(
  context: LlmRequesterOperationContext,
  overrides: AgentLLMRequestOverrides = {},
  onPart: AgentLLMRequestPartHandler = noopOnPart,
  signal?: AbortSignal,
): Promise<AgentLLMRequestFinish> {
  return start(context, overrides, onPart, signal).result;
}

export function start(
  context: LlmRequesterOperationContext,
  overrides: AgentLLMRequestOverrides = {},
  onPart: AgentLLMRequestPartHandler = noopOnPart,
  signal?: AbortSignal,
): AgentLLMRequestTask {
  const trace = new MutableLLMRequestTrace();
  return {
    trace,
    result: requestWithTrace(context, trace, overrides, onPart, signal),
  };
}

async function requestWithTrace(
  context: LlmRequesterOperationContext,
  trace: MutableLLMRequestTrace,
  overrides: AgentLLMRequestOverrides,
  onPart: AgentLLMRequestPartHandler,
  signal: AbortSignal | undefined,
): Promise<AgentLLMRequestFinish> {
  signal?.throwIfAborted();
  const startedAt = Date.now();
  trace.set(undefined);
  try {
    return await runRequest(
      context,
      resolveRequest(context, overrides),
      onPart,
      signal,
      (traceId) => {
        trace.set(traceId);
      },
    );
  } catch (error) {
    logRequestFailure(context, error, overrides, signal);
    trace.set(trackApiError(context, error, startedAt, signal, overrides.source, trace.traceId));
    throw error;
  }
}

async function runRequest(
  context: LlmRequesterOperationContext,
  request: ResolvedLLMRequest,
  onPart: AgentLLMRequestPartHandler,
  signal: AbortSignal | undefined,
  onRequestTrace: (traceId: string | undefined) => void,
): Promise<AgentLLMRequestFinish> {
  const agentContext = context.runtime.get(IAgentScopeContext).agentContext;
  context.effects.toolCallIdNormalizer.seedFrom(context.runtime.get(IAgentContextMemoryService).get());
  const shaped = context.runtime.get(IAgentToolSelectService).shapeHistory(request.messages);
  const recoveredStrip = mediaStripSnapshotForTurn(context, request.source);
  let policy: ProjectionPolicy | undefined =
    recoveredStrip !== undefined
      ? { media: { strip: recoveredStrip } }
      : isRecoveryTurn(context.effects.mediaDegradedTurns, request.source)
        ? { media: 'degraded' }
        : undefined;
  const captureMediaStripPolicy = (): { readonly strip: MediaStripSnapshot } => {
    const snapshot = context.runtime.get(IAgentContextProjectorService).captureMediaStripSnapshot(shaped);
    markMediaStrippedRecoveryTurn(context, snapshot, request.source);
    return { strip: snapshot };
  };
  const run = async (
    policy: ProjectionPolicy | undefined,
  ): Promise<AgentLLMRequestFinish> => {
    onRequestTrace(undefined);
    const projection = projectionNameOf(policy);
    const fields =
      projection === undefined ? request.logFields : { ...request.logFields, projection };
    const input = {
      systemPrompt: request.systemPrompt,
      tools: request.tools,
      messages: await context.runtime.get(IAgentMediaResolverService).resolve(
        context.runtime.get(IAgentContextProjectorService).project(shaped, policy),
        request.requester,
        signal,
      ),
    };
    warnAboutAnthropicThinkingEffort(context, request);
    const logInput: LLMRequestLogInput = {
      protocol: request.model.protocol,
      providerType: request.model.providerType,
      modelName: request.model.name,
      modelAlias: request.modelAlias,
      thinkingEffort: request.thinkingEffort,
      maxTokens: effectiveMaxCompletionTokens(request.params),
      systemPrompt: input.systemPrompt,
      tools: input.tools,
      messages: input.messages,
      fields,
    };
    logRequest(context, logInput);
    await recordRequest(context, logInput);

    let message: Message | undefined;
    let usage: TokenUsage | undefined;
    let timing: ModelRequestTiming | undefined;
    let finish: Extract<ModelRequestEvent, { type: 'finish' }> | undefined;
    const toolCallIds = context.effects.toolCallIdNormalizer.beginResponse();

    const setTraceId = (traceId: string | null | undefined): void => {
      const normalized = traceId ?? undefined;
      onRequestTrace(normalized);
    };

    try {
      for await (const event of request.requester.request(input, signal, {
        ...request.params,
        onTraceId: setTraceId,
      })) {
        switch (event.type) {
          case 'part':
            await onPart(normalizeStreamPart(toolCallIds, event.part));
            break;
          case 'usage':
            usage = event.usage;
            break;
          case 'finish':
            finish = event;
            message = event.message;
            setTraceId(event.traceId);
            break;
          case 'timing': {
            const { type: _type, ...streamTiming } = event;
            timing = streamTiming;
            break;
          }
        }
      }

      if (message === undefined || finish === undefined) {
        throw new Error2(
          ErrorCodes.PROVIDER_API_ERROR,
          'LLM request stream ended without a finish event.',
        );
      }

      const finalizedCalls = toolCallIds.remapFinalizedCalls(message.toolCalls);
      if (finalizedCalls !== message.toolCalls) {
        message = { ...message, toolCalls: finalizedCalls };
      }
      for (const { raw, assigned } of toolCallIds.remapped) {
        context.runtime.get(ILogService).warn('Rewrote a duplicate provider tool call id into an agent-unique one.', {
          raw,
          assigned,
          model: request.modelAlias,
        });
      }
    } catch (error) {
      toolCallIds.rollback();
      throw error;
    }

    void context.runtime.get(ISessionUsageService).record(
      agentContext,
      request.modelAlias,
      usage ?? emptyUsage(),
      request.source,
    );
    if (usage !== undefined) {
      context.runtime.get(ISessionTokenCountingService).measured(agentContext, request.messages, [message], usage);
    }
    logResponse(context, request.logFields, usage ?? emptyUsage(), timing);

    return {
      message,
      usage: usage ?? emptyUsage(),
      model: request.modelAlias,
      providerFinishReason: finish.providerFinishReason,
      rawFinishReason: finish.rawFinishReason,
      providerMessageId: finish.id,
      timing,
      traceId: finish.traceId,
    };
  };

  for (;;) {
    try {
      return await run(policy);
    } catch (error) {
      const nextPolicy = nextProjectionPolicyForError(
        context,
        error,
        policy,
        request,
        signal,
        captureMediaStripPolicy,
      );
      if (nextPolicy === undefined) throw error;
      policy = nextPolicy;
    }
  }
}

function nextProjectionPolicyForError(
  context: LlmRequesterOperationContext,
  error: unknown,
  policy: ProjectionPolicy | undefined,
  request: ResolvedLLMRequest,
  signal: AbortSignal | undefined,
  captureMediaStripPolicy: () => { readonly strip: MediaStripSnapshot },
): ProjectionPolicy | undefined {
  if (signal?.aborted === true) return undefined;
  const raw = unwrapErrorCause(error);
  const media = policy?.media;
  if (
    raw instanceof APIRequestTooLargeError &&
    (media === undefined || media === 'degraded')
  ) {
    signal?.throwIfAborted();
    if (media === undefined) {
      context.runtime.get(ILogService).warn('provider rejected request as too large; resending with degraded media', {
        model: request.model.name,
        ...request.logFields,
      });
      markRecoveryTurn(context.effects.mediaDegradedTurns, request.source);
      return { ...policy, media: 'degraded' };
    }
    context.runtime.get(ILogService).warn(
      'provider rejected degraded-media request as too large; resending with rejected media stripped',
      {
        model: request.model.name,
        ...request.logFields,
      },
    );
    return { ...policy, media: captureMediaStripPolicy() };
  }
  if (typeof media !== 'object' && isImageFormatError(raw)) {
    signal?.throwIfAborted();
    context.runtime.get(ILogService).warn(
      'provider rejected an image in the request; resending with rejected media stripped',
      {
        model: request.model.name,
        ...request.logFields,
      },
    );
    return { ...policy, media: captureMediaStripPolicy() };
  }
  if (policy?.structure === undefined && isRecoverableRequestStructureError(raw)) {
    signal?.throwIfAborted();
    context.runtime.get(ILogService).warn('provider rejected request structure; resending with strict projection', {
      model: request.model.name,
      ...request.logFields,
    });
    return { ...policy, structure: 'strict' };
  }
  return undefined;
}

function normalizeStreamPart(
  toolCallIds: ToolCallIdResponseNormalizer,
  part: StreamedMessagePart,
): StreamedMessagePart {
  if (!isToolCall(part)) return part;
  const assigned = toolCallIds.remapStreamedId(part.id, part._streamIndex);
  return assigned === part.id ? part : { ...part, id: assigned };
}

function warnAboutAnthropicThinkingEffort(
  context: LlmRequesterOperationContext,
  request: ResolvedLLMRequest,
): void {
  if (request.model.protocol !== 'anthropic') return;
  const effort = request.thinkingEffort;
  if (effort === 'on' || effort === 'off') return;

  let code: string;
  let message: string;
  let knownEfforts: string | undefined;
  const supportEfforts = request.model.supportEfforts?.filter((value) => value.length > 0);
  if (supportEfforts === undefined || supportEfforts.length === 0) return;
  if (supportEfforts.includes(effort)) return;
  code = 'anthropic-thinking-effort-not-listed';
  knownEfforts = supportEfforts.join(',');
  message = `Thinking effort "${effort}" is not listed for model "${request.model.name}" (known: ${supportEfforts.join(', ')}). The configured value will be sent unchanged to the Anthropic-compatible backend.`;

  const key = [code, request.modelAlias, request.model.name, effort, knownEfforts].join(' ');
  if (context.effects.emittedThinkingEffortWarnings.has(key)) return;
  context.effects.emittedThinkingEffortWarnings.add(key);
  try {
    context.runtime.get(ILogService).warn(message, {
      modelAlias: request.modelAlias,
      model: request.model.name,
      effort,
      knownEfforts,
    });
  } catch {
  }
  try {
    void context.runtime.dispatch(
      new WarningIssued({ agentId: context.runtime.get(IAgentScopeContext).agentId, code, message }),
    );
  } catch {
  }
}

function isRecoveryTurn(set: ReadonlySet<number>, source: AgentLLMRequestSource | undefined): boolean {
  if (source?.type !== 'turn') return false;
  return set.has(source.turnId);
}

function mediaStripSnapshotForTurn(
  context: LlmRequesterOperationContext,
  source: AgentLLMRequestSource | undefined,
): MediaStripSnapshot | undefined {
  if (source?.type !== 'turn') return undefined;
  return context.effects.mediaStrippedTurns.get(source.turnId);
}

function markMediaStrippedRecoveryTurn(
  context: LlmRequesterOperationContext,
  snapshot: MediaStripSnapshot,
  source: AgentLLMRequestSource | undefined,
): void {
  if (source?.type !== 'turn') return;
  const stripped = context.effects.mediaStrippedTurns;
  for (const id of stripped.keys()) {
    if (id < source.turnId) stripped.delete(id);
  }
  stripped.set(source.turnId, snapshot);
}

function markRecoveryTurn(set: Set<number>, source: AgentLLMRequestSource | undefined): void {
  if (source?.type !== 'turn') return;
  for (const id of set) {
    if (id < source.turnId) set.delete(id);
  }
  set.add(source.turnId);
}

function resolveRequest(
  context: LlmRequesterOperationContext,
  overrides: AgentLLMRequestOverrides,
): ResolvedLLMRequest {
  const profile = context.runtime.get(IAgentProfileService);
  const turnConfig = resolveTurnConfig(context, overrides.source);
  const resolved = turnConfig?.resolved ?? profile.resolveModelContext();
  const baseParams = turnConfig?.params ?? profile.resolveRequestParams();
  const budgetParams = completionBudgetParams({
    budget: resolveCompletionBudget({
      maxOutputSize: overrides.maxOutputSize ?? resolved.maxOutputSize,
      reservedContextSize: resolved.reservedContextSize,
      maxCompletionTokensCap:
        context.runtime.get(IConfigService).get<ModelOverrides>('modelOverrides')?.maxCompletionTokens,
    }),
    capability: resolved.modelCapabilities,
    usedContextTokens:
      overrides.messages === undefined
        ? context.runtime.get(ISessionTokenCountingService).get(
            context.runtime.get(IAgentScopeContext).agentContext,
          ).measured
        : undefined,
  });
  const requester = context.runtime.get(IModelCatalog).getRequester(resolved.modelAlias);

  const messages = overrides.messages ?? context.runtime.get(IAgentContextMemoryService).get();
  return {
    requester,
    model: requester.model,
    params: { ...baseParams, ...budgetParams },
    modelAlias: resolved.modelAlias,
    thinkingEffort: resolved.thinkingLevel,
    systemPrompt: overrides.systemPrompt ?? turnConfig?.systemPrompt ?? profile.getSystemPrompt(),
    tools: [...(overrides.tools ?? defaultTools(context))],
    messages: [...messages],
    source: overrides.source,
    logFields: logFieldsForSource(overrides.source),
  };
}

function resolveTurnConfig(
  context: LlmRequesterOperationContext,
  source: AgentLLMRequestSource | undefined,
): TurnRequestConfig | undefined {
  if (source?.type !== 'turn') return undefined;
  return getOrCreateTurnConfig(context, source.turnId);
}

function getOrCreateTurnConfig(
  context: LlmRequesterOperationContext,
  turnId: number,
): TurnRequestConfig {
  const turnConfigs = context.effects.turnConfigs;
  for (const id of turnConfigs.keys()) {
    if (id < turnId) turnConfigs.delete(id);
  }
  let snapshot = turnConfigs.get(turnId);
  if (snapshot === undefined) {
    const profile = context.runtime.get(IAgentProfileService);
    snapshot = {
      resolved: profile.resolveModelContext(),
      params: profile.resolveRequestParams(),
      systemPrompt: profile.getSystemPrompt(),
    };
    turnConfigs.set(turnId, snapshot);
  }
  return snapshot;
}

function defaultTools(context: LlmRequesterOperationContext): readonly Tool[] {
  return context.runtime.get(IAgentToolSelectService)
    .shapeTools(context.runtime.get(IAgentToolRegistryService).list())
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? EMPTY_TOOL_PARAMETERS,
      deferred: tool.deferred,
    }));
}

class MutableLLMRequestTrace implements LLMRequestTrace {
  traceId: string | undefined;

  set(traceId: string | undefined): void {
    this.traceId = traceId;
  }
}
