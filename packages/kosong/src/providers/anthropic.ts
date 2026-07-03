import {
  APIConnectionError,
  APITimeoutError,
  ChatProviderError,
  classifyBaseApiError,
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

import { mergeConsecutiveUserMessages } from './merge-user-messages';
import { mergeRequestHeaders, resolveAuthBackedClient } from './request-auth';
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
  /**
   * Use the Anthropic **beta** Messages API (`client.beta.messages.create`,
   * `POST /v1/messages?beta=true`) instead of the standard Messages API.
   *
   * Beta features (`betaFeatures`) are then sent via the request `betas`
   * field rather than the `anthropic-beta` header. Defaults to false, which
   * keeps the standard endpoint + header behavior.
   */
  betaApi?: boolean | undefined;
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

// Anthropic's native effort values. `ThinkingEffort` is an open string, so after
// clamping (and ruling out 'off') we narrow to this concrete set before writing
// `output_config.effort` / computing a token budget.
type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14';
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
  // Claude Fable 5 documents a 128k output ceiling.
  'fable-5': 128000,
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

type ClaudeFamily = 'opus' | 'sonnet' | 'haiku' | 'fable';

interface ClaudeVersion {
  family: ClaudeFamily;
  major: number;
  minor: number | null;
}

// Family-first form: "opus-4-7", "sonnet-4.6", "haiku-4-5-20251001",
// "fable-5" (single version component — Fable ids carry no minor).
// Version numbers are capped at 1–2 digits with a non-digit lookahead so
// 8-digit date suffixes (e.g. `-20251001`) don't get consumed as version
// components.
const FAMILY_FIRST_RE =
  /(opus|sonnet|haiku|fable)[-._](\d{1,2})(?!\d)(?:[-._](\d{1,2})(?!\d))?/;
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
  return parseClaudeFamilyVersion(model, true);
}

function parseClaudeAliasVersion(model: string): ClaudeVersion | null {
  return parseClaudeFamilyVersion(model, false);
}

function parseClaudeFamilyVersion(model: string, requireClaudeMarker: boolean): ClaudeVersion | null {
  const normalized = model.toLowerCase();
  // Guard against false positives on non-Claude models that happen to
  // contain an `opus-4-7`-like substring (e.g. fine-tunes named after a
  // checkpoint). The Anthropic provider might still be configured for
  // non-Claude endpoints, so without this guard we'd quietly apply
  // Claude ceilings to unrelated models.
  if (requireClaudeMarker && !normalized.includes('claude')) return null;

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
  const version = parseClaudeAliasVersion(model);
  if (version === null) {
    return false;
  }
  // A missing minor is a bare family-major id: "claude-fable-5" (5.0 ≥ 4.6,
  // adaptive-only) or "claude-opus-4" (4.0 < 4.6, budget-based).
  return versionAtLeast(
    { major: version.major, minor: version.minor ?? 0 },
    ADAPTIVE_MIN_VERSION,
  );
}

function isOpus47(model: string): boolean {
  const match = OPUS_VERSION_RE.exec(model.toLowerCase());
  if (match === null) {
    return false;
  }
  const version = parseVersion(match);
  return version.major === 4 && version.minor === 7;
}

function isFableModel(model: string): boolean {
  return parseClaudeAliasVersion(model)?.family === 'fable';
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
  if (effort === 'xhigh' && !isOpus47(model) && !isFableModel(model)) {
    return 'high';
  }
  if (effort === 'max' && !adaptive) {
    return 'high';
  }
  // 'on' (boolean models) or any effort Anthropic does not recognize: fall
  // back to 'high' so budgetTokensForEffort / output_config.effort never see
  // an unsupported value.
  if (
    effort !== 'low' &&
    effort !== 'medium' &&
    effort !== 'high' &&
    effort !== 'xhigh' &&
    effort !== 'max'
  ) {
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

function shouldPreserveUnsignedThinking(model: string): boolean {
  return parseClaudeAliasVersion(model) === null;
}

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
 * Whether a user MessageParam consists solely of `tool_result` blocks. Used to
 * keep tool results bundled with each other (parallel-tool-use spec) while
 * not merging a tool-result user message into an adjacent plain-text user
 * message — the two carry different semantics and must stay separate.
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

interface AnthropicVideoBlock {
  type: 'video';
  source:
    | { type: 'base64'; media_type: string; data: string }
    | { type: 'url'; url: string };
}

// The Messages API has no representation for audio input. Instead of
// silently dropping such parts (the model would not even know an attachment
// existed), emit a placeholder text block so it can acknowledge the gap.
// Consecutive parts of the same kind collapse into a single placeholder.
const OMITTED_MEDIA_PLACEHOLDER = {
  audio_url: '(audio omitted: not supported by this provider)',
} as const;

const SUPPORTED_B64_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const SUPPORTED_B64_VIDEO_TYPES = new Set([
  'video/mp4',
  'video/mpeg',
  'video/quicktime',
  'video/webm',
  'video/x-matroska',
  'video/x-msvideo',
  'video/x-flv',
  'video/3gpp',
]);

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

function videoUrlPartToAnthropic(url: string): AnthropicVideoBlock {
  if (url.startsWith('data:')) {
    const withoutScheme = url.slice(5);
    const parts = withoutScheme.split(';base64,', 2);
    if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
      throw new ChatProviderError(`Invalid data URL for video: ${url}`);
    }
    const mediaType = parts[0];
    const data = parts[1];
    if (!SUPPORTED_B64_VIDEO_TYPES.has(mediaType)) {
      throw new ChatProviderError(
        `Unsupported media type for base64 video: ${mediaType}, url: ${url}`,
      );
    }
    return {
      type: 'video',
      source: { type: 'base64', media_type: mediaType, data },
    };
  }

  return {
    type: 'video',
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
  const blocks: Array<TextBlockParam | AnthropicImageBlock | AnthropicVideoBlock> = [];
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text) {
        blocks.push({ type: 'text', text: part.text });
      }
    } else if (part.type === 'image_url') {
      blocks.push(imageUrlPartToAnthropic(part.imageUrl.url));
    } else if (part.type === 'video_url') {
      blocks.push(videoUrlPartToAnthropic(part.videoUrl.url));
    } else if (part.type === 'audio_url') {
      const placeholder = OMITTED_MEDIA_PLACEHOLDER[part.type];
      const last = blocks.at(-1);
      if (!(last?.type === 'text' && last.text === placeholder)) {
        blocks.push({ type: 'text', text: placeholder });
      }
    }
  }
  return {
    type: 'tool_result',
    tool_use_id: toolCallId,
    content: blocks,
  } as ToolResultBlockParam;
}
function convertMessage(message: Message, model: string): MessageParam {
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
      // here is what broke multi-step tool use on those backends. Claude
      // models reject unsigned thinking blocks, so those are only preserved
      // for non-Claude Anthropic-compatible models. An unsigned part with no
      // text carries nothing, so it is skipped.
      if (part.encrypted !== undefined) {
        blocks.push({
          type: 'thinking',
          thinking: part.think,
          signature: part.encrypted,
        } satisfies ThinkingBlockParam);
      } else if (part.think !== '' && shouldPreserveUnsignedThinking(model)) {
        blocks.push({ type: 'thinking', thinking: part.think } as unknown as ThinkingBlockParam);
      }
    } else if (part.type === 'video_url') {
      blocks.push(videoUrlPartToAnthropic(part.videoUrl.url) as unknown as ContentBlockParam);
    } else if (part.type === 'audio_url') {
      const placeholder = OMITTED_MEDIA_PLACEHOLDER[part.type];
      const last = blocks.at(-1);
      if (!(last?.type === 'text' && last.text === placeholder)) {
        blocks.push({ type: 'text', text: placeholder } satisfies TextBlockParam);
      }
    }
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
  // Raw, non-SDK errors (e.g. undici's `TypeError: terminated` raised when a
  // streaming response body is dropped mid-flight) are never wrapped by the
  // Anthropic SDK during stream iteration. Route them through the shared
  // transport-layer heuristic so genuine connection failures become retryable
  // instead of fatal generic errors.
  if (error instanceof Error) {
    return classifyBaseApiError(error.message);
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
  private _defaultHeaders: Record<string, string | null> | undefined;
  private _clientFactory: ((auth: ProviderRequestAuth) => Anthropic) | undefined;
  private _adaptiveThinking: boolean | undefined;
  private _betaApi: boolean;
  private _explicitMaxTokens: boolean;

  constructor(options: AnthropicOptions) {
    this._model = options.model;
    this._stream = options.stream ?? true;
    this._metadata = options.metadata;
    this._adaptiveThinking = options.adaptiveThinking;
    this._betaApi = options.betaApi ?? false;
    this._apiKey =
      options.apiKey === undefined || options.apiKey.length === 0 ? undefined : options.apiKey;
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

    // Convert messages, then merge consecutive user messages into one. Strict
    // Anthropic-compatible backends reject consecutive user messages with HTTP
    // 400 ("roles must alternate"), and api.anthropic.com concatenates them
    // anyway — so merging is safe for native Anthropic and required for strict
    // backends. Consecutive plain-text user messages arise naturally after
    // compaction (kept user prompts + user-role summary + injected reminders)
    // and from back-to-back system messages converted to user role above; a
    // tool-result user turn followed by a text turn arises from steering after
    // a tool result. The shared helper applies the asymmetric merge rule (see
    // mergeConsecutiveUserMessages) so this provider and Gemini/Vertex stay in
    // step.
    const messages = mergeConsecutiveUserMessages(
      normalizeToolCallIdsForProvider(history, ANTHROPIC_TOOL_CALL_ID_POLICY).map((msg) =>
        convertMessage(msg, this._model),
      ),
      {
        isUser: (message) => message.role === 'user',
        isToolResultOnly,
        merge: (last, next) => ({
          ...last,
          content: [
            ...(last.content as ContentBlockParam[]),
            ...(next.content as ContentBlockParam[]),
          ],
        }),
      },
    );

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
    // Fable rejects an explicit `disabled` thinking config (HTTP 400, unlike
    // Opus 4.7/4.8 which accept it), so omit the field instead. Note thinking
    // cannot actually be turned off on Fable: adaptive thinking is always on,
    // and an omitted `thinking` field still runs with it.
    const thinking = this._generationKwargs.thinking;
    if (thinking !== undefined && !(thinking.type === 'disabled' && isFableModel(this._model))) {
      kwargs['thinking'] = thinking;
    }
    if (this._generationKwargs.output_config !== undefined) {
      kwargs['output_config'] = this._generationKwargs.output_config;
    }

    // Build the beta feature list. On the standard Messages API these travel
    // via the `anthropic-beta` header; on the beta Messages API (`betaApi`) the
    // SDK reads them from the request `betas` field and sets the header itself,
    // so we must not also set the header (that would duplicate it).
    const betas = this._generationKwargs.betaFeatures ?? [];
    const extraHeaders: Record<string, string> = {};
    if (!this._betaApi && betas.length > 0) {
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

    if (this._betaApi && betas.length > 0) {
      createParams['betas'] = betas;
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
    options?.onRequestSent?.();

    if (this._stream) {
      // Use the raw Messages stream instead of the SDK MessageStream helper.
      // The helper reparses accumulated input_json_delta buffers on every chunk,
      // which becomes synchronous O(n^2) work for large streamed tool arguments.
      try {
        const stream = this._betaApi
          ? await client.beta.messages.create(
              { ...createParams, stream: true } as unknown as MessageCreateParamsStreaming,
              finalRequestOptions,
            )
          : await client.messages.create(
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
      const response = this._betaApi
        ? await client.beta.messages.create(
            { ...createParams, stream: false } as unknown as MessageCreateParams,
            finalRequestOptions,
          )
        : await client.messages.create(
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
      (a) => this._buildClient(this._requireApiKey(a)),
    );
  }

  private _requireApiKey(auth: ProviderRequestAuth | undefined): string {
    const apiKey = auth?.apiKey ?? this._apiKey;
    if (apiKey === undefined || apiKey.length === 0) {
      throw new ChatProviderError(
        'AnthropicChatProvider: apiKey is required. Provide it via constructor options, options.auth.apiKey on each request, or an OAuth login. The Anthropic adapter does not read shell API-key environment variables.',
      );
    }
    return apiKey;
  }

  private _anthropicCustomHeaderEnvNames(): string[] {
    const customHeaders = process.env['ANTHROPIC_CUSTOM_HEADERS'];
    if (customHeaders === undefined || customHeaders.length === 0) return [];

    const names: string[] = [];
    for (const line of customHeaders.split('\n')) {
      const colonIndex = line.indexOf(':');
      if (colonIndex < 0) continue;

      const name = line.slice(0, colonIndex).trim().toLowerCase();
      if (name.length > 0) names.push(name);
    }
    return names;
  }

  private _buildDefaultHeaders(apiKey: string): Record<string, string | null> {
    const defaultHeaders: Record<string, string | null> = { authorization: null };
    for (const name of this._anthropicCustomHeaderEnvNames()) {
      defaultHeaders[name] = null;
    }
    for (const [name, value] of Object.entries(this._defaultHeaders ?? {})) {
      defaultHeaders[name.toLowerCase()] = value;
    }
    defaultHeaders['x-api-key'] = apiKey;
    return defaultHeaders;
  }

  // We use the Anthropic SDK purely as a transport to arbitrary
  // anthropic-compatible endpoints (`baseUrl` may point anywhere). Left to its
  // defaults the SDK auto-discovers credentials from the shell environment
  // (ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL, ANTHROPIC_CUSTOM_HEADERS), which
  // would leak an out-of-band bearer/headers to a third-party endpoint even when
  // an explicit apiKey is set. So we hard-disable every auto-discovery channel.
  // These `null`s — and the nulled headers in _buildDefaultHeaders — are NOT
  // redundant: removing them reintroduces credential leakage. Regression cover:
  // test/e2e/anthropic-adapter.test.ts.
  private _buildClient(apiKey: string): Anthropic {
    return new Anthropic({
      apiKey,
      authToken: null,
      baseURL: this._baseUrl ?? null,
      defaultHeaders: this._buildDefaultHeaders(apiKey),
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

    const clamped = clampEffort(effort, this._model, adaptive);
    if (clamped === 'off') {
      throw new Error('Non-off thinking effort unexpectedly clamped to off.');
    }
    const effectiveEffort = clamped as AnthropicEffort;

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
