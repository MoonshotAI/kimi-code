import {
  getProviderModelCapability,
  UNKNOWN_CAPABILITY,
  type ModelCapability,
} from '@moonshot-ai/kosong';

import type { ModelAlias, ProviderType } from './schema';

/**
 * Resolve the effective capabilities of a model alias: the alias's declared
 * capability strings (trimmed, case-insensitive) merged additively with
 * kosong's built-in model knowledge for the provider wire type — e.g.
 * `claude-fable-5`, whose thinking cannot be turned off, detects as
 * `always_thinking` without the user declaring it by hand.
 *
 * This is where declarations and detection meet, and the merge is a union:
 * declarations can add capabilities on top of detection but never veto it.
 * No detected value is ever persisted — config objects stay pure
 * declarations, nothing is written into `models.<alias>.capabilities` at load
 * time, and write-back paths persist config snapshots verbatim. So when
 * kosong's model knowledge is corrected later, the correction takes effect on
 * upgrade without any stale materialized copy to migrate. Consumers that
 * gate on a capability being PRESENT (session capability resolution, the
 * model selector's thinking availability, ACP's model catalog) call this
 * instead of interpreting the raw strings themselves.
 *
 * Caveat — unknown flattens to false: when kosong has no knowledge of the
 * model (or `providerType` is undefined), detection is UNKNOWN_CAPABILITY and
 * the merge cannot distinguish "detected as unsupported" from "never
 * catalogued" (kosong's `isUnknownCapability` marker does not survive the
 * merge). Consumers that want to be PERMISSIVE when nothing is declared —
 * like the TUI's media-attachment gate — must keep reading the raw declared
 * strings; resolving here would wrongly reject modalities on models kosong
 * does not know.
 */
export function resolveAliasCapabilities(
  providerType: ProviderType | undefined,
  alias: ModelAlias,
): ModelCapability {
  const declared = new Set((alias.capabilities ?? []).map((c) => c.trim().toLowerCase()));
  const detected =
    providerType === undefined
      ? UNKNOWN_CAPABILITY
      : getProviderModelCapability(providerType, alias.model);
  return {
    image_in: declared.has('image_in') || detected.image_in,
    video_in: declared.has('video_in') || detected.video_in,
    audio_in: declared.has('audio_in') || detected.audio_in,
    thinking: declared.has('thinking') || declared.has('always_thinking') || detected.thinking,
    always_thinking: declared.has('always_thinking') || detected.always_thinking ? true : undefined,
    tool_use: declared.has('tool_use') || detected.tool_use,
    max_context_tokens: alias.maxContextSize,
  };
}
