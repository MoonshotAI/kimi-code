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
 * better than anything we can cheaply reproduce in TS. When `fd` is
 * missing, we only fall back to our own recursive readdir when the
 * work dir is not a git repository; inside a git repo we trust the
 * `git ls-files` snapshot to honor `.gitignore`.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

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
const READDIR_TTL_MS = 2000;
const READDIR_MAX_ENTRIES = 1000;
const READDIR_MAX_DEPTH = 8;

// Directories that are typically too large or too auto-generated to be
// useful for @-completion. Skipping them keeps the walk snappy on
// real-world repos that don't have fd or git.
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.parcel-cache',
  '.cache',
  '__pycache__',
  '.venv',
  'target',
  '.idea',
  '.vscode',
]);

/** Structurally compatible with `GitSnapshot` so existing rankers accept it. */
interface ReadDirSnapshot {
  readonly files: readonly string[];
  readonly mtimeByPath: ReadonlyMap<string, number>;
  readonly recencyOrder: ReadonlyMap<string, number>;
}

// Mirrors pi-tui's PATH_DELIMITERS. Keeping a local copy so @-detection
// stays aligned even if pi-tui extends its set.
const PATH_DELIMITERS = new Set([' ', '\t', '"', "'", '=']);

export class FileMentionProvider implements AutocompleteProvider {
  private readonly inner: CombinedAutocompleteProvider;
  private readonly readDirWalker: ReadDirWalker;

  constructor(
    slashCommands: SlashCommand[],
    workDir: string,
    private readonly fdPath: string | null,
    private readonly gitCache: GitLsFilesCache,
  ) {
    this.inner = new CombinedAutocompleteProvider(slashCommands, workDir, fdPath);
    this.readDirWalker = new ReadDirWalker(workDir);
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const textBeforeCursor = (lines[cursorLine] ?? '').slice(0, cursorCol);
    const atPrefix = extractAtPrefix(textBeforeCursor);

    // Non-`@` branch (slash commands, `/path`, quoted paths) — pi-tui
    // already owns the edge cases. No intercept.
    if (atPrefix === null) {
      return this.inner.getSuggestions(lines, cursorLine, cursorCol, options);
    }

    // `fd` available → inner's fuzzy search is strictly better than our
    // git fallback (fd respects .gitignore AND covers unstaged paths
    // without a second spawn). Accept its output as-is.
    if (this.fdPath !== null) {
      return this.inner.getSuggestions(lines, cursorLine, cursorCol, options);
    }

    if (!this.gitCache.isGitRepo()) {
      // Not in a git repo (stable for the cache's lifetime — `isGitRepo`
      // is captured at TUI startup by `git rev-parse --show-toplevel`).
      // Transient `git ls-files` failures inside a real repo leave
      // `getSnapshot()` returning null but `isGitRepo()` still true, in
      // which case we deliberately do NOT fall back to raw readdir
      // (that would bypass `.gitignore`). Inner's getFuzzyFileSuggestions
      // is a dead end without `fd`, so we own the candidate source here.
      // See issue #266.
      const readdirResult = this.buildFromReadDir(atPrefix);
      if (readdirResult !== null) {
        return { items: readdirResult, prefix: atPrefix };
      }
      return this.inner.getSuggestions(lines, cursorLine, cursorCol, options);
    }
    const snapshot = this.gitCache.getSnapshot();
    if (snapshot === null) {
      // Inside a git repo but the snapshot fetch failed transiently
      // (e.g. `git ls-files` returned non-zero, lock contention, or
      // the index mtime lookup raced). Don't consult raw readdir —
      // it would bypass `.gitignore` and could surface ignored files.
      // Fall through to the inner provider, which can still resolve
      // `/path` or quoted-path completions; on failure it returns
      // null and the editor dismisses the menu.
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
      // Git ls-files had no match for this query. Inside a git repo we
      // do NOT consult readdir — a recursive readdir would bypass
      // `git ls-files --exclude-standard` and could surface
      // .gitignored paths. Fall through to the inner provider, which
      // can still resolve `/path` or quoted-path completions.
      return this.inner.getSuggestions(lines, cursorLine, cursorCol, options);
    }
    return { items, prefix: atPrefix };
  }

  private buildFromReadDir(atPrefix: string): AutocompleteItem[] | null {
    const snapshot = this.readDirWalker.getSnapshot();
    if (snapshot === null || snapshot.files.length === 0) {
      return null;
    }
    const query = atPrefix.slice(1);
    const includeDotDirs = query.startsWith('.');
    const candidates = includeDotDirs
      ? snapshot.files
      : snapshot.files.filter((p) => !containsDotSegment(p));
    if (candidates.length === 0) {
      return null;
    }
    const ranked =
      query.length === 0
        ? rankForEmptyQuery(candidates, snapshot)
        : rankForQuery(candidates, query, snapshot);
    // An empty ranking means the walker saw files but none matched the
    // query. Returning `null` (rather than `{ items: [] }`) lets the
    // caller dismiss the autocomplete menu instead of presenting an
    // empty state.
    return ranked.length === 0 ? null : ranked;
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

/** True when any path segment starts with a dot (e.g. `.github/x.yml`). */
function containsDotSegment(path: string): boolean {
  for (const segment of path.split('/')) {
    if (segment.startsWith('.')) return true;
  }
  return false;
}

/**
 * Recursive readdir of the work dir, used as the @-completion source
 * when `fd` is missing and we're not in a git repository. Caches the
 * result for `READDIR_TTL_MS` to keep keystroke latency low. Skips
 * well-known build/dependency directories so a `node_modules`-laden
 * repo still walks in under ~50ms.
 *
 * The walker collects dot entries too (so callers can opt in via
 * `@.env` / `@.github/`); the actual dot-filtering is the caller's
 * responsibility, mirroring the git-backed path.
 */
class ReadDirWalker {
  private snapshot: ReadDirSnapshot | null = null;
  private fetchedAt = 0;

  constructor(private readonly workDir: string) {}

  getSnapshot(): ReadDirSnapshot | null {
    if (!existsSync(this.workDir)) return null;
    const now = Date.now();
    if (this.snapshot !== null && now - this.fetchedAt < READDIR_TTL_MS) {
      return this.snapshot;
    }
    const next = this.walk();
    if (next === null) return null;
    this.snapshot = next;
    this.fetchedAt = now;
    return next;
  }

  private walk(): ReadDirSnapshot | null {
    const files: string[] = [];
    const mtimeByPath = new Map<string, number>();
    try {
      this.walkDir(this.workDir, '', 0, files, mtimeByPath);
    } catch {
      return null;
    }
    files.sort();
    const capped = files.length > READDIR_MAX_ENTRIES ? files.slice(0, READDIR_MAX_ENTRIES) : files;
    return { files: capped, mtimeByPath, recencyOrder: new Map() };
  }

  private walkDir(
    absDir: string,
    relDir: string,
    depth: number,
    files: string[],
    mtimeByPath: Map<string, number>,
  ): void {
    if (depth > READDIR_MAX_DEPTH) return;
    if (files.length >= READDIR_MAX_ENTRIES) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    // Walk visible (non-dot) entries before hidden ones so a hidden
    // subtree like `.config/` cannot exhaust READDIR_MAX_ENTRIES with
    // hidden paths and push a visible file out of the snapshot. Within
    // the same visibility bucket, files come before directories so a
    // single large subdirectory cannot fill the cap and leave sibling
    // files in the same parent unmentioned. Hidden paths are still
    // collected — they fill any remaining capacity, so the opt-in
    // `@.env` / `@.github/` queries still work.
    const ordered = entries.toSorted((a, b) => {
      // Hidden (dot-prefixed) entries sort after visible ones.
      const aHidden = a.name.startsWith('.') ? 1 : 0;
      const bHidden = b.name.startsWith('.') ? 1 : 0;
      if (aHidden !== bHidden) return aHidden - bHidden;
      // Within the same visibility bucket, files sort before
      // directories so the current directory's files are captured
      // before the cap fills inside a sibling subdirectory.
      const aDir = a.isDirectory() ? 1 : 0;
      const bDir = b.isDirectory() ? 1 : 0;
      return aDir - bDir;
    });
    for (const entry of ordered) {
      // Short-circuit the loop once the cap is reached. The top-of-
      // function check guards the recursion entry; this one stops the
      // per-entry iteration so a single large directory doesn't
      // statSync every remaining file after the cap is filled.
      if (files.length >= READDIR_MAX_ENTRIES) break;
      if (entry.name === '.' || entry.name === '..') continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const absChild = join(absDir, entry.name);
        const relChild = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
        this.walkDir(absChild, relChild, depth + 1, files, mtimeByPath);
      } else if (entry.isFile()) {
        const absPath = join(absDir, entry.name);
        const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
        try {
          const stat = statSync(absPath);
          files.push(relPath);
          mtimeByPath.set(relPath, stat.mtimeMs);
        } catch {
          // File disappeared between readdir and stat — skip it.
        }
      }
    }
  }
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
