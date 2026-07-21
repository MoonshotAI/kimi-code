/**
 * `kosong/protocol` domain (L1) — the declarative trait surface.
 *
 * A `ProtocolTrait` is a stateless declaration of how one vendor deviates
 * from a wire base: sixteen fully optional hooks plus rare metadata markers
 * (non-function fields like `strictThinkingValidation` that qualify how a
 * hook's behavior is governed, without adding a code path). A trait declares
 * a deviation only where one exists; a hook returning `undefined` always
 * means "keep the base default".
 *
 * Composition rules (the L2 compositors implement them; they are restated
 * here because they are part of the trait contract):
 *
 *  - Pipeline hooks (`convertMessage` / `mergeHistory` / `buildParams`)
 *    chain in trait order, each receiving the previous stage's output.
 *    `convertMessage` may additionally return `null` to drop the message.
 *  - Single-value hooks are overwritten in trait order: last declarer wins.
 *  - `endpoint` / `defaultHeaders` / `provides` are construction-time
 *    declarations aggregated by the contrib factories, not per-request hooks.
 *
 * `TraitContext` carries only `{ config, providerId? }` — never the vendor
 * definition object. That is the detail that makes the L1↛L2 layering hold:
 * traits see configuration, not registry state.
 */

import type { ModelCapability } from '#/kosong/contract/capability';
import type { Message, VideoURLPart } from '#/kosong/contract/message';
import type {
  GenerateOptions,
  ThinkingEffort,
  ToolCallIdPolicy,
  VideoUploadInput,
} from '#/kosong/contract/provider';
import type { Tool } from '#/kosong/contract/tool';

import type { ProtocolAdapterConfig } from './protocol';

/**
 * Everything a trait hook may read: the adapter configuration for this
 * composition, plus the vendor's identity string. The context is bound per
 * trait at composition time (`ResolvedTrait`) and threaded through every
 * hook call by the compositor, so trait implementations stay stateless
 * declarations.
 */
export interface TraitContext {
  readonly config: ProtocolAdapterConfig;
  readonly providerId?: string;
}

/**
 * Construction-time endpoint fallback-chain declaration. Each trait declares
 * at most one env var per kind; the composer concatenates declarations in
 * trait order to form the fallback chain (config `apiKey` / `baseUrl` always
 * take precedence over any env), and `defaultBaseUrl` is last-declarer-wins.
 */
export interface ProtocolEndpoint {
  readonly apiKeyEnv?: string;
  readonly baseUrlEnv?: string;
  readonly defaultBaseUrl?: string;
}

export interface ProtocolTrait {
  /**
   * Metadata marker (NOT a hook): when this trait is the one driving thinking
   * encoding for a `(protocol, providerType)` pair — i.e. it is the last
   * resolved declarer of `withThinking` — whether client-side
   * thinking-effort validation must be strict (reject efforts the model
   * metadata does not list) rather than lenient (warn-and-send). Declare it
   * only on traits whose backend is the vendor's own API with closed effort
   * semantics; foreign transports stay lenient because their backend may
   * accept efforts the local catalog does not list. Absent means lenient.
   */
  readonly strictThinkingValidation?: boolean;

  /**
   * Construction-time: extra options the trait provides to the base adapter
   * (e.g. stream mode or transport-specific knobs a base understands).
   * Aggregated by the contrib factory, later declarer wins per key, applied
   * under explicit config. `undefined` provides nothing.
   */
  provides?(ctx: TraitContext): Record<string, unknown> | undefined;

  /** Construction-time: endpoint fallback-chain declaration. */
  endpoint?(ctx: TraitContext): ProtocolEndpoint | undefined;

  /**
   * Construction-time: default request headers. Aggregated in trait order,
   * later declarer wins per key (see `traitDefaultHeaders`); config
   * `defaultHeaders` always wins overall because the registry appends it as
   * the trailing synthetic trait.
   */
  defaultHeaders?(ctx: TraitContext): Record<string, string> | undefined;

  /**
   * Convert one tool definition to its wire shape. Single-value: the base
   * uses `convertTool ?? <base default>` per tool. `undefined` keeps the
   * base conversion.
   */
  convertTool?(tool: Tool, ctx: TraitContext): Record<string, unknown> | undefined;

  /**
   * Pipeline: post-process one base-converted wire message. Receives the
   * previous stage's output (the base conversion for the first declarer)
   * and returns the shaped message, or `null` to drop the message from the
   * request entirely.
   */
  convertMessage?(
    message: Message,
    converted: Record<string, unknown>,
    ctx: TraitContext,
  ): Record<string, unknown> | null;

  /**
   * Pipeline: reshape the whole converted wire history (e.g. merge
   * consecutive same-role messages). Receives the previous stage's output;
   * `undefined` leaves the history unchanged.
   */
  mergeHistory?(
    messages: readonly Record<string, unknown>[],
    ctx: TraitContext,
  ): Record<string, unknown>[] | undefined;

  /**
   * Pipeline: post-process the fully assembled request params — the last
   * hook to run before the request is sent. Receives the previous stage's
   * output; `undefined` leaves the params unchanged.
   */
  buildParams?(
    params: Record<string, unknown>,
    ctx: TraitContext,
  ): Record<string, unknown> | undefined;

  /** Single-value: tool-call id rewrite policy, replacing the base policy. */
  toolCallIdPolicy?(ctx: TraitContext): ToolCallIdPolicy | undefined;

  /**
   * Per-turn thinking intent → generation-kwargs patch. Receives the kwargs
   * already seeded by earlier intents (cacheKey, sampling) and returns the
   * patch to merge in. `undefined` hands the effort back to the base's own
   * reasoning-effort path. When any trait declares this hook the base must
   * not auto-enable its native reasoning field.
   */
  withThinking?(
    effort: ThinkingEffort,
    options: { readonly keep?: string },
    generationKwargs: Record<string, unknown>,
    ctx: TraitContext,
  ): Record<string, unknown> | undefined;

  /**
   * Whether the current request must replay reasoning fields for assistant
   * messages (e.g. reading the seeded thinking config out of the kwargs).
   * `undefined` keeps the base default (no forced replay).
   */
  preserveThinking?(
    generationKwargs: Record<string, unknown>,
    ctx: TraitContext,
  ): boolean | undefined;

  /**
   * Completion-token budget → generation-kwargs patch. The base clamps the
   * budget against the context window BEFORE calling this hook (the window
   * clamp cannot be skipped); the hook decides the ceiling and the parameter
   * shape. `undefined` keeps the base ceiling and shape selection.
   */
  withMaxCompletionTokens?(
    maxCompletionTokens: number,
    ctx: TraitContext,
  ): Record<string, unknown> | undefined;

  /**
   * Prompt-cache key → generation-kwargs patch. `undefined` keeps the base
   * encoding (or the base's silent drop, where no native field exists).
   */
  cacheKey?(key: string, ctx: TraitContext): Record<string, unknown> | undefined;

  /**
   * Locate the usage payload inside one raw stream chunk when it does not
   * sit where the base expects. Returns the raw usage object for the base to
   * map, `null` to assert the chunk carries no usage (suppressing the base
   * default), or `undefined` to defer to the base default extraction.
   */
  extractUsage?(
    chunk: Record<string, unknown>,
    ctx: TraitContext,
  ): Record<string, unknown> | null | undefined;

  /**
   * The wire field name carrying reasoning content, used for both inbound
   * extraction and outbound replay. `undefined` keeps the base's known-key
   * scan.
   */
  reasoningKey?(ctx: TraitContext): string | undefined;

  /**
   * Declared capability for one model. Resolution order is definition →
   * traits → base: the registry asks traits in order (last declarer wins)
   * and falls back to the base catalog when every hook returns `undefined`.
   */
  capability?(modelName: string, ctx: TraitContext): ModelCapability | undefined;

  /**
   * Video upload facility. The base exposes `uploadVideo` on the constructed
   * provider only when a hook is bound — declaring this hook IS the
   * capability declaration.
   */
  uploadVideo?(
    input: string | VideoUploadInput,
    options: GenerateOptions | undefined,
    ctx: TraitContext,
  ): Promise<VideoURLPart>;
}

/**
 * A trait plus its bound context, as produced by the registry's resolution.
 * Compositors consume only this shape — they never see the registry or the
 * vendor definition a trait came from.
 */
export interface ResolvedTrait {
  readonly trait: ProtocolTrait;
  readonly context: TraitContext;
}

/**
 * Aggregate the `defaultHeaders` declarations of resolved traits in order:
 * later declarers win per key. Returns `undefined` when nothing is declared,
 * so callers can distinguish "no trait headers" from empty headers and apply
 * their own default header handling.
 */
export function traitDefaultHeaders(
  traits: readonly ResolvedTrait[],
): Record<string, string> | undefined {
  let headers: Record<string, string> | undefined;
  for (const { trait, context } of traits) {
    if (trait.defaultHeaders === undefined) continue;
    const declared = trait.defaultHeaders(context);
    if (declared === undefined) continue;
    headers = { ...headers, ...declared };
  }
  return headers;
}
