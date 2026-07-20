/**
 * `kosong/provider` domain (L2) — the ONLY composition point from resolved
 * traits to the OpenAI Chat Completions hook set, plus the construction-time
 * declaration aggregators every contrib factory uses.
 *
 * Composition rules (restated from the L1 trait contract):
 *
 *  - Pipeline hooks (`convertMessage` / `mergeHistory` / `buildParams`) chain
 *    in trait order, each stage receiving the previous stage's output;
 *    `convertMessage` returning `null` at any stage drops the message.
 *  - Single-value hooks are bound in trait order — last declarer wins.
 *  - `endpoint` / `provides` are construction-time declarations, aggregated
 *    separately (`traitEndpoint` / `traitProvides`); they never enter the
 *    hook set.
 *  - Zero declared per-request hooks → `undefined`, so the base bypasses all
 *    hook logic.
 */

import type { GenerateOptions, VideoUploadInput } from '#/kosong/contract/provider';
import type { Tool } from '#/kosong/contract/tool';
import type { ProtocolEndpoint, ResolvedTrait } from '#/kosong/protocol/protocolTrait';

import type { OpenAIChatCompletionsHooks } from './openai-legacy';

export function composeOpenAIChatHooks(
  traits: readonly ResolvedTrait[],
): OpenAIChatCompletionsHooks | undefined {
  const hooks: OpenAIChatCompletionsHooks = {};

  // Pipeline: convertMessage — chained in trait order; any stage returning
  // null drops the message.
  const messageShapers = traits.filter(({ trait }) => trait.convertMessage !== undefined);
  if (messageShapers.length > 0) {
    hooks.convertMessage = (message, converted) => {
      let current: Record<string, unknown> | null = converted;
      for (const { trait, context } of messageShapers) {
        current = trait.convertMessage!(message, current, context);
        if (current === null) return null;
      }
      return current;
    };
  }

  // Pipeline: mergeHistory — chained in trait order; undefined leaves the
  // history unchanged.
  const historyMergers = traits.filter(({ trait }) => trait.mergeHistory !== undefined);
  if (historyMergers.length > 0) {
    hooks.mergeHistory = (messages) => {
      let current: readonly Record<string, unknown>[] = messages;
      for (const { trait, context } of historyMergers) {
        const next = trait.mergeHistory!(current, context);
        if (next !== undefined) current = next;
      }
      return [...current];
    };
  }

  // Pipeline: buildParams — chained in trait order, last hook before send.
  const paramsBuilders = traits.filter(({ trait }) => trait.buildParams !== undefined);
  if (paramsBuilders.length > 0) {
    hooks.buildParams = (params) => {
      let current = params;
      for (const { trait, context } of paramsBuilders) {
        const next = trait.buildParams!(current, context);
        if (next !== undefined) current = next;
      }
      return current;
    };
  }

  // Single-value hooks — bound in trait order, last declarer wins.
  for (const { trait, context } of traits) {
    if (trait.convertTool !== undefined) {
      hooks.convertTool = (tool: Tool) => trait.convertTool!(tool, context);
    }
    if (trait.toolCallIdPolicy !== undefined) {
      hooks.toolCallIdPolicy = () => trait.toolCallIdPolicy!(context);
    }
    if (trait.withThinking !== undefined) {
      hooks.withThinking = (effort, options, generationKwargs) =>
        trait.withThinking!(effort, options, generationKwargs, context);
    }
    if (trait.preserveThinking !== undefined) {
      hooks.preserveThinking = (generationKwargs) =>
        trait.preserveThinking!(generationKwargs, context);
    }
    if (trait.withMaxCompletionTokens !== undefined) {
      hooks.withMaxCompletionTokens = (maxCompletionTokens) =>
        trait.withMaxCompletionTokens!(maxCompletionTokens, context);
    }
    if (trait.cacheKey !== undefined) {
      hooks.cacheKey = (key) => trait.cacheKey!(key, context);
    }
    if (trait.extractUsage !== undefined) {
      hooks.extractUsage = (chunk) => trait.extractUsage!(chunk, context);
    }
    if (trait.reasoningKey !== undefined) {
      hooks.reasoningKey = () => trait.reasoningKey!(context);
    }
    if (trait.uploadVideo !== undefined) {
      hooks.uploadVideo = (input: string | VideoUploadInput, options?: GenerateOptions) =>
        trait.uploadVideo!(input, options, context);
    }
  }

  return Object.keys(hooks).length > 0 ? hooks : undefined;
}

/**
 * The aggregated construction-time endpoint declaration: env fallback chains
 * concatenated in trait order (first resolvable value wins), `defaultBaseUrl`
 * last-declarer-wins. `undefined` when NO trait declares an endpoint at all —
 * the contrib factory then lets the base use its own environment defaults.
 */
export interface AggregatedEndpoint {
  readonly apiKeyEnv: readonly string[];
  readonly baseUrlEnv: readonly string[];
  readonly defaultBaseUrl?: string;
}

export function traitEndpoint(traits: readonly ResolvedTrait[]): AggregatedEndpoint | undefined {
  const apiKeyEnv: string[] = [];
  const baseUrlEnv: string[] = [];
  let defaultBaseUrl: string | undefined;
  let declared = false;
  for (const { trait, context } of traits) {
    if (trait.endpoint === undefined) continue;
    const endpoint: ProtocolEndpoint | undefined = trait.endpoint(context);
    if (endpoint === undefined) continue;
    declared = true;
    if (endpoint.apiKeyEnv !== undefined) apiKeyEnv.push(endpoint.apiKeyEnv);
    if (endpoint.baseUrlEnv !== undefined) baseUrlEnv.push(endpoint.baseUrlEnv);
    if (endpoint.defaultBaseUrl !== undefined) defaultBaseUrl = endpoint.defaultBaseUrl;
  }
  return declared ? { apiKeyEnv, baseUrlEnv, defaultBaseUrl } : undefined;
}

/** The first non-empty `process.env` value in the chain, in order. */
export function firstProcessEnv(names: readonly string[] | undefined): string | undefined {
  if (names === undefined) return undefined;
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Aggregate the `provides` declarations of resolved traits: construction-time
 * extra base options, later declarer wins per key. The contrib factory
 * spreads the result UNDER the explicit config-derived options, so explicit
 * configuration always wins.
 */
export function traitProvides(
  traits: readonly ResolvedTrait[],
): Record<string, unknown> | undefined {
  let provides: Record<string, unknown> | undefined;
  for (const { trait, context } of traits) {
    if (trait.provides === undefined) continue;
    const declared = trait.provides(context);
    if (declared === undefined) continue;
    provides = { ...provides, ...declared };
  }
  return provides;
}

/**
 * Drop undefined-valued keys so an explicit-but-absent config value never
 * clobbers a `provides`-supplied option when the factory spreads them.
 */
export function compactObject<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}
