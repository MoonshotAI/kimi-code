// apps/kimi-web/src/composables/useDocumentTitle.ts
// Computes the base browser tab title for this instance so several Kimi Code
// Web tabs (e.g. one per dev machine) are distinguishable.
//
// Two modes:
// - Override: the server was started with `--web-title` (surfaced as
//   `web_title` in GET /meta). It wins over everything and never follows
//   workspace switches — the user gave this instance a fixed name.
// - Default: `<workspace dir basename> | Kimi Code`, following the active
//   workspace; plain `Kimi Code` until a workspace is active.
//
// This composable only COMPUTES the base title. Writing `document.title` is
// owned by `usePageTitle` (`@moonshot-ai/app-client/composables`, wired in
// App.vue), which layers the running spinner on top — a single writer avoids
// two watchers fighting over the same DOM property.

import { computed, toValue, type ComputedRef, type MaybeRefOrGetter } from 'vue';

export interface DocumentTitleOptions {
  /** Custom tab title from the server (`/meta` `web_title`); '' when unset. */
  webTitle: MaybeRefOrGetter<string>;
  /** Filesystem root of the active workspace; null when none is active. */
  activeWorkspaceRoot: MaybeRefOrGetter<string | null>;
}

/**
 * Last path segment of a workspace root, tolerant of POSIX and Windows
 * separators and trailing separators (`H:\foo\` → `foo`, `/home/x/proj` →
 * `proj`, `H:\` → `H:`).
 */
export function workspaceRootBasename(root: string): string {
  const trimmed = root.replace(/[/\\]+$/, '');
  if (trimmed === '') return root;
  return trimmed.split(/[/\\]/).pop() ?? trimmed;
}

/** Pure title rule: the non-empty `--web-title` override wins; otherwise the
 *  active workspace's basename; otherwise the bare product name. */
export function formatDocumentTitle(webTitle: string, workspaceRoot: string | null): string {
  if (webTitle !== '') return webTitle;
  if (!workspaceRoot) return 'Kimi Code';
  return `${workspaceRootBasename(workspaceRoot)} | Kimi Code`;
}

/** Reactive base tab title for this instance; consumed by `usePageTitle`. */
export function useDocumentTitle(options: DocumentTitleOptions): ComputedRef<string> {
  return computed(() =>
    formatDocumentTitle(toValue(options.webTitle), toValue(options.activeWorkspaceRoot)),
  );
}
