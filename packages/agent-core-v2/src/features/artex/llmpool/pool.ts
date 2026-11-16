import { estimateUsedContextTokens } from '@moonshot-ai/core/llm/context-usage';
import type { Message, ToolDescription } from '@moonshot-ai/core/llm/message';

import { shouldFailoverLlmError, trimLlmErrorMessage } from './classify';
import { ArtexLlmHealthRegistry } from './health';
import { ArtexTokenBucket, type ArtexTokenBucketConfig } from './rateLimiter';

export const ARTEX_POOL_RANK_ACTIVE = Number.MAX_SAFE_INTEGER;
export const ARTEX_MAX_USER_AGENT_LEN = 256;

export class ArtexLlmPoolExhaustedError extends Error {
  readonly attempts: number;
  readonly lastError: unknown;

  constructor(attempts: number, lastError: unknown) {
    const detail = lastError === undefined ? 'no healthy profiles available' : trimLlmErrorMessage(lastError);
    super(`LLM failover: all ${String(attempts)} profile(s) unavailable: ${detail}`, {
      cause: lastError instanceof Error ? lastError : undefined,
    });
    this.name = 'ArtexLlmPoolExhaustedError';
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

export interface ArtexLlmPoolMember<TConfig = unknown> {
  readonly id: string;
  readonly name: string;
  readonly model: string;
  readonly format: string;
  readonly rank: number;
  readonly priority?: number;
  readonly active?: boolean;
  readonly maxContextTokens?: number;
  readonly sessionHeaderKey?: string;
  readonly userAgent?: string;
  readonly rateLimit?: ArtexTokenBucketConfig;
  readonly config?: TConfig;
}

export interface ArtexLlmTokenEstimateInput {
  readonly estimatedTokens?: number;
  readonly messages?: readonly Message[];
  readonly systemPrompt?: string;
  readonly tools?: readonly ToolDescription[];
}

export interface ArtexLlmPoolOptions {
  readonly health?: ArtexLlmHealthRegistry;
  readonly now?: () => number;
  readonly onFailover?: (event: {
    readonly from: ArtexLlmPoolMember;
    readonly to: ArtexLlmPoolMember | undefined;
    readonly tripped: boolean;
    readonly error: unknown;
  }) => void;
}

export interface ArtexFailoverAttemptContext<TConfig = unknown> {
  readonly member: ArtexLlmPoolMember<TConfig>;
  readonly headers: Record<string, string>;
  readonly signal?: AbortSignal;
}

export interface ArtexExecuteWithFailoverOptions<TConfig, TResult> extends ArtexLlmTokenEstimateInput {
  readonly sessionId?: string;
  readonly baseHeaders?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly isFailedResult?: (result: TResult) => unknown;
  readonly execute: (context: ArtexFailoverAttemptContext<TConfig>) => Promise<TResult>;
}

export interface ArtexStreamWithFailoverOptions<TConfig, TEvent> extends ArtexLlmTokenEstimateInput {
  readonly sessionId?: string;
  readonly baseHeaders?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly isOutputEvent?: (event: TEvent) => boolean;
  readonly isTerminalErrorEvent?: (event: TEvent) => unknown;
  readonly stream: (context: ArtexFailoverAttemptContext<TConfig>) => AsyncIterable<TEvent>;
}

export function validateUserAgent(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return '';
  if (Buffer.byteLength(trimmed, 'utf8') > ARTEX_MAX_USER_AGENT_LEN) {
    throw new Error(
      `User-Agent too long: ${String(Buffer.byteLength(trimmed, 'utf8'))} bytes (max ${String(ARTEX_MAX_USER_AGENT_LEN)})`,
    );
  }
  for (let i = 0; i < trimmed.length; i += 1) {
    const code = trimmed.codePointAt(i) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      throw new Error('User-Agent contains a control character');
    }
  }
  return trimmed;
}

export function estimateTokens(input: ArtexLlmTokenEstimateInput): number {
  if (input.estimatedTokens !== undefined) {
    return Math.max(0, input.estimatedTokens);
  }
  if (input.messages !== undefined) {
    return estimateUsedContextTokens(input.messages, {
      systemPrompt: input.systemPrompt,
      tools: input.tools,
    });
  }
  let chars = input.systemPrompt?.length ?? 0;
  for (const tool of input.tools ?? []) {
    const propCount =
      typeof tool.parameters === 'object' && tool.parameters !== null
        ? Object.keys((tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}).length
        : 0;
    chars += tool.name.length + tool.description.length + propCount * 120;
  }
  return Math.floor((chars * 2) / 7);
}

export function rotateEqualRankGroups<T extends { readonly rank: number }>(
  members: readonly T[],
  rotationOffset: number,
): T[] {
  const out: T[] = [];
  for (let i = 0; i < members.length; ) {
    let j = i + 1;
    while (j < members.length && members[j]!.rank === members[i]!.rank) {
      j += 1;
    }
    const groupSize = j - i;
    if (groupSize > 1) {
      const offset = ((rotationOffset % groupSize) + groupSize) % groupSize;
      for (let k = 0; k < groupSize; k += 1) {
        out.push(members[i + ((k + offset) % groupSize)]!);
      }
    } else {
      out.push(members[i]!);
    }
    i = j;
  }
  return out;
}

export class ArtexLlmPool<TConfig = unknown> {
  readonly health: ArtexLlmHealthRegistry;
  private readonly orderedMembers: readonly ArtexLlmPoolMember<TConfig>[];
  private readonly limiters = new Map<string, ArtexTokenBucket>();
  private readonly onFailover: ArtexLlmPoolOptions['onFailover'];
  private rrCounter = 0;

  constructor(
    members: readonly ArtexLlmPoolMember<TConfig>[],
    options: ArtexLlmPoolOptions = {},
  ) {
    this.health = options.health ?? new ArtexLlmHealthRegistry({ now: options.now });
    this.onFailover = options.onFailover;
    this.orderedMembers = members.toSorted((a, b) => b.rank - a.rank);

    const now = options.now ?? Date.now;
    for (const member of this.orderedMembers) {
      if (member.rateLimit !== undefined && ((member.rateLimit.rps ?? 0) > 0 || (member.rateLimit.rpm ?? 0) > 0)) {
        this.limiters.set(member.id, new ArtexTokenBucket(member.rateLimit, now));
      }
    }
  }

  static create<TConfig = unknown>(
    members: readonly ArtexLlmPoolMember<TConfig>[],
    options: ArtexLlmPoolOptions = {},
  ): ArtexLlmPool<TConfig> | undefined {
    if (members.length === 0) return undefined;
    return new ArtexLlmPool(members, options);
  }

  members(): readonly ArtexLlmPoolMember<TConfig>[] {
    return this.orderedMembers;
  }

  head(): ArtexLlmPoolMember<TConfig> | undefined {
    return this.orderedMembers[0];
  }

  selectCandidates(input: ArtexLlmTokenEstimateInput = {}): ArtexLlmPoolMember<TConfig>[] {
    if (this.orderedMembers.length === 0) return [];
    const estimated = estimateTokens(input);
    const open = this.orderedMembers.filter((member) => {
      if (!this.health.isHealthy(member.id)) return false;
      if (
        member.maxContextTokens !== undefined &&
        member.maxContextTokens > 0 &&
        estimated > member.maxContextTokens
      ) {
        return false;
      }
      return true;
    });
    if (open.length === 0) {
      return [this.orderedMembers[0]!];
    }
    const rotation = this.rrCounter;
    this.rrCounter = (this.rrCounter + 1) % Number.MAX_SAFE_INTEGER;
    return rotateEqualRankGroups(open, rotation);
  }

  buildHeaders(
    member: ArtexLlmPoolMember<TConfig>,
    sessionId?: string,
    baseHeaders?: Readonly<Record<string, string>>,
  ): Record<string, string> {
    const headers: Record<string, string> = { ...baseHeaders };
    const headerKey = member.sessionHeaderKey?.trim();
    const trimmedSession = sessionId?.trim();
    if (headerKey !== undefined && headerKey.length > 0 && trimmedSession !== undefined && trimmedSession.length > 0) {
      headers[headerKey] = trimmedSession;
    }
    if (member.userAgent !== undefined) {
      const ua = validateUserAgent(member.userAgent);
      if (ua.length > 0) {
        headers['user-agent'] = ua;
      }
    }
    return headers;
  }

  async acquireRateLimit(memberId: string, signal?: AbortSignal): Promise<void> {
    const limiter = this.limiters.get(memberId);
    if (limiter === undefined) {
      signal?.throwIfAborted();
      return;
    }
    await limiter.acquire(signal);
  }

  async execute<TResult>(options: ArtexExecuteWithFailoverOptions<TConfig, TResult>): Promise<TResult> {
    const candidates = this.selectCandidates(options);
    if (candidates.length === 0) {
      throw new ArtexLlmPoolExhaustedError(0, undefined);
    }

    let lastError: unknown;
    for (let i = 0; i < candidates.length; i += 1) {
      const member = candidates[i]!;
      await this.acquireRateLimit(member.id, options.signal);
      const headers = this.buildHeaders(member, options.sessionId, options.baseHeaders);
      try {
        const result = await options.execute({ member, headers, signal: options.signal });
        const failed = options.isFailedResult?.(result);
        if (failed === undefined) {
          this.health.recordSuccess(member.id);
          return result;
        }
        if (!shouldFailoverLlmError(failed, options.signal)) {
          return result;
        }
        lastError = failed;
        const tripped = this.health.recordFailure(member.id, failed);
        this.onFailover?.({
          from: member,
          to: candidates[i + 1],
          tripped,
          error: failed,
        });
      } catch (error) {
        if (!shouldFailoverLlmError(error, options.signal)) {
          throw error;
        }
        lastError = error;
        const tripped = this.health.recordFailure(member.id, error);
        this.onFailover?.({
          from: member,
          to: candidates[i + 1],
          tripped,
          error,
        });
      }
    }

    throw new ArtexLlmPoolExhaustedError(candidates.length, lastError);
  }

  async *stream<TEvent>(options: ArtexStreamWithFailoverOptions<TConfig, TEvent>): AsyncGenerator<TEvent> {
    const candidates = this.selectCandidates(options);
    if (candidates.length === 0) {
      throw new ArtexLlmPoolExhaustedError(0, undefined);
    }

    const isOutputEvent = options.isOutputEvent ?? (() => true);
    let lastError: unknown;

    for (let i = 0; i < candidates.length; i += 1) {
      const member = candidates[i]!;
      await this.acquireRateLimit(member.id, options.signal);
      const headers = this.buildHeaders(member, options.sessionId, options.baseHeaders);

      let emittedOutput = false;
      let failedInSafeWindow: unknown;
      let hasFailedInSafeWindow = false;
      const bufferedPreOutput: TEvent[] = [];

      try {
        for await (const event of options.stream({ member, headers, signal: options.signal })) {
          const terminalError = options.isTerminalErrorEvent?.(event);
          if (terminalError !== undefined) {
            if (!emittedOutput && shouldFailoverLlmError(terminalError, options.signal)) {
              failedInSafeWindow = terminalError;
              hasFailedInSafeWindow = true;
              break;
            }
            for (const buffered of bufferedPreOutput) {
              yield buffered;
            }
            bufferedPreOutput.length = 0;
            yield event;
            return;
          }

          if (!emittedOutput && !isOutputEvent(event)) {
            bufferedPreOutput.push(event);
            continue;
          }

          if (!emittedOutput) {
            for (const buffered of bufferedPreOutput) {
              yield buffered;
            }
            bufferedPreOutput.length = 0;
            emittedOutput = true;
          }
          yield event;
        }
      } catch (error) {
        if (!emittedOutput && shouldFailoverLlmError(error, options.signal)) {
          failedInSafeWindow = error;
          hasFailedInSafeWindow = true;
        } else {
          throw error;
        }
      }

      if (!hasFailedInSafeWindow) {
        for (const buffered of bufferedPreOutput) {
          yield buffered;
        }
        this.health.recordSuccess(member.id);
        return;
      }

      lastError = failedInSafeWindow;
      const tripped = this.health.recordFailure(member.id, failedInSafeWindow);
      this.onFailover?.({
        from: member,
        to: candidates[i + 1],
        tripped,
        error: failedInSafeWindow,
      });
    }

    throw new ArtexLlmPoolExhaustedError(candidates.length, lastError);
  }
}

export async function executeWithFailover<TConfig, TResult>(
  pool: ArtexLlmPool<TConfig>,
  options: ArtexExecuteWithFailoverOptions<TConfig, TResult>,
): Promise<TResult> {
  return pool.execute(options);
}

export function streamWithFailover<TConfig, TEvent>(
  pool: ArtexLlmPool<TConfig>,
  options: ArtexStreamWithFailoverOptions<TConfig, TEvent>,
): AsyncGenerator<TEvent> {
  return pool.stream(options);
}
