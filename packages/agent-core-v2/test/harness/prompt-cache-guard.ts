import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';

import { afterEach } from 'vitest';

import { IInstantiationService } from '#/_base/di/instantiation';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type {
  AgentLLMRequestOverrides,
  AgentLLMRequestPartHandler,
  AgentLLMRequestSource,
  AgentLLMRequestTask,
  AgentLLMTurnRequestSnapshot,
  IAgentLLMRequesterService,
  PreparedTurnRequestConfig,
} from '#/agent/llmRequester/llmRequester';
import { AgentLLMRequesterService } from '#/agent/llmRequester/llmRequesterService';
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
  attempts: number;
}

interface RecordedRequest {
  readonly contextRevision: number;
  readonly model: string;
  readonly profile: Readonly<Record<(typeof PROFILE_FIELDS)[number], unknown>>;
  readonly call: GenerateCall;
}

const PROFILE_FIELDS = [
  'cacheKey',
  'thinking',
  'extraParams',
  'responseFormat',
  'toolMessageConversion',
] as const;

const requestScope = new AsyncLocalStorage<RequestScope>();
const lastTurnRequests = new WeakMap<object, RecordedRequest>();
const violations: string[] = [];
let comparisons = 0;

export function promptCacheComparisons(): number {
  return comparisons;
}

export class PromptCacheGuardedLLMRequesterService implements IAgentLLMRequesterService {
  declare readonly _serviceBrand: undefined;

  private readonly inner: IAgentLLMRequesterService;

  constructor(
    @IInstantiationService instantiation: IInstantiationService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
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
    const scope: RequestScope = {
      agent: this,
      source: overrides?.source,
      contextRevision,
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
        call: generateCallOf(config, content),
      };
      scope.attempts += 1;
      checkPrefixExtension(scope, request);
      await requester.generate(config, content, control);
      if (scope.source?.type === 'turn') lastTurnRequests.set(scope.agent, request);
    },
  };
}

afterEach(() => {
  const found = violations.splice(0);
  if (found.length > 0) throw new Error(found.join('\n\n'));
});

function checkPrefixExtension(scope: RequestScope, request: RecordedRequest): void {
  const kind = checkedRequestKind(scope.source);
  if (kind === undefined) return;
  const previous = lastTurnRequests.get(scope.agent);
  if (previous === undefined) return;
  if (previous.contextRevision !== request.contextRevision || previous.model !== request.model) return;
  comparisons += 1;
  const label = scope.attempts === 1 ? kind : `${kind} retry`;
  recordPrefixBreak(label, findStableBreak(previous, request));
  if (scope.attempts === 1) {
    recordPrefixBreak(label, findHistoryBreak(previous, request));
  }
}

function recordPrefixBreak(kind: string, prefixBreak: unknown): void {
  if (prefixBreak === undefined) return;
  violations.push(
    `${kind} request does not extend the last turn request's prompt-cache prefix: ${JSON.stringify(prefixBreak, null, 2)}`,
  );
}

function checkedRequestKind(source: AgentLLMRequestSource | undefined): string | undefined {
  if (source?.type === 'turn') return source.step === 1 ? 'next turn' : 'next step';
  if (source?.requestKind !== 'full_compaction') return undefined;
  return source.logFields?.['droppedCount'] === 0 ? 'full compaction' : undefined;
}

function findStableBreak(previous: RecordedRequest, next: RecordedRequest): unknown {
  const profileField = PROFILE_FIELDS.find(
    (field) => !isDeepStrictEqual(previous.profile[field], next.profile[field]),
  );
  if (profileField !== undefined) {
    return { at: profileField, previous: previous.profile[profileField], next: next.profile[profileField] };
  }
  return findGenerateCallPrefixBreak(
    {
      systemPrompt: previous.call.systemPrompt,
      tools: sameToolNames(previous.call, next.call) ? previous.call.tools : next.call.tools,
      history: next.call.history,
    },
    next.call,
  );
}

function findHistoryBreak(previous: RecordedRequest, next: RecordedRequest): unknown {
  return findGenerateCallPrefixBreak(
    {
      systemPrompt: next.call.systemPrompt,
      tools: next.call.tools,
      history: previous.call.history,
    },
    next.call,
  );
}

function sameToolNames(previous: GenerateCall, next: GenerateCall): boolean {
  const names = (call: GenerateCall) => call.tools.map((tool) => tool.name).toSorted();
  return isDeepStrictEqual(names(previous), names(next));
}

function modelIdentity(config: LlmRequestConfig): string {
  return JSON.stringify([config.model.provider, config.model.baseUrl, config.model.model]);
}
