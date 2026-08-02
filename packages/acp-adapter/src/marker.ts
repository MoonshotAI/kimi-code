/**
 * Sentinel object that a tool can attach to its result to signal the ACP
 * adapter to suppress this tool's textual output.
 *
 * Motivation: Phase 7's `AcpTerminalTool` emits its output via the
 * ACP `terminal/*` reverse-RPC channel — the adapter must NOT also
 * relay the textual stdout / stderr through `tool_call_update`
 * content or the Zed UI would render the same bytes twice (one in
 * the terminal pane, one in the tool card). With the engine's
 * string-`content` contract the tool emits the marker serialized as
 * JSON (`JSON.stringify(HideOutputMarker)`) and the adapter's
 * `toolResultToAcpContent` short-circuits to `[]` whenever the
 * content matches.
 *
 * Detection is by reference equality OR by `__kind === 'acp-hide-output'`
 * on the value's shape — the latter is a defensive escape hatch in
 * case the marker travels through a structured clone (e.g. via the
 * worker_threads boundary), losing identity but preserving the field.
 * Both checks live in `isHideOutputMarker`.
 */
export const HideOutputMarker = Object.freeze({
  __kind: 'acp-hide-output' as const,
});

export type HideOutputMarker = typeof HideOutputMarker;

/**
 * Type guard: detect whether `value` is the {@link HideOutputMarker}
 * sentinel. Returns `false` for any non-object value (in particular
 * strings whose text happens to contain `'acp-hide-output'` — only
 * structural identity counts).
 */
export function isHideOutputMarker(value: unknown): value is HideOutputMarker {
  if (value === HideOutputMarker) return true;
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __kind?: unknown }).__kind === 'acp-hide-output'
  );
}
