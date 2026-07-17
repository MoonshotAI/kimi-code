// apps/kimi-web/src/lib/rootKey.ts

// Windows-shaped: drive-letter (C:\, C:/) or UNC (\\host\share, //host/share).
// Shape-based detection (not any platform check): the daemon may run on
// Windows while the browser runs anywhere, and tests must fold the same way
// on every host.
const WIN_SHAPED = /^(?:[A-Za-z]:[\\/]|\\\\|\/\/)/;

/**
 * Identity key for "same workspace directory?" comparisons: slash-normalize,
 * strip trailing separators, case-fold Windows-shaped paths (NTFS lookups are
 * case-insensitive by default). Display strings are never rewritten — this is
 * for comparison only. Mirrors the server-side copies (agent-core
 * session/store/workdir-key.ts, agent-core-v2 _base/utils/workdir-slug.ts);
 * keep the three in sync. Per-directory case sensitivity / WSL paths are a
 * documented non-goal; POSIX paths never fold.
 */
export function workspaceRootKey(root: string): string {
  const normalized = root.replaceAll('\\', '/').replace(/\/+$/, '');
  return WIN_SHAPED.test(root) ? normalized.toLowerCase() : normalized;
}
