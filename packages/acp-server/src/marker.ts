/**
 * Sentinel object that a tool can attach to its result `output` to
 * signal the ACP adapter to suppress this tool's textual output.
 *
 * Motivation: a tool that emits its output via a dedicated ACP reverse-RPC
 * channel (e.g. `terminal/*`) must NOT also relay the textual stdout / stderr
 * through `tool_call_update` content or the client UI would render the same
 * bytes twice (once in the terminal pane, once in the tool card). The tool
 * implementation sets `output: [HideOutputMarker, ...]` (array of marker plus
 * possibly textual fallback) and the adapter's `toolResultToAcpContent`
 * short-circuits to `[]` whenever the marker is present.
 *
 * Detection is by reference equality OR by `__kind === 'acp-hide-output'`
 * on the value's shape — the latter is a defensive escape hatch in
 * case the marker travels through a structured clone, losing identity but
 * preserving the field. Both checks live in `isHideOutputMarker`.
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
