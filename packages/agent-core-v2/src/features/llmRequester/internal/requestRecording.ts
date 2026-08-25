import { createHash } from 'node:crypto';

import type { LogContext } from '#/_base/log/log';
import { ILogService } from '#/_base/log/log';
import { isAbortError } from '#/_base/utils/abort';
import { retryErrorFields } from '#/_base/utils/retry';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolSelectService } from '#/agent/toolSelect/toolSelect';
import { IConfigService } from '#/app/config/config';
import { THINKING_SECTION } from '#/app/kosongConfig/configSection';
import type { ApiErrorEvent } from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { unwrapErrorCause } from '#/errors';
import type { ProjectionPolicy } from '#/agent/contextProjector/contextProjector';
import type {
  AgentLLMRequestLogFields,
  AgentLLMRequestOverrides,
  AgentLLMRequestSource,
} from '#/features/llmRequester/llmRequester';
import {
  LlmRequest,
  LlmToolsSnapshot,
  type LlmRequestPayload,
  type LlmRequestToolSchema,
} from '#/features/llmRequester/llmRequesterOps';
import {
  APIStatusError,
  classifyApiError,
  isRetryableGenerateError,
} from '#/kosong/contract/errors';
import type { Message } from '#/kosong/contract/message';
import type { ThinkingEffort } from '#/kosong/contract/provider';
import type { Tool } from '#/kosong/contract/tool';
import { inputTotal, type TokenUsage } from '#/kosong/contract/usage';
import { IModelCatalog, type Model } from '#/kosong/model/catalog';
import { IModelService } from '#/kosong/model/model';
import type { ModelOverrides } from '#/kosong/model/model.types';
import type { ModelRequestTiming } from '#/kosong/model/modelRequester';
import { resolveThinkingKeep, type ThinkingConfig } from '#/kosong/model/thinking';
import type { Protocol } from '#/kosong/protocol/protocol';
import { ISessionUsageService } from '#/session/usage/sessionUsage';

import type { LlmRequesterOperationContext } from './requestContext';

export interface LLMRequestLogInput {
  readonly protocol: Protocol;
  readonly providerType?: string;
  readonly modelName: string;
  readonly modelAlias?: string;
  readonly thinkingEffort?: ThinkingEffort | null;
  readonly maxTokens?: number;
  readonly systemPrompt: string;
  readonly tools: readonly Tool[];
  readonly messages: readonly Message[];
  readonly fields?: AgentLLMRequestLogFields;
}

export function logRequest(context: LlmRequesterOperationContext, input: LLMRequestLogInput): void {
  const logFields: AgentLLMRequestLogFields = input.fields ?? {};
  const wireTools = providerVisibleTools(input.tools);
  const config = {
    provider: input.protocol,
    model: input.modelName,
    modelAlias: input.modelAlias,
    thinkingEffort: input.thinkingEffort ?? undefined,
    systemPromptChars: input.systemPrompt.length,
    toolCount: wireTools.length,
  };
  const signature = JSON.stringify({
    ...config,
    systemPromptHash: fingerprint(input.systemPrompt),
    toolsHash: fingerprint(JSON.stringify(toolSignature(wireTools))),
  });
  if (signature !== context.effects.lastConfigLogSignature) {
    context.effects.lastConfigLogSignature = signature;
    context.runtime.get(ILogService).info('llm config', { ...logFields, ...config });
  }

  const partialMessageCount = input.messages.filter((message) => message.partial === true).length;
  const requestFields: LogContext = { ...logFields };
  if (partialMessageCount > 0) requestFields['partialMessageCount'] = partialMessageCount;
  context.runtime.get(ILogService).info('llm request', requestFields);
}

export async function recordRequest(
  context: LlmRequesterOperationContext,
  input: LLMRequestLogInput,
): Promise<void> {
  const fields = input.fields ?? {};
  const wireTools = providerVisibleTools(input.tools);
  const tools = toolSignature(wireTools);
  const toolsHash = fingerprint(JSON.stringify(tools));
  const agentId = context.runtime.get(IAgentScopeContext).agentId;
  if (!context.runtime.getState().seenToolsHashes.includes(toolsHash)) {
    await context.runtime.dispatch(
      new LlmToolsSnapshot({ agentId, hash: toolsHash, tools }),
    );
  }

  const systemPromptHash = fingerprint(input.systemPrompt);
  const config = context.runtime.get(IConfigService);
  const overrides = config.get<ModelOverrides>('modelOverrides');
  const thinkingConfig = config.get<ThinkingConfig>(THINKING_SECTION);
  const modelConfig =
    input.modelAlias === undefined
      ? undefined
      : context.runtime.get(IModelService).get(input.modelAlias);
  const payload: LlmRequestPayload = {
    agentId,
    kind: requestKindForRecord(fields),
    provider: input.protocol,
    model: input.modelName,
    modelAlias: input.modelAlias,
    thinkingEffort: input.thinkingEffort ?? undefined,
    thinkingKeep: resolveThinkingKeep(
      overrides?.thinkingKeep,
      thinkingConfig?.keep,
      input.thinkingEffort ?? 'off',
    ),
    temperature: overrides?.temperature,
    topP: overrides?.topP,
    maxTokens: input.maxTokens,
    betaApi: modelConfig?.betaApi,
    toolSelect: context.runtime.get(IAgentToolSelectService).enabled(),
    systemPromptHash,
    systemPrompt:
      input.systemPrompt === context.runtime.get(IAgentProfileService).data().systemPrompt
        ? undefined
        : input.systemPrompt,
    toolsHash,
    messageCount: input.messages.length,
    turnStep: stringField(fields, 'turnStep'),
    attempt: stringField(fields, 'attempt'),
    projection: projectionField(fields),
    droppedCount: numberField(fields, 'droppedCount'),
  };
  await context.runtime.dispatch(new LlmRequest(payload));
}

export function logResponse(
  context: LlmRequesterOperationContext,
  fields: AgentLLMRequestLogFields | undefined,
  usage: TokenUsage,
  timing: ModelRequestTiming | undefined,
): void {
  if (timing === undefined) return;
  const payload: LogContext = {
    ...fields,
    ttftMs: timing.firstTokenLatencyMs,
    streamDurationMs: timing.streamDurationMs,
    outputTokens: usage.output,
  };
  if (timing.requestBuildMs !== undefined) payload['requestBuildMs'] = timing.requestBuildMs;
  if (timing.serverFirstTokenMs !== undefined) {
    payload['serverFirstTokenMs'] = timing.serverFirstTokenMs;
  }
  if (timing.serverDecodeMs !== undefined) payload['serverDecodeMs'] = timing.serverDecodeMs;
  if (timing.clientConsumeMs !== undefined) payload['clientConsumeMs'] = timing.clientConsumeMs;
  context.runtime.get(ILogService).info('llm response', payload);
}

export function logRequestFailure(
  context: LlmRequesterOperationContext,
  error: unknown,
  overrides: AgentLLMRequestOverrides,
  signal: AbortSignal | undefined,
): void {
  if (isAbortError(error) || signal?.aborted === true) return;
  const payload: LogContext = {
    ...logFieldsForSource(overrides.source),
    model: context.runtime.get(IAgentProfileService).data().modelAlias ?? 'unknown',
    ...retryErrorFields(error),
  };
  context.runtime.get(ILogService).warn('llm request failed', payload);
}

export function trackApiError(
  context: LlmRequesterOperationContext,
  error: unknown,
  startedAt: number,
  signal: AbortSignal | undefined,
  source?: AgentLLMRequestSource,
  requestTraceId?: string,
): string | undefined {
  if (isAbortError(error) || signal?.aborted === true) return requestTraceId;
  const modelAlias = context.runtime.get(IAgentProfileService).data().modelAlias;
  const model = tryGetModel(context);
  const traceId = requestTraceId ?? apiTraceId(error);
  const classification = classifyApiError(unwrapErrorCause(error));
  const properties: ApiErrorEvent = {
    error_type: classification.kind,
    model: model?.id ?? modelAlias ?? 'unknown',
    alias: modelAlias,
    provider_type: model?.providerType ?? model?.protocol,
    protocol: model?.protocol,
    retryable: isRetryableGenerateError(error),
    duration_ms: Math.max(0, Date.now() - startedAt),
    turn_id: source?.turnId,
    request_kind: requestKindForTelemetry(source),
    trace_id: traceId,
  };
  if (source?.type === 'turn') {
    if (source.step !== undefined) properties['step_no'] = source.step;
  }
  const statusCode = apiStatusCode(error);
  if (statusCode !== undefined) properties['status_code'] = statusCode;
  const currentTurn = context.runtime
    .get(ISessionUsageService)
    .status(context.runtime.get(IAgentScopeContext).agentContext).currentTurn;
  if (currentTurn !== undefined) properties['input_tokens'] = inputTotal(currentTurn);
  context.runtime.get(ITelemetryService).track2('api_error', properties);
  return traceId;
}

function tryGetModel(context: LlmRequesterOperationContext): Model | undefined {
  const modelAlias = context.runtime.get(IAgentProfileService).data().modelAlias;
  if (modelAlias === undefined) return undefined;
  try {
    return context.runtime.get(IModelCatalog).get(modelAlias);
  } catch {
    return undefined;
  }
}

export function logFieldsForSource(source: AgentLLMRequestSource | undefined): AgentLLMRequestLogFields {
  switch (source?.type) {
    case 'turn':
      return {
        ...source.logFields,
        ...(source.step === undefined
          ? {}
          : { turnStep: `${String(source.turnId)}.${String(source.step)}` }),
      };
    case 'operation':
      return {
        ...source.logFields,
        ...(source.requestKind === undefined ? {} : { requestKind: source.requestKind }),
      };
    default:
      return {};
  }
}

function requestKindForTelemetry(source: AgentLLMRequestSource | undefined): string | undefined {
  if (source?.type === 'turn') return 'turn';
  if (source?.type === 'operation') return source.requestKind ?? 'operation';
  return undefined;
}

function providerVisibleTools(tools: readonly Tool[]): readonly Tool[] {
  if (!tools.some((tool) => tool.deferred === true)) return tools;
  return tools.filter((tool) => tool.deferred !== true);
}

function toolSignature(tools: readonly Tool[]): readonly LlmRequestToolSchema[] {
  return tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

function requestKindForRecord(fields: AgentLLMRequestLogFields): LlmRequestPayload['kind'] {
  if (fields['kind'] === 'compaction') return 'compaction';
  if (fields['requestKind'] === 'full_compaction') return 'compaction';
  return 'loop';
}

function stringField(fields: AgentLLMRequestLogFields, key: string): string | undefined {
  const value = fields[key];
  return typeof value === 'string' ? value : undefined;
}

function numberField(fields: AgentLLMRequestLogFields, key: string): number | undefined {
  const value = fields[key];
  return typeof value === 'number' ? value : undefined;
}

export type LlmRequestProjection = NonNullable<LlmRequestPayload['projection']>;

export function projectionNameOf(policy: ProjectionPolicy | undefined): LlmRequestProjection | undefined {
  if (policy?.structure === 'strict') {
    if (policy.media === 'degraded') return 'strict-media-degraded';
    if (typeof policy.media === 'object') return 'strict-media-stripped';
    return 'strict';
  }
  if (policy === undefined) return undefined;
  if (policy.media === 'degraded') return 'media-degraded';
  if (typeof policy.media === 'object') return 'media-stripped';
  return undefined;
}

function projectionField(fields: AgentLLMRequestLogFields): LlmRequestProjection | undefined {
  const value = fields['projection'];
  switch (value) {
    case 'strict':
    case 'media-degraded':
    case 'media-stripped':
    case 'strict-media-degraded':
    case 'strict-media-stripped':
      return value;
    default:
      return undefined;
  }
}

function fingerprint(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function apiStatusCode(error: unknown): number | undefined {
  const raw = unwrapErrorCause(error);
  if (raw instanceof APIStatusError) return raw.statusCode;
  if (typeof raw === 'object' && raw !== null) {
    const statusCode = (raw as Record<string, unknown>)['statusCode'];
    if (typeof statusCode === 'number') return statusCode;
    const status = (raw as Record<string, unknown>)['status'];
    if (typeof status === 'number') return status;
  }
  if (typeof error === 'object' && error !== null) {
    const details = (error as Record<string, unknown>)['details'];
    if (typeof details === 'object' && details !== null) {
      const statusCode = (details as Record<string, unknown>)['statusCode'];
      if (typeof statusCode === 'number') return statusCode;
    }
  }
  return undefined;
}

function apiTraceId(error: unknown): string | undefined {
  const raw = unwrapErrorCause(error);
  if (raw instanceof APIStatusError && raw.traceId !== null) return raw.traceId;
  if (typeof error === 'object' && error !== null) {
    const details = (error as Record<string, unknown>)['details'];
    if (typeof details === 'object' && details !== null) {
      const traceId = (details as Record<string, unknown>)['traceId'];
      if (typeof traceId === 'string') return traceId;
    }
  }
  return undefined;
}
