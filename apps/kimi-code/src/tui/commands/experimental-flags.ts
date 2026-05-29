import type { ExperimentalFlagMap } from '@moonshot-ai/kimi-code-sdk';

// Resolved experimental flags, fetched once from the core over RPC at startup and then read
// synchronously by the command palette and dispatch. App-local cache, not a source of truth.
let snapshot: ExperimentalFlagMap = {};

/** Replace the cached flag snapshot. Call once after fetching via `harness.getExperimentalFlags()`. */
export function setExperimentalFlags(flags: ExperimentalFlagMap): void {
  snapshot = flags;
}

/** An `undefined` flag means "not gated" → always enabled, so callers can pass an optional flag id. */
export function isExperimentalFlagEnabled(flag: string | undefined): boolean {
  return flag === undefined || snapshot[flag] === true;
}
