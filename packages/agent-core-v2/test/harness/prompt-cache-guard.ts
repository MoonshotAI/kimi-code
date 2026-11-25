import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';

import { afterEach } from 'vitest';

import { IAgentLoopService } from '#/agent/loop/loop';
import type { IAgentJournal } from '#/wire/journal';
import type {
  AgentLLMRequestSource,
  CoreLoopRequester,
  CoreLoopRequesterOptions,
  LoopRequester,
  OperationLoopRequesterOptions,
} from '#/agent/loop/requesterContract';
import { TOOL_ARGUMENT_CORRECTION_ORIGIN } from '@moonshot-ai/core/llm/message';
import type { LlmRequest } from '@moonshot-ai/core/llm/request';
import type { MockProvider } from './scripted-generate';

import { generateCallOf } from './scripted-generate';
import { findGenerateCallPrefixBreak, type GenerateCall } from './snapshots';

interface RequestScope {
  readonly agent: object;
  readonly source: AgentLLMRequestSource | undefined;
  readonly branch: string;
  readonly contextRevision: number;
  attempts: number;
}

interface RecordedRequest {
  readonly branch: string;
  readonly contextRevision: number;
  readonly model: string;
  readonly profile: Readonly<Record<(typeof PROFILE_FIELDS)[number], unknown>>;
  readonly call: GenerateCall;
  readonly correctionTail: boolean;
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

export function drainPromptCacheViolations(): readonly string[] {
  return violations.splice(0);
}

export class PromptCacheGuardedLoopRequester implements LoopRequester {
  constructor(
    private readonly inner: LoopRequester,
    private readonly context: IAgentLoopService,
    private readonly journal: IAgentJournal,
    private readonly ready?: () => Promise<void>,
  ) {}

  coreRequester(options: CoreLoopRequesterOptions): CoreLoopRequester {
    return this.guard(
      this.inner.coreRequester(options),
      options.source,
      options.runtime.historyRevision,
    );
  }

  async prepareOperation(options: OperationLoopRequesterOptions, signal: AbortSignal): Promise<CoreLoopRequester> {
    await this.ready?.();
    const requester = await this.inner.prepareOperation(options, signal);
    return this.guard(requester, options.source, () => this.context.historyRevision());
  }

  private guard(
    requester: CoreLoopRequester,
    source: () => AgentLLMRequestSource,
    revision: () => number,
  ): CoreLoopRequester {
    const wrap = (inner: CoreLoopRequester): CoreLoopRequester => ({
      snapshot: () => wrap(inner.snapshot?.() ?? inner),
      generate: (rest, control) => {
        const scope: RequestScope = {
          agent: this,
          source: source(),
          branch: this.journal.journalRef.branch,
          contextRevision: revision(),
          attempts: 0,
        };
        return requestScope.run(scope, () => inner.generate(rest, control));
      },
    });
    return wrap(requester);
  }
}

export function guardPromptCachePrefix(provider: MockProvider): MockProvider {
  return {
    ...provider,
    respond: async (input, signal) => {
      const scope = requestScope.getStore();
      if (scope === undefined) return provider.respond(input, signal);
      const protocolOptions = input.protocol.options as Record<string, unknown> | undefined;
      const profile = {
        cacheKey: input.model.cacheKey,
        thinking: input.model.thinking,
        extraParams:
          protocolOptions === undefined
            ? undefined
            : Object.fromEntries(
                Object.entries(protocolOptions).filter(([key, value]) => key !== 'detectedReasoningKey' && typeof value !== 'function'),
              ),
        responseFormat: input.model.responseFormat,
        toolMessageConversion: protocolOptions?.['toolMessageConversion'],
      };
      const request: RecordedRequest = {
        branch: scope.branch,
        contextRevision: scope.contextRevision,
        model: modelIdentity(input),
        profile: Object.fromEntries(PROFILE_FIELDS.map((field) => [field, profile[field]])) as RecordedRequest['profile'],
        call: generateCallOf(input),
        correctionTail: input.content.messages.at(-1)?.attributes?.origin?.kind === TOOL_ARGUMENT_CORRECTION_ORIGIN,
      };
      scope.attempts += 1;
      checkPrefixExtension(scope, request);
      const attempt = await provider.respond(input, signal);
      if (scope.source?.type === 'turn') lastTurnRequests.set(scope.agent, request);
      return attempt;
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
  if (previous.branch !== request.branch) return;
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
  // Special case: an invalid-tool-arguments correction is a deliberate one-shot
  // cache sacrifice. The retry policy appends it temporarily and never persists
  // it, so the next request legitimately drops it; strip it from the recorded
  // baseline instead of reporting a prefix break.
  const history = previous.correctionTail
    ? previous.call.history.slice(0, -1)
    : previous.call.history;
  return findGenerateCallPrefixBreak(
    {
      systemPrompt: next.call.systemPrompt,
      tools: next.call.tools,
      history,
    },
    next.call,
  );
}

function sameToolNames(previous: GenerateCall, next: GenerateCall): boolean {
  const names = (call: GenerateCall) => call.tools.map((tool) => tool.name).toSorted();
  return isDeepStrictEqual(names(previous), names(next));
}

function modelIdentity(request: LlmRequest): string {
  return JSON.stringify([
    request.model.spec.provider,
    request.endpoint?.baseUrl,
    request.model.spec.name,
  ]);
}
