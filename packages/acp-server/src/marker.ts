export const HideOutputMarker = Object.freeze({
  __kind: 'acp-hide-output' as const,
});

export type HideOutputMarker = typeof HideOutputMarker;

export function isHideOutputMarker(value: unknown): value is HideOutputMarker {
  if (value === HideOutputMarker) return true;
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __kind?: unknown }).__kind === 'acp-hide-output'
  );
}
