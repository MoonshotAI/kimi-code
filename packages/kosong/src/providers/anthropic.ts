import type { ModelCapability } from '#/capability';
import {
  APIConnectionError,
  APITimeoutError,
  ChatProviderError,
  normalizeAPIStatusError,
} from '#/errors';
import type { ContentPart, Message, StreamedMessagePart, ToolCall } from '#/message';
import type {
  ChatProvider,
  FinishReason,
  GenerateOptions,
  ProviderRequestAuth,
  StreamedMessage,
  ThinkingEffort,
} from '#/provider';
import type { Tool } from '#/tool';
import type { TokenUsage } from '#/usage';
import Anthropic, {
  APIError as AnthropicAPIError,
  APIConnectionError as AnthropicConnectionError,
  AnthropicError,
  APIConnectionTimeoutError as AnthropicTimeoutError,
} from '@anthropic-ai/sdk';
import type {
  Tool as AnthropicTool,
  ContentBlockParam,
  MessageCreateParams,
  MessageCreateParamsStreaming,
  MessageParam,
  MessageStreamEvent,
  RawContentBlockDeltaEvent,
  RawContentBlockStartEvent,
  RawMessageStartEvent,
  TextBlockParam,
  ThinkingBlockParam,
  ToolResultBlockParam,
  ToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/messages/messages.js';

import { getAnthropicModelCapability } from './capability-registry';
import {
  mergeRequestHeaders,
  requireProviderApiKey,
  resolveAuthBackedClient,
} from './request-auth';
import {
  normalizeToolCallIdsForProvider,
  sanitizeToolCallId,
  type ToolCallIdPolicy,
} from './tool-call-id';

/**
 * Normalize an Anthropic `stop_reason` string to the unified
 * {@link FinishReason} enum.
 *
 * Source: `message.stop_reason` (non-stream) or the last `message_delta`
 * event's `delta.stop_reason` (stream).
 */
function normalizeAnthropicStopReason(raw: string | null | undefined): {
  finishReason: FinishReason | null;
  rawFinishReason: string | null;
} {
  if (raw === null || raw === undefined) {
    return { finishReason: null, rawFinishReason: null };
  }
  switch (raw) {
    case 'end_turn':
    case 'stop_sequence':
      return { finishReason: 'completed', rawFinishReason: raw };
    case 'max_tokens':
      return { finishReason: 'truncated', rawFinishReason: raw };
    case 'tool_use':
      return { finishReason: 'tool_calls', rawFinishReason: raw };
    case 'pause_turn':
      return { finishReason: 'paused', rawFinishReason: raw };
    case 'refusal':
      return { finishReason: 'filtered', rawFinishReason: raw };
    default:
      return { finishReason: 'other', rawFinishReason: raw };
  }
}
export interface AnthropicOptions {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model: string;
  defaultMaxTokens?: number | undefined;
  betaFeatures?: string[] | undefined;
  defaultHeaders?: Record<string, string>;
  metadata?: Record<string, string> | undefined;
  /** Use streaming API. Defaults to true. Set to false for non-streaming (test/fallback). */
  stream?: boolean | undefined;
  /**
   * Explicitly declare whether the model supports adaptive thinking
   * (`thinking: { type: 'adaptive' }`), overriding the model-name version
   * inference. Useful for custom-named endpoints whose model name does not
   * encode a parseable Claude version. Leave undefined to infer from the name.
   */
  adaptiveThinking?: boolean | undefined;
  clientFactory?: (auth: ProviderRequestAuth) => Anthropic;
}

interface AnthropicGenerationKwargs {
  max_tokens?: number | undefined;
  temperature?: number | undefined;
  top_k?: number | undefined;
  top_p?: number | undefined;
  thinking?: MessageCreateParams['thinking'] | undefined;
  output_config?: MessageCreateParams['output_config'] | undefined;
  betaFeatures?: string[] | undefined;
}

const INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14';
const FAMILY_VERSION_RE = /(?:opus|sonnet|haiku)[.-](\d+)[.-](\d{1,2})(?!\d)/;
const OPUS_VERSION_RE = /opus[.-](\d+)[.-](\d{1,2})(?!\d)/;
const ADAPTIVE_MIN_VERSION = { major: 4, minor: 6 } as const;
const ANTHROPIC_TOOL_CALL_ID_POLICY: ToolCallIdPolicy = {
  normalize: (id) => sanitizeToolCallId(id, 64),
  maxLength: 64,
};

/**
 * Per-version default output ceilings sourced from Anthropic's Messages
 * API model cards (platform.claude.com/docs/en/about-claude/models/overview).
 * Values are the documented synchronous Messages-API maximum — we send
 * the full ceiling because Claude 4 + interleaved-thinking shares this
 * budget with encrypted reasoning, so anything below the documented cap
 * can silently truncate mid-`tool_use`.
 *
 * Keys are `<family>-<major>[-<minor>]`. Lookups try the most specific
 * key first, then fall back to the family/major-only entry, so an
 * unrecognized minor version (e.g. a future `opus-4-10`) gets the
 * family's baseline rather than the generic fallback.
 */
const CEILING_BY_FAMILY_VERSION: Readonly<Record<string, number>> = {
  // Claude Opus per minor version. 4.6 and 4.7 raised the cap to 128k;
  // 4.5 ships at 64k; 4.1 and the dated 4.0 release stay at 32k.
  'opus-4-7': 128000,
  'opus-4-6': 128000,
  'opus-4-5': 64000,
  'opus-4-1': 32000,
  'opus-4-0': 32000,
  'opus-4': 32000,
  // Claude Sonnet 4.x: 4.0 / 4.5 / 4.6 all document a 64k ceiling.
  'sonnet-4-6': 64000,
  'sonnet-4-5': 64000,
  'sonnet-4-0': 64000,
  'sonnet-4': 64000,
  // Claude Haiku 4.5 is 64k; the family-only entry keeps future dated
  // 4.x Haiku releases on the same ceiling.
  'haiku-4-5': 64000,
  'haiku-4': 64000,
  // Claude 3.5 / 3.7 documented at 8192 (standard endpoint).
  'opus-3-5': 8192,
  'sonnet-3-5': 8192,
  'sonnet-3-7': 8192,
  'haiku-3-5': 8192,
  // Original Claude 3 generation.
  'opus-3': 4096,
  'sonnet-3': 4096,
  'haiku-3': 4096,
};

const FALLBACK_MAX_TOKENS = 32000;

type ClaudeFamily = 'opus' | 'sonnet' | 'haiku';

interface ClaudeVersion {
  family: ClaudeFamily;
  major: number;
  minor: number | null;
}

// Family-first form: "opus-4-7", "sonnet-4.6", "haiku-4-5-20251001".
// Version numbers are capped at 1–2 digits with a non-digit lookahead so
// 8-digit date suffixes (e.g. `-20251001`) don't get consumed as version
// components.
const FAMILY_FIRST_RE =
  /(opus|sonnet|haiku)[-._](\d{1,2})(?!\d)(?:[-._](\d{1,2})(?!\d))?/;
// Legacy version-first form: "3-5-sonnet", "3.7.opus" — used by older
// Anthropic model ids and Bedrock variants of Claude 3.x.
const VERSION_FIRST_RE = /(\d{1,2})[-._](\d{1,2})[-._](opus|sonnet|haiku)/;
// Bare family form for base Claude 3 (no minor): "3-opus", "3.haiku".
const BARE_FAMILY_RE = /(\d{1,2})[-._](opus|sonnet|haiku)/;

/**
 * Extract Claude family + version from a model id.
 *
 * Designed to survive the naming variants we see across vendors:
 * vendor prefixes (`anthropic.`, `aws/`, `openrouter/`,
 * `online-`), suffixes (date stamps like `-20251001`, build tags
 * like `-construct`, `-v1:0`), and `.` vs `-` separators between
 * the family and version components.
 *
 * Returns `null` when the id contains no Claude marker or no
 * recognizable family/version, in which case the resolver should fall
 * back to the override or {@link FALLBACK_MAX_TOKENS}.
 */
function parseClaudeVersion(model: string): ClaudeVersion | null {
  const normalized = model.toLowerCase();
  // Guard against false positives on non-Claude models that happen to
  // contain an `opus-4-7`-like substring (e.g. fine-tunes named after a
  // checkpoint). The Anthropic provider might still be configured for
  // non-Claude endpoints, so without this guard we'd quietly apply
  // Claude ceilings to unrelated models.
  if (!normalized.includes('claude')) return null;

  const familyFirst = FAMILY_FIRST_RE.exec(normalized);
  if (familyFirst !== null) {
    return {
      family: familyFirst[1] as ClaudeFamily,
      major: Number.parseInt(familyFirst[2]!, 10),
      minor: familyFirst[3] !== undefined ? Number.parseInt(familyFirst[3], 10) : null,
    };
  }
  const versionFirst = VERSION_FIRST_RE.exec(normalized);
  if (versionFirst !== null) {
    return {
      major: Number.parseInt(versionFirst[1]!, 10),
      minor: Number.parseInt(versionFirst[2]!, 10),
      family: versionFirst[3] as ClaudeFamily,
    };
  }
  const bare = BARE_FAMILY_RE.exec(normalized);
  if (bare !== null) {
    return {
      major: Number.parseInt(bare[1]!, 10),
      minor: null,
      family: bare[2] as ClaudeFamily,
    };
  }
  return null;
}

function lookupClaudeCeiling(version: ClaudeVersion): number | undefined {
  const { family, major, minor } = version;
  if (minor !== null) {
    const exact = CEILING_BY_FAMILY_VERSION[`${family}-${major}-${minor}`];
    if (exact !== undefined) return exact;
  }
  return CEILING_BY_FAMILY_VERSION[`${family}-${major}`];
}

/**
 * Resolve the default `max_tokens` for an Anthropic request.
 *
 * Precedence:
 *   1. Caller-provided `override` (e.g. `models.<alias>.maxOutputSize`
 *      from the harness config) — honored when present so users can
 *      intentionally lower the budget (handy for forcing truncation
 *      in tests) or raise it on a model we don't yet know about.
 *   2. When the model id parses to a known Claude family + version,
 *      the override is clamped to the documented Messages-API ceiling
 *      so we never send a value the server would reject.
 *   3. With no override and no recognized version, fall back to
 *      {@link FALLBACK_MAX_TOKENS}.
 */
export function resolveDefaultMaxTokens(model: string, override?: number): number {
  const parsed = parseClaudeVersion(model);
  const ceiling = parsed === null ? undefined : lookupClaudeCeiling(parsed);
  if (ceiling === undefined) {
    return override ?? FALLBACK_MAX_TOKENS;
  }
  return override === undefined ? ceiling : Math.min(override, ceiling);
}

function parseVersion(match: RegExpExecArray): { major: number; minor: number } {
  const majorRaw = match[1];
  const minorRaw = match[2];
  if (majorRaw === undefined || minorRaw === undefined) {
    throw new Error('Model version regex did not capture major and minor versions.');
  }
  return { major: Number.parseInt(majorRaw, 10), minor: Number.parseInt(minorRaw, 10) };
}

function versionAtLeast(
  version: { major: number; minor: number },
  minimum: { major: number; minor: number },
): boolean {
  return (
    version.major > minimum.major ||
    (version.major === minimum.major && version.minor >= minimum.minor)
  );
}

function supportsAdaptiveThinking(model: string): boolean {
  const normalized = model.toLowerCase();
  const match = FAMILY_VERSION_RE.exec(normalized);
  if (match === null) {
    return false;
  }
  return versionAtLeast(parseVersion(match), ADAPTIVE_MIN_VERSION);
}

function isOpus47(model: string): boolean {
  const match = OPUS_VERSION_RE.exec(model.toLowerCase());
  if (match === null) {
    return false;
  }
  const version = parseVersion(match);
  return version.major === 4 && version.minor === 7;
}

function supportsEffortParam(model: string, adaptive: boolean): boolean {
  if (adaptive) {
    return true;
  }
  const normalized = model.toLowerCase();
  return normalized.includes('opus-4-5') || normalized.includes('opus-4.5');
}

function clampEffort(effort: ThinkingEffort, model: string, adaptive: boolean): ThinkingEffort {
  if (effort === 'off') {
    return effort;
  }
  if (effort === 'xhigh' && !isOpus47(model)) {
    return 'high';
  }
  if (effort === 'max' && !adaptive) {
    return 'high';
  }
  return effort;
}

function budgetTokensForEffort(effort: ThinkingEffort): number {
  switch (effort) {
    case 'low':
      return 1024;
    case 'medium':
      return 4096;
    case 'high':
      return 32_000;
    case 'off':
    case 'xhigh':
    case 'max':
      throw new Error(`Unsupported budget-based thinking effort: ${effort}`);
  }
  throw new Error(`Unknown thinking effort: ${String(effort)}`);
}
const CACHE_CONTROL = { type: 'ephemeral' as const };

type CacheableBlock = ContentBlockParam & { cache_control?: { type: 'ephemeral' } };

/**
 * Content block types that support cache_control injection.
 */
const CACHEABLE_TYPES = new Set([
  'text',
  'image',
  'document',
  'search_result',
  'tool_use',
  'tool_result',
  'server_tool_use',
  'web_search_tool_result',
]);

function injectCacheControlOnLastBlock(messages: MessageParam[]): void {
  const lastMessage = messages.at(-1);
  if (lastMessage === undefined) return;
  const content = lastMessage.content;
  if (!Array.isArray(content) || content.length === 0) return;
  const lastBlock = content.at(-1) as CacheableBlock | undefined;
  if (lastBlock === undefined) return;
  if (CACHEABLE_TYPES.has(lastBlock.type)) {
    lastBlock.cache_control = CACHE_CONTROL;
  }
}

/**
 * Check whether a MessageParam is a user message whose content consists
 * entirely of `tool_result` blocks.
 *
 * Used to detect adjacent tool-result-only messages that must be merged
 * before hitting the Anthropic wire. Per the Messages API parallel-tool-use
 * spec, all `tool_result` blocks answering parallel `tool_use` calls must
 * live in a single user message — splitting them across consecutive user
 * messages fails on strict Anthropic-compatible backends (HTTP 400) and
 * silently degrades parallel tool use on api.anthropic.com.
 */
function isToolResultOnly(message: MessageParam): boolean {
  if (message.role !== 'user') return false;
  const content = message.content;
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every((block) => block.type === 'tool_result');
}
interface AnthropicImageBlock {
  type: 'image';
  source: { type: 'base64'; data: string; media_type: string } | { type: 'url'; url: string };
  cache_control?: { type: 'ephemeral' };
}

const SUPPORTED_B64_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function imageUrlPartToAnthropic(url: string): AnthropicImageBlock {
  if (url.startsWith('data:')) {
    const withoutScheme = url.slice(5);
    const parts = withoutScheme.split(';base64,', 2);
    if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
      throw new ChatProviderError(`Invalid data URL for image: ${url}`);
    }
    const mediaType = parts[0];
    const data = parts[1];
    if (!SUPPORTED_B64_MEDIA_TYPES.has(mediaType)) {
      throw new ChatProviderError(
        `Unsupported media type for base64 image: ${mediaType}, url: ${url}`,
      );
    }
    return {
      type: 'image',
      source: { type: 'base64', data, media_type: mediaType },
    };
  }
  return {
    type: 'image',
    source: { type: 'url', url },
  };
}
interface AnthropicToolParam extends AnthropicTool {
  cache_control?: { type: 'ephemeral' } | null;
}

function convertTool(tool: Tool): AnthropicToolParam {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters as AnthropicTool['input_schema'],
  };
}
function toolResultToBlock(toolCallId: string, content: ContentPart[]): ToolResultBlockParam {
  const blocks: Array<TextBlockParam | AnthropicImageBlock> = [];
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text) {
        blocks.push({ type: 'text', text: part.text });
      }
    } else if (part.type === 'image_url') {
      blocks.push(imageUrlPartToAnthropic(part.imageUrl.url));
    }
    // Other types not supported by Anthropic in tool results
  }
  return {
    type: 'tool_result',
    tool_use_id: toolCallId,
    content: blocks,
  } as ToolResultBlockParam;
}
function convertMessage(message: Message): MessageParam {
  const role = message.role;

  // system role -> <system>...</system> wrapped user message
  if (role === 'system') {
    const text = message.content
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('\n');
    return {
      role: 'user',
      content: [{ type: 'text', text: `<system>${text}</system>` }],
    };
  }

  // tool role -> ToolResultBlockParam in user message
  if (role === 'tool') {
    if (message.toolCallId === undefined) {
      throw new ChatProviderError('Tool message missing `toolCallId`.');
    }
    const block = toolResultToBlock(message.toolCallId, message.content);
    return { role: 'user', content: [block as ContentBlockParam] };
  }

  // user or assistant
  const blocks: ContentBlockParam[] = [];
  for (const part of message.content) {
    if (part.type === 'text') {
      blocks.push({ type: 'text', text: part.text } satisfies TextBlockParam);
    } else if (part.type === 'image_url') {
      blocks.push(imageUrlPartToAnthropic(part.imageUrl.url) as unknown as ContentBlockParam);
    } else if (part.type === 'think') {
      // ThinkPart -> ThinkingBlockParam.
      //
      // Signed: emit the block with its signature. api.anthropic.com requires a
      // valid signature and always supplies one, so Anthropic-sourced history
      // always takes this branch.
      //
      // Unsigned: still PRESERVE the thinking, emitted *without* a `signature`
      // field. Anthropic-compatible backends (e.g. Kimi) stream thinking with
      // no signature_delta, yet reject a tool-call turn whose thinking is gone
      // ("thinking is enabled but reasoning_content is missing"). Dropping it
      // here is what broke multi-step tool use on those backends. An unsigned
      // part with no text carries nothing, so it is skipped.
      if (part.encrypted !== undefined) {
        blocks.push({
          type: 'thinking',
          thinking: part.think,
          signature: part.encrypted,
        } satisfies ThinkingBlockParam);
      } else if (part.think !== '') {
        blocks.push({ type: 'thinking', thinking: part.think } as unknown as ThinkingBlockParam);
      }
    }
    // audio_url, video_url: not supported by Anthropic, skip
  }

  // Tool calls -> ToolUseBlockParam
  if (message.toolCalls.length > 0) {
    for (const tc of message.toolCalls) {
      let toolInput: Record<string, unknown> = {};
      if (tc.arguments) {
        try {
          const parsed: unknown = JSON.parse(tc.arguments);
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            toolInput = parsed as Record<string, unknown>;
          } else {
            throw new ChatProviderError('Tool call arguments must be a JSON object.');
          }
        } catch (error) {
          if (error instanceof ChatProviderError) throw error;
          throw new ChatProviderError('Tool call arguments must be valid JSON.');
        }
      }
      blocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input: toolInput,
      } satisfies ToolUseBlockParam);
    }
  }

  return { role: role, content: blocks };
}
export function convertAnthropicError(error: unknown): ChatProviderError {
  // Check timeout before connection (APIConnectionTimeoutError extends APIConnectionError)
  if (error instanceof AnthropicTimeoutError) {
    return new APITimeoutError(error.message);
  }
  if (error instanceof AnthropicConnectionError) {
    return new APIConnectionError(error.message);
  }
  // APIError with a status code => status error
  if (error instanceof AnthropicAPIError && typeof error.status === 'number') {
    const reqId = error.requestID ?? null;
    return normalizeAPIStatusError(error.status, error.message, reqId);
  }
  if (error instanceof AnthropicError) {
    return new ChatProviderError(`Anthropic error: ${error.message}`);
  }
  if (error instanceof Error) {
    return new ChatProviderError(`Error: ${error.message}`);
  }
  return new ChatProviderError(`Error: ${String(error)}`);
}
class AnthropicStreamedMessage implements StreamedMessage {
  private _id: string | null = null;
  private _usage: TokenUsage = {
    inputOther: 0,
    output: 0,
    inputCacheRead: 0,
    inputCacheCreation: 0,
  };
  private _finishReason: FinishReason | null = null;
  private _rawFinishReason: string | null = null;
  private readonly _iter: AsyncGenerator<StreamedMessagePart>;

  constructor(response: unknown, isStream: boolean) {
    if (isStream) {
      this._iter = this._convertStreamResponse(response as AsyncIterable<MessageStreamEvent>);
    } else {
      this._iter = this._convertNonStreamResponse(
        response as {
          id: string;
          stop_reason?: string | null;
          usage: {
            input_tokens: number;
            output_tokens: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
          content: Array<{
            type: string;
            text?: string;
            thinking?: string;
            signature?: string;
            data?: string;
            id?: string;
            name?: string;
            input?: unknown;
          }>;
        },
      );
    }
  }

  get id(): string | null {
    return this._id;
  }

  get usage(): TokenUsage | null {
    return this._usage;
  }

  get finishReason(): FinishReason | null {
    return this._finishReason;
  }

  get rawFinishReason(): string | null {
    return this._rawFinishReason;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
    yield* this._iter;
  }

  private _captureStopReason(raw: string | null | undefined): void {
    const normalized = normalizeAnthropicStopReason(raw);
    this._finishReason = normalized.finishReason;
    this._rawFinishReason = normalized.rawFinishReason;
  }

  private _extractUsage(usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  }): void {
    this._usage = {
      inputOther: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      inputCacheRead: usage.cache_read_input_tokens ?? 0,
      inputCacheCreation: usage.cache_creation_input_tokens ?? 0,
    };
  }

  private async *_convertNonStreamResponse(response: {
    id: string;
    stop_reason?: string | null;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    content: Array<{
      type: string;
      text?: string;
      thinking?: string;
      signature?: string;
      data?: string;
      id?: string;
      name?: string;
      input?: unknown;
    }>;
  }): AsyncGenerator<StreamedMessagePart> {
    this._id = response.id;
    this._extractUsage(response.usage);
    this._captureStopReason(response.stop_reason);

    for (const block of response.content) {
      switch (block.type) {
        case 'text':
          if (block.text !== undefined) {
            yield { type: 'text', text: block.text };
          }
          break;
        case 'thinking':
          yield block.signature !== undefined
            ? { type: 'think' as const, think: block.thinking ?? '', encrypted: block.signature }
            : { type: 'think' as const, think: block.thinking ?? '' };
          break;
        case 'redacted_thinking':
          yield block.data !== undefined
            ? { type: 'think' as const, think: '', encrypted: block.data }
            : { type: 'think' as const, think: '' };
          break;
        case 'tool_use':
          yield {
            type: 'function',
            id: block.id ?? crypto.randomUUID(),
            name: block.name ?? '',
            arguments: block.input !== undefined ? JSON.stringify(block.input) : null,
          } satisfies ToolCall;
          break;
      }
    }
  }

  private async *_convertStreamResponse(
    response: AsyncIterable<MessageStreamEvent>,
  ): AsyncGenerator<StreamedMessagePart> {
    const toolUseBlockIndexes = new Set<number>();

    try {
      for await (const event of response) {
        const evt = event as unknown as Record<string, unknown>;
        const eventType = evt['type'] as string;

        if (eventType === 'message_start') {
          const startEvt = evt as unknown as RawMessageStartEvent;
          this._id = startEvt.message.id;
          this._extractUsage(
            startEvt.message.usage as {
              input_tokens?: number;
              output_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            },
          );
        } else if (eventType === 'content_block_start') {
          const blockEvt = evt as unknown as RawContentBlockStartEvent;
          const block = blockEvt.content_block;
          const blockIndex = blockEvt.index;
          // eslint-disable-next-line typescript-eslint/switch-exhaustiveness-check
          switch (block.type) {
            case 'text':
              yield { type: 'text', text: block.text };
              break;
            case 'thinking':
              yield { type: 'think', think: block.thinking };
              break;
            case 'redacted_thinking':
              yield {
                type: 'think',
                think: '',
                encrypted: (block as unknown as { data: string }).data,
              };
              break;
            case 'tool_use':
              toolUseBlockIndexes.add(blockIndex);
              yield {
                type: 'function',
                id: block.id,
                name: block.name,
                arguments: '',
                // Carry the Anthropic block index so parallel tool_use
                // blocks' interleaved input_json_delta chunks can be routed
                // to the correct ToolCall by the generate loop.
                _streamIndex: blockIndex,
              } satisfies ToolCall;
              break;
          }
        } else if (eventType === 'content_block_delta') {
          const deltaEvt = evt as unknown as RawContentBlockDeltaEvent;
          const delta = deltaEvt.delta;
          const blockIndex = deltaEvt.index;
          // eslint-disable-next-line typescript-eslint/switch-exhaustiveness-check
          switch (delta.type) {
            case 'text_delta':
              yield { type: 'text', text: delta.text };
              break;
            case 'thinking_delta':
              yield { type: 'think', think: delta.thinking };
              break;
            case 'input_json_delta':
              yield {
                type: 'tool_call_part',
                argumentsPart: delta.partial_json,
                // Carry the Anthropic block index so this delta is routed
                // to the matching ToolCall (parallel tool_use support).
                index: blockIndex,
              };
              break;
            case 'signature_delta':
              yield {
                type: 'think',
                think: '',
                encrypted: delta.signature,
              };
              break;
          }
        } else if (eventType === 'content_block_stop') {
          // No-op: the generate loop infers tool-call completion from the
          // next non-merging part (typically the next content_block_start)
          // or from stream end. Anthropic's block boundary is therefore
          // absorbed inside the adapter rather than surfaced upstream.
        } else if (eventType === 'message_delta') {
          // Update usage from delta
          const deltaUsage = (evt as { usage?: Record<string, unknown> }).usage;
          if (deltaUsage !== undefined) {
            if (typeof deltaUsage['output_tokens'] === 'number') {
              this._usage.output = deltaUsage['output_tokens'];
            }
            if (typeof deltaUsage['cache_read_input_tokens'] === 'number') {
              this._usage.inputCacheRead = deltaUsage['cache_read_input_tokens'];
            }
            if (typeof deltaUsage['cache_creation_input_tokens'] === 'number') {
              this._usage.inputCacheCreation = deltaUsage['cache_creation_input_tokens'];
            }
            if (typeof deltaUsage['input_tokens'] === 'number') {
              this._usage.inputOther = deltaUsage['input_tokens'];
            }
          }
          // The terminal `stop_reason` lives on `delta.stop_reason` of the
          // last `message_delta` event for this response. Capture it here.
          //
          // Accept `null` explicitly: if the key is present we forward the
          // value (including null) to `_captureStopReason`, which maps it to
          // `{null, null}`. Only a missing key skips the capture. This avoids
          // a stale prior capture persisting after an explicit null reset.
          const messageDeltaPayload = (evt as { delta?: Record<string, unknown> }).delta;
          if (messageDeltaPayload !== undefined && 'stop_reason' in messageDeltaPayload) {
            this._captureStopReason(
              messageDeltaPayload['stop_reason'] as string | null | undefined,
            );
          }
        }
        // message_stop: nothing to do
      }
    } catch (error: unknown) {
      throw convertAnthropicError(error);
    }
  }
}
export class AnthropicChatProvider implements ChatProvider {
  readonly name: string = 'anthropic';

  private _model: string;
  private _stream: boolean;
  private _client: Anthropic | undefined;
  private _generationKwargs: AnthropicGenerationKwargs;
  private _metadata: Record<string, string> | undefined;
  private _apiKey: string | undefined;
  private _baseUrl: string | undefined;
  private _defaultHeaders: Record<string, string> | undefined;
  private _clientFactory: ((auth: ProviderRequestAuth) => Anthropic) | undefined;
  private _adaptiveThinking: boolean | undefined;
  private _explicitMaxTokens: boolean;

  constructor(options: AnthropicOptions) {
    this._model = options.model;
    this._stream = options.stream ?? true;
    this._metadata = options.metadata;
    this._adaptiveThinking = options.adaptiveThinking;
    const apiKey = options.apiKey ?? process.env['ANTHROPIC_API_KEY'];
    this._apiKey = apiKey === undefined || apiKey.length === 0 ? undefined : apiKey;
    this._baseUrl = options.baseUrl;
    this._defaultHeaders = options.defaultHeaders;
    this._clientFactory = options.clientFactory;
    this._client = this._apiKey === undefined ? undefined : this._buildClient(this._apiKey);
    this._explicitMaxTokens = options.defaultMaxTokens !== undefined;
    this._generationKwargs = {
      max_tokens: resolveDefaultMaxTokens(options.model, options.defaultMaxTokens),
      betaFeatures: options.betaFeatures ?? [INTERLEAVED_THINKING_BETA],
    };
  }

  get modelName(): string {
    return this._model;
  }

  get thinkingEffort(): ThinkingEffort | null {
    const thinkingConfig = this._generationKwargs.thinking;
    if (thinkingConfig === undefined || thinkingConfig === null) {
      return null;
    }
    if (thinkingConfig.type === 'disabled') {
      return 'off';
    }
    if (thinkingConfig.type === 'adaptive') {
      const effort = this._generationKwargs.output_config?.effort;
      if (effort === undefined || effort === null) {
        return 'high';
      }
      switch (effort) {
        case 'low':
        case 'medium':
        case 'high':
        case 'xhigh':
        case 'max':
          return effort;
      }
    }
    // budget-based
    const budget = (thinkingConfig as { budget_tokens?: number }).budget_tokens ?? 0;
    if (budget <= 1024) {
      return 'low';
    }
    if (budget <= 4096) {
      return 'medium';
    }
    return 'high';
  }

  get modelParameters(): Record<string, unknown> {
    return {
      model: this._model,
      ...this._generationKwargs,
    };
  }

  getCapability(model?: string): ModelCapability {
    return getAnthropicModelCapability(model ?? this._model);
  }

  async generate(
    systemPrompt: string,
    tools: Tool[],
    history: Message[],
    options?: GenerateOptions,
  ): Promise<StreamedMessage> {
    // Build system param
    const system: TextBlockParam[] | undefined = systemPrompt
      ? [
          {
            type: 'text',
            text: systemPrompt,
            cache_control: CACHE_CONTROL,
          } as TextBlockParam,
        ]
      : undefined;

    // Convert messages, merging consecutive tool-result-only user messages
    // into a single user message (Anthropic parallel-tool-use spec).
    const messages: MessageParam[] = [];
    const normalizedHistory = normalizeToolCallIdsForProvider(
      history,
      ANTHROPIC_TOOL_CALL_ID_POLICY,
    );
    for (const msg of normalizedHistory) {
      const converted = convertMessage(msg);
      const last = messages.at(-1);
      if (last !== undefined && isToolResultOnly(last) && isToolResultOnly(converted)) {
        last.content = [
          ...(last.content as ContentBlockParam[]),
          ...(converted.content as ContentBlockParam[]),
        ];
      } else {
        messages.push(converted);
      }
    }

    // Inject cache_control on last content block of last message (after merge,
    // so it lands on the final tool_result block in the merged user message).
    injectCacheControlOnLastBlock(messages);

    // Build generation kwargs (excluding betaFeatures)
    const kwargs: Record<string, unknown> = {};
    if (this._generationKwargs.max_tokens !== undefined) {
      kwargs['max_tokens'] = this._generationKwargs.max_tokens;
    }
    if (this._generationKwargs.temperature !== undefined) {
      kwargs['temperature'] = this._generationKwargs.temperature;
    }
    if (this._generationKwargs.top_k !== undefined) {
      kwargs['top_k'] = this._generationKwargs.top_k;
    }
    if (this._generationKwargs.top_p !== undefined) {
      kwargs['top_p'] = this._generationKwargs.top_p;
    }
    if (this._generationKwargs.thinking !== undefined) {
      kwargs['thinking'] = this._generationKwargs.thinking;
    }
    if (this._generationKwargs.output_config !== undefined) {
      kwargs['output_config'] = this._generationKwargs.output_config;
    }

    // Build beta headers
    const betas = this._generationKwargs.betaFeatures ?? [];
    const extraHeaders: Record<string, string> = {};
    if (betas.length > 0) {
      extraHeaders['anthropic-beta'] = betas.join(',');
    }

    // Convert tools
    const anthropicTools: AnthropicToolParam[] = tools.map((t) => convertTool(t));
    if (anthropicTools.length > 0) {
      const lastTool = anthropicTools.at(-1);
      if (lastTool !== undefined) {
        lastTool.cache_control = CACHE_CONTROL;
      }
    }

    // Build the create params
    const createParams: Record<string, unknown> = {
      model: this._model,
      messages,
      ...kwargs,
    };

    if (system !== undefined) {
      createParams['system'] = system;
    }

    if (anthropicTools.length > 0) {
      createParams['tools'] = anthropicTools;
    }

    if (this._metadata !== undefined) {
      createParams['metadata'] = this._metadata;
    }

    const requestOptions: Record<string, unknown> = {};
    const headers = mergeRequestHeaders(extraHeaders, options?.auth?.headers);
    if (headers !== undefined) {
      requestOptions['headers'] = headers;
    }
    if (options?.signal) {
      requestOptions['signal'] = options.signal;
    }
    const finalRequestOptions = Object.keys(requestOptions).length > 0 ? requestOptions : undefined;
    const client = this._createClient(options?.auth);

    if (this._stream) {
      // Use the raw Messages stream instead of the SDK MessageStream helper.
      // The helper reparses accumulated input_json_delta buffers on every chunk,
      // which becomes synchronous O(n^2) work for large streamed tool arguments.
      try {
        const stream = await client.messages.create(
          { ...createParams, stream: true } as unknown as MessageCreateParamsStreaming,
          finalRequestOptions,
        );
        return new AnthropicStreamedMessage(stream, true);
      } catch (error: unknown) {
        throw convertAnthropicError(error);
      }
    }

    // Non-streaming fallback
    try {
      const response = await client.messages.create(
        { ...createParams, stream: false } as unknown as MessageCreateParams,
        finalRequestOptions,
      );
      return new AnthropicStreamedMessage(response, false);
    } catch (error: unknown) {
      throw convertAnthropicError(error);
    }
  }

  private _createClient(auth: ProviderRequestAuth | undefined): Anthropic {
    return resolveAuthBackedClient(
      { cachedClient: this._client, clientFactory: this._clientFactory },
      auth,
      (a) => this._buildClient(requireProviderApiKey('AnthropicChatProvider', a, this._apiKey)),
    );
  }

  private _buildClient(apiKey: string): Anthropic {
    return new Anthropic({
      apiKey,
      baseURL: this._baseUrl,
      defaultHeaders: this._defaultHeaders,
    });
  }

  withThinking(effort: ThinkingEffort): AnthropicChatProvider {
    // Resolve once: an explicit `adaptiveThinking` option overrides the
    // model-name version inference, so custom-named endpoints can opt in/out.
    const adaptive = this._adaptiveThinking ?? supportsAdaptiveThinking(this._model);

    if (effort === 'off') {
      let newBetas = [...(this._generationKwargs.betaFeatures ?? [])];
      if (adaptive) {
        newBetas = newBetas.filter((b) => b !== INTERLEAVED_THINKING_BETA);
      }
      const clone = this._withGenerationKwargs({
        thinking: { type: 'disabled' },
        betaFeatures: newBetas,
      });
      delete clone._generationKwargs.output_config;
      return clone;
    }

    const effectiveEffort = clampEffort(effort, this._model, adaptive);
    if (effectiveEffort === 'off') {
      throw new Error('Non-off thinking effort unexpectedly clamped to off.');
    }

    let newBetas = [...(this._generationKwargs.betaFeatures ?? [])];

    if (adaptive) {
      newBetas = newBetas.filter((b) => b !== INTERLEAVED_THINKING_BETA);
      return this._withGenerationKwargs({
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: effectiveEffort },
        betaFeatures: newBetas,
      });
    }

    const kwargs: Partial<AnthropicGenerationKwargs> = {
      thinking: { type: 'enabled', budget_tokens: budgetTokensForEffort(effectiveEffort) },
      betaFeatures: newBetas,
    };
    if (supportsEffortParam(this._model, adaptive)) {
      kwargs.output_config = { effort: effectiveEffort };
    } else {
      kwargs.output_config = undefined;
    }
    const clone = this._withGenerationKwargs(kwargs);
    if (!supportsEffortParam(this._model, adaptive)) {
      delete clone._generationKwargs.output_config;
    }
    return clone;
  }

  withGenerationKwargs(kwargs: Partial<AnthropicGenerationKwargs>): AnthropicChatProvider {
    return this._withGenerationKwargs(kwargs);
  }

  withMaxCompletionTokens(maxCompletionTokens: number): AnthropicChatProvider {
    const requestedCap = resolveDefaultMaxTokens(this._model, maxCompletionTokens);
    const existingCap = this._generationKwargs.max_tokens;
    const clone = this._withGenerationKwargs({
      max_tokens:
        existingCap === undefined || this._explicitMaxTokens
          ? existingCap ?? requestedCap
          : Math.min(existingCap, requestedCap),
    });
    clone._explicitMaxTokens = this._explicitMaxTokens;
    return clone;
  }

  private _withGenerationKwargs(kwargs: Partial<AnthropicGenerationKwargs>): AnthropicChatProvider {
    const clone = this._clone();
    clone._generationKwargs = { ...clone._generationKwargs, ...kwargs };
    if ('max_tokens' in kwargs) {
      clone._explicitMaxTokens = kwargs.max_tokens !== undefined;
    }
    return clone;
  }

  private _clone(): AnthropicChatProvider {
    const clone = Object.assign(
      Object.create(Object.getPrototypeOf(this) as object) as AnthropicChatProvider,
      this,
    );
    clone._generationKwargs = { ...this._generationKwargs };
    return clone;
  }
}
