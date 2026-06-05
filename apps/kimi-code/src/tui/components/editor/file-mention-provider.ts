/**
 * `@file` autocomplete provider for the input box.
 *
 * pi-tui's `CombinedAutocompleteProvider` handles the mechanical parts
 * (extract `@…` prefix, insert completion with the right quoting). This
 * wrapper adds kimi-specific ranking + filtering so the default "empty
 * `@`" list surfaces files the user actually wants, not alphabetical
 * noise from `.agents/skills/*` et al.
 *
 * Sort order — empty query:
 *   1. recently edited (from `git log --name-only`)
 *   2. recent fs mtime
 *   3. basename alphabetical
 *   (first 15, not 50 — pi-tui's menu height is ~6-10 lines anyway)
 *
 * Sort order — non-empty query (strict to fuzzy):
 *   cat 0: basename starts-with query
 *   cat 1: basename contains query
 *   cat 2: fuzzyMatch succeeds on full path
 *   tie-break within each cat: recency rank → mtime → basename length
 *   (first 50)
 *
 * Filter — dot directories are hidden by default. User can opt in by starting the query
 * with `.` (e.g. `@.github/`), since those paths rarely need
 * completion.
 *
 * When `fd` is available the inner pi-tui provider owns the `@` branch
 * verbatim — its fd invocation respects `.gitignore` and is strictly
 * better than anything we can cheaply reproduce in TS. We only kick in
 * when `fd` is missing AND we're in a git repo.
 */

import { basename } from 'node:path';

import {
  CombinedAutocompleteProvider,
  fuzzyFilter,
  fuzzyMatch,
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  type SlashCommand,
} from '@earendil-works/pi-tui';

import type { GitLsFilesCache, GitSnapshot } from '#/utils/git/git-ls-files';

const MAX_SUGGESTIONS_WHEN_QUERY = 50;
const MAX_SUGGESTIONS_WHEN_EMPTY = 15;

// Mirrors pi-tui's PATH_DELIMITERS. Keeping a local copy so @-detection
// stays aligned even if pi-tui extends its set.
const PATH_DELIMITERS = new Set([' ', '\t', '"', "'", '=']);

export class FileMentionProvider implements AutocompleteProvider {
  private readonly inner: CombinedAutocompleteProvider;

  constructor(
    slashCommands: SlashCommand[],
    workDir: string,
    private readonly fdPath: string | null,
    private readonly gitCache: GitLsFilesCache,
  ) {
    this.inner = new CombinedAutocompleteProvider(slashCommands, workDir, fdPath);
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const currentLine = lines[cursorLine] ?? '';
    const textBeforeCursor = currentLine.slice(0, cursorCol);
    const atPrefix = extractAtPrefix(textBeforeCursor);

    // Non-`@` branch (slash commands, `/path`, quoted paths) — pi-tui
    // already owns the edge cases. We only suppress slash-argument
    // completions when accepting one would insert before existing text.
    if (atPrefix === null) {
      if (
        shouldSuppressSlashArgumentCompletion(
          textBeforeCursor,
          currentLine.slice(cursorCol),
          options.force,
        )
      ) {
        return null;
      }
      return this.inner.getSuggestions(lines, cursorLine, cursorCol, options);
    }

    // `fd` available → inner's fuzzy search is strictly better than our
    // git fallback (fd respects .gitignore AND covers unstaged paths
    // without a second spawn). Accept its output as-is.
    if (this.fdPath !== null) {
      return this.inner.getSuggestions(lines, cursorLine, cursorCol, options);
    }

    const snapshot = this.gitCache.getSnapshot();
    if (snapshot === null || snapshot.files.length === 0) {
      return this.inner.getSuggestions(lines, cursorLine, cursorCol, options);
    }

    const query = atPrefix.slice(1); // strip leading '@'
    const includeDotDirs = query.startsWith('.');
    const candidates = includeDotDirs
      ? snapshot.files
      : snapshot.files.filter((p) => !containsDotSegment(p));

    const items =
      query.length === 0
        ? rankForEmptyQuery(candidates, snapshot)
        : rankForQuery(candidates, query, snapshot);

    if (items.length === 0) {
      // Git cache had nothing useful — fall through to readdir (user
      // may be typing a path that exists but isn't tracked, e.g. a
      // freshly created file not yet in the 2s cache).
      return this.inner.getSuggestions(lines, cursorLine, cursorCol, options);
    }
    return { items, prefix: atPrefix };
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    // Reuse pi-tui's insertion logic — it handles `@` prefix, quoted
    // paths, directory trailing slash. Our item shape matches what
    // pi-tui produces.
    return this.inner.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
  }
}

/**
 * Return the `@…` token ending at the cursor, or `null` if we're not in
 * an `@` mention. Mirrors pi-tui's `extractAtPrefix` — the token
 * boundary is the last PATH_DELIMITER before the cursor, and the token
 * must start with `@`.
 */
function extractAtPrefix(text: string): string | null {
  let tokenStart = 0;
  for (let i = text.length - 1; i >= 0; i -= 1) {
    if (PATH_DELIMITERS.has(text[i] ?? '')) {
      tokenStart = i + 1;
      break;
    }
  }
  if (text[tokenStart] !== '@') return null;
  return text.slice(tokenStart);
}

function shouldSuppressSlashArgumentCompletion(
  textBeforeCursor: string,
  textAfterCursor: string,
  force: boolean | undefined,
): boolean {
  if (force === true) return false;
  if (!textBeforeCursor.startsWith('/')) return false;
  if (!textBeforeCursor.includes(' ')) return false;
  return textAfterCursor.trimStart().length > 0;
}

/** True when any path segment starts with a dot (e.g. `.github/x.yml`). */
function containsDotSegment(path: string): boolean {
  for (const segment of path.split('/')) {
    if (segment.startsWith('.')) return true;
  }
  return false;
}

/**
 * Empty-query ranking: stratified by signal strength.
 *
 * Layer 1: files touched in the last RECENT_COMMIT_DEPTH commits,
 *          ordered by how recently. Strongest signal — if the user
 *          just worked on it, they probably want to mention it.
 * Layer 2: files with the newest fs mtime (covers uncommitted edits
 *          and files edited but not yet added to git).
 * Layer 3: everything else, alphabetical by basename so
 *          README/package.json-style top-level files bubble up
 *          relative to deeply-nested alphabetical paths.
 *
 * Cap at MAX_SUGGESTIONS_WHEN_EMPTY. Layers fill in order; dedup by
 * path so a recently-edited file isn't also listed in layer 2.
 */
function rankForEmptyQuery(files: readonly string[], snapshot: GitSnapshot): AutocompleteItem[] {
  const picked = new Set<string>();
  const result: string[] = [];
  const cap = MAX_SUGGESTIONS_WHEN_EMPTY;
  const inFiles = new Set(files);

  // Layer 1 — git log recency.
  const byRecency = [...snapshot.recencyOrder.entries()]
    .filter(([path]) => inFiles.has(path))
    .toSorted((a, b) => a[1] - b[1]);
  for (const [path] of byRecency) {
    if (result.length >= cap) break;
    if (picked.has(path)) continue;
    picked.add(path);
    result.push(path);
  }

  // Layer 2 — fs mtime.
  if (result.length < cap) {
    const byMtime = files
      .filter((p) => !picked.has(p) && snapshot.mtimeByPath.has(p))
      .toSorted((a, b) => (snapshot.mtimeByPath.get(b) ?? 0) - (snapshot.mtimeByPath.get(a) ?? 0));
    for (const path of byMtime) {
      if (result.length >= cap) break;
      picked.add(path);
      result.push(path);
    }
  }

  // Layer 3 — alphabetical by basename.
  if (result.length < cap) {
    const rest = files
      .filter((p) => !picked.has(p))
      .toSorted((a, b) => basename(a).localeCompare(basename(b)) || a.localeCompare(b));
    for (const path of rest) {
      if (result.length >= cap) break;
      result.push(path);
    }
  }

  return result.map(toItem);
}

/**
 * Non-empty-query ranking: three strictness tiers, with recency /
 * mtime as tie-breakers inside each tier so "the readme you just
 * edited" beats "a readme deep in a vendor dir".
 */
function rankForQuery(
  files: readonly string[],
  query: string,
  snapshot: GitSnapshot,
): AutocompleteItem[] {
  const lowerQuery = query.toLowerCase();
  const scored: Array<{ path: string; cat: number; fuzzyScore: number }> = [];
  for (const path of files) {
    const base = basename(path).toLowerCase();
    if (base.startsWith(lowerQuery)) {
      scored.push({ path, cat: 0, fuzzyScore: 0 });
      continue;
    }
    if (base.includes(lowerQuery)) {
      scored.push({ path, cat: 1, fuzzyScore: 0 });
      continue;
    }
    const fuzzy = fuzzyMatch(query, path);
    if (fuzzy.matches) {
      scored.push({ path, cat: 2, fuzzyScore: fuzzy.score });
    }
  }

  if (scored.length === 0) {
    // pi-tui's fuzzyFilter is slightly different (token-splitting);
    // try it as a last-resort safety net.
    return fuzzyFilter([...files], query, (p) => p)
      .slice(0, MAX_SUGGESTIONS_WHEN_QUERY)
      .map(toItem);
  }

  scored.sort((a, b) => {
    if (a.cat !== b.cat) return a.cat - b.cat;
    if (a.cat === 2 && a.fuzzyScore !== b.fuzzyScore) return a.fuzzyScore - b.fuzzyScore;
    const ra = snapshot.recencyOrder.get(a.path);
    const rb = snapshot.recencyOrder.get(b.path);
    if (ra !== undefined && rb !== undefined && ra !== rb) return ra - rb;
    if (ra !== undefined && rb === undefined) return -1;
    if (ra === undefined && rb !== undefined) return 1;
    const ma = snapshot.mtimeByPath.get(a.path) ?? 0;
    const mb = snapshot.mtimeByPath.get(b.path) ?? 0;
    if (ma !== mb) return mb - ma;
    const baseLenDiff = basename(a.path).length - basename(b.path).length;
    if (baseLenDiff !== 0) return baseLenDiff;
    return a.path.localeCompare(b.path);
  });

  return scored.slice(0, MAX_SUGGESTIONS_WHEN_QUERY).map((entry) => toItem(entry.path));
}

function toItem(path: string): AutocompleteItem {
  return {
    value: `@${path}`,
    label: basename(path),
    description: path,
  };
}
