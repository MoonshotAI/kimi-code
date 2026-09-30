// Resolved experimental features. The v3 harness does not expose a flag
// registry to the TUI yet, so every flag reads as disabled; the command
// palette and dispatch consult `isExperimentalFlagEnabled` synchronously.
export function setExperimentalFeatures(
  _features: readonly { readonly id: string; readonly enabled: boolean }[],
): void {}

/** An `undefined` flag means "not gated" → always enabled, so callers can pass an optional flag id. */
export function isExperimentalFlagEnabled(flag: string | undefined): boolean {
  return flag === undefined;
}
