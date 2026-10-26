import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';

import { afterEach } from 'vitest';

import { IInstantiationService } from '#/_base/di/instantiation';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { matchSingleMediaPathTag } from '#/agent/media/mediaRef';
import { IAgentProfileService } from '#/agent/profile/profile';
import { agentContextOfScope, IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import type {
  AgentLLMRequestOverrides,
  AgentLLMRequestPartHandler,
  AgentLLMRequestSource,
  AgentLLMRequestTask,
  AgentLLMTurnRequestSnapshot,
  IAgentLLMRequesterService,
  PreparedTurnRequestConfig,
} from '#/agent/llmRequester/llmRequester';
import {
  AgentLLMRequesterService,
  llmRequesterMediaRecoveryKey,
} from '#/agent/llmRequester/llmRequesterService';
import { IAgentStateService } from '#/agent/state/agentState';
import type { ContentPart, Message } from '#/llm-adapter/contract/message';
import {
  estimateTokens,
  estimateTokensForMessage,
  estimateTokensForMessages,
  estimateTokensForTools,
} from '#/llm-adapter/contract/tokens';
import { ISessionTokenCountingService } from '#/session/tokenCounting/sessionTokenCounting';
import type {
  LlmCredentialProvider,
  LlmRequestConfig,
  LlmRequester,
} from '#human/llm/requester/requester';

import { generateCallOf } from './scripted-generate';
import { findGenerateCallPrefixBreak, type GenerateCall } from './snapshots';

interface RequestScope {
  readonly agent: object;
  readonly source: AgentLLMRequestSource | undefined;
  readonly contextRevision: number;
  readonly mediaDegraded: boolean;
  readonly context: readonly Message[];
  readonly contextTokens: number;
  readonly contextWindow: number;
  readonly toolInputs: string;
  attempts: number;
}

interface RecordedRequest {
  readonly contextRevision: number;
  readonly model: string;
  readonly profile: Readonly<Record<(typeof PROFILE_FIELDS)[number], unknown>>;
  readonly toolInputs: string;
  readonly call: GenerateCall;
}

const PROFILE_FIELDS = [
  'cacheKey',
  'thinking',
  'extraParams',
  'responseFormat',
  'toolMessageConversion',
] as const;

const DEGRADED_PLACEHOLDERS = {
  image_url:
    '[image omitted: dropped to fit the provider request size limit; re-read the file to view it]',
  audio_url:
    '[audio omitted: dropped to fit the provider request size limit; re-read the file to hear it]',
  video_url:
    '[video omitted: dropped to fit the provider request size limit; re-read the file to view it]',
} as const;

const MEDIA_PATH_KIND = {
  image_url: 'image',
  audio_url: 'audio',
  video_url: 'video',
} as const;

const PREFIX_SHARING_OPERATIONS = new Set(['full_compaction']);
const INDEPENDENT_OPERATIONS = new Set(['direct_test']);
const CONTEXT_OVERFLOW_ERRORS = new Set(['APIContextOverflowError', 'APIRequestTooLargeError']);

const requestScope = new AsyncLocalStorage<RequestScope>();
const lastTurnRequests = new WeakMap<object, RecordedRequest>();
const compactionRevisions = new WeakMap<object, number>();
const overflowedAgents = new WeakSet<object>();
const violations: string[] = [];
let comparisons = 0;

export function promptCacheComparisons(): number {
  return comparisons;
}

export function takePromptCacheViolations(): string[] {
  return violations.splice(0);
}

export class PromptCacheGuardedLLMRequesterService implements IAgentLLMRequesterService {
  declare readonly _serviceBrand: undefined;

  private readonly inner: IAgentLLMRequesterService;

  constructor(
    @IInstantiationService instantiation: IInstantiationService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentStateService private readonly states: IAgentStateService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
    @ISessionTokenCountingService private readonly tokenCounting: ISessionTokenCountingService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
  ) {
    this.inner = instantiation.createInstance(AgentLLMRequesterService);
  }

  prepareTurnConfig(turnId: number): PreparedTurnRequestConfig | undefined {
    return this.inner.prepareTurnConfig(turnId);
  }

  currentCredentialProvider(): LlmCredentialProvider | undefined {
    return this.inner.currentCredentialProvider();
  }

  credentialProviderForTurn(turnId: number): LlmCredentialProvider | undefined {
    return this.inner.credentialProviderForTurn(turnId);
  }

  lastTurnRequest(): AgentLLMTurnRequestSnapshot | undefined {
    return this.inner.lastTurnRequest();
  }

  request(
    overrides?: AgentLLMRequestOverrides,
    onPart?: AgentLLMRequestPartHandler,
    signal?: AbortSignal,
  ) {
    return this.start(overrides, onPart, signal).result;
  }

  start(
    overrides?: AgentLLMRequestOverrides,
    onPart?: AgentLLMRequestPartHandler,
    signal?: AbortSignal,
  ): AgentLLMRequestTask {
    const contextRevision = this.context.prefixRevision();
    const recovery = this.states.get(llmRequesterMediaRecoveryKey);
    const profile = this.profile.data();
    const scope: RequestScope = {
      agent: this,
      source: overrides?.source,
      contextRevision,
      mediaDegraded: recovery?.media === 'degraded' && recovery.contextRevision === contextRevision,
      context: this.context.get(),
      contextTokens: this.tokenCounting.get(agentContextOfScope(this.scopeContext)).size,
      contextWindow:
        profile.modelCapabilities.max_input_tokens ?? profile.modelCapabilities.max_context_tokens,
      toolInputs: JSON.stringify([
        this.toolRegistry.list().map((tool) => tool.name).toSorted(),
        profile.activeToolNames ?? null,
      ]),
      attempts: 0,
    };
    return requestScope.run(scope, () => this.inner.start(overrides, onPart, signal));
  }
}

export function guardPromptCachePrefix(requester: LlmRequester): LlmRequester {
  return {
    async generate(config, content, control) {
      const scope = requestScope.getStore();
      if (scope === undefined) return requester.generate(config, content, control);
      const request: RecordedRequest = {
        contextRevision: scope.contextRevision,
        model: modelIdentity(config),
        profile: Object.fromEntries(PROFILE_FIELDS.map((field) => [field, config[field]])) as RecordedRequest['profile'],
        toolInputs: scope.toolInputs,
        call: generateCallOf(config, content),
      };
      scope.attempts += 1;
      checkPrefixExtension(scope, request, config);
      try {
        await requester.generate(config, content, control);
      } catch (error) {
        if (isContextOverflow(error)) overflowedAgents.add(scope.agent);
        throw error;
      }
      if (scope.source?.type === 'turn') lastTurnRequests.set(scope.agent, request);
    },
  };
}

afterEach(() => {
  const found = violations.splice(0);
  if (found.length > 0) throw new Error(found.join('\n\n'));
});

function checkPrefixExtension(
  scope: RequestScope,
  request: RecordedRequest,
  config: LlmRequestConfig,
): void {
  const kind = checkedRequestKind(scope.source);
  if (kind === undefined) return;
  const droppedCount = kind === 'full compaction' ? compactionDroppedCount(scope) : 0;
  const firstCompactionRequest = kind === 'full compaction' && isFirstCompactionRequest(scope);
  if (droppedCount > 0 && firstCompactionRequest) {
    recordUnnecessaryDrop(scope, request, config, droppedCount);
  }
  const previous = lastTurnRequests.get(scope.agent);
  if (previous === undefined || previous.model !== request.model) return;
  comparisons += 1;
  const label = scope.attempts === 1 ? kind : `${kind} retry`;
  recordPrefixBreak(label, findStableBreak(previous, request));
  if (scope.attempts > 1 || droppedCount > 0 || previous.contextRevision !== request.contextRevision) {
    return;
  }
  recordPrefixBreak(label, findHistoryBreak(previous, request, scope.mediaDegraded));
}

function compactionDroppedCount(scope: RequestScope): number {
  return Number(scope.source?.logFields?.['droppedCount'] ?? 0);
}

function isFirstCompactionRequest(scope: RequestScope): boolean {
  if (scope.attempts !== 1) return false;
  const first = compactionRevisions.get(scope.agent) !== scope.contextRevision;
  compactionRevisions.set(scope.agent, scope.contextRevision);
  return first;
}

function recordUnnecessaryDrop(
  scope: RequestScope,
  request: RecordedRequest,
  config: LlmRequestConfig,
  droppedCount: number,
): void {
  if (scope.contextWindow <= 0 || overflowedAgents.has(scope.agent)) return;
  const instruction = request.call.history.at(-1);
  const estimatedFullRequest =
    estimateTokens(request.call.systemPrompt) +
    estimateTokensForTools(request.call.tools) +
    estimateTokensForMessages(scope.context);
  const fullRequest =
    Math.max(estimatedFullRequest, scope.contextTokens) +
    (instruction === undefined ? 0 : estimateTokensForMessage(instruction));
  const outputReserve = Math.min(
    config.maxCompletionTokens ?? Number.POSITIVE_INFINITY,
    Math.floor(scope.contextWindow / 8),
  );
  if (fullRequest + outputReserve > scope.contextWindow) return;
  violations.push(
    `full compaction request dropped ${String(droppedCount)} history messages although the full history fits the context window (${String(fullRequest)} request tokens + ${String(outputReserve)} output reserve <= ${String(scope.contextWindow)}), breaking the prompt-cache prefix`,
  );
}

function isContextOverflow(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (CONTEXT_OVERFLOW_ERRORS.has(error.name)) return true;
  return (error as { readonly statusCode?: unknown }).statusCode === 413;
}

function recordPrefixBreak(kind: string, prefixBreak: unknown): void {
  if (prefixBreak === undefined) return;
  violations.push(
    `${kind} request does not extend the last turn request's prompt-cache prefix: ${JSON.stringify(prefixBreak, null, 2)}`,
  );
}

function checkedRequestKind(source: AgentLLMRequestSource | undefined): string | undefined {
  if (source === undefined) return undefined;
  if (source.type === 'turn') return source.step === 1 ? 'next turn' : 'next step';
  const requestKind = source.requestKind ?? 'operation';
  if (PREFIX_SHARING_OPERATIONS.has(requestKind)) return requestKind.replaceAll('_', ' ');
  if (!INDEPENDENT_OPERATIONS.has(requestKind)) {
    violations.push(
      `operation request kind "${requestKind}" has no declared prompt-cache intent: add it to PREFIX_SHARING_OPERATIONS when it reuses the agent's turn prefix, or to INDEPENDENT_OPERATIONS when it never does`,
    );
  }
  return undefined;
}

function findStableBreak(previous: RecordedRequest, next: RecordedRequest): unknown {
  const profileField = PROFILE_FIELDS.find(
    (field) => !isDeepStrictEqual(previous.profile[field], next.profile[field]),
  );
  if (profileField !== undefined) {
    return { at: profileField, previous: previous.profile[profileField], next: next.profile[profileField] };
  }
  const toolsMayChange =
    previous.toolInputs !== next.toolInputs && !sameToolNames(previous.call, next.call);
  return findGenerateCallPrefixBreak(
    {
      systemPrompt: previous.call.systemPrompt,
      tools: toolsMayChange ? next.call.tools : previous.call.tools,
      history: next.call.history,
    },
    next.call,
  );
}

function findHistoryBreak(
  previous: RecordedRequest,
  next: RecordedRequest,
  mediaDegraded: boolean,
): unknown {
  return findGenerateCallPrefixBreak(
    {
      systemPrompt: next.call.systemPrompt,
      tools: next.call.tools,
      history: mediaDegraded
        ? alignDegradedMedia(previous.call.history, next.call.history)
        : previous.call.history,
    },
    next.call,
  );
}

function sameToolNames(previous: GenerateCall, next: GenerateCall): boolean {
  const names = (call: GenerateCall) => call.tools.map((tool) => tool.name).toSorted();
  return isDeepStrictEqual(names(previous), names(next));
}

function alignDegradedMedia(previous: readonly Message[], next: readonly Message[]): Message[] {
  return previous.map((message, index) => {
    const counterpart = next[index];
    if (counterpart === undefined || counterpart.content.length !== message.content.length) return message;
    return {
      ...message,
      content: message.content.map((part, partIndex) => {
        const replacement = counterpart.content[partIndex]!;
        return isDegradedStandIn(part, replacement) ? replacement : part;
      }),
    };
  });
}

function isDegradedStandIn(part: ContentPart, replacement: ContentPart): boolean {
  if (replacement.type !== 'text') return false;
  if (part.type !== 'image_url' && part.type !== 'audio_url' && part.type !== 'video_url') {
    return false;
  }
  if (replacement.text === DEGRADED_PLACEHOLDERS[part.type]) return true;
  return matchSingleMediaPathTag(replacement.text)?.kind === MEDIA_PATH_KIND[part.type];
}

function modelIdentity(config: LlmRequestConfig): string {
  return JSON.stringify([config.model.provider, config.model.baseUrl, config.model.model]);
}
