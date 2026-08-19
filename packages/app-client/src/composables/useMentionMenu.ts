// packages/app-client/src/composables/useMentionMenu.ts
import { computed, nextTick, ref, watch, type Ref } from 'vue';
import type { FileItem } from '@moonshot-ai/app-core/client';
import type { AppSkill } from '@moonshot-ai/app-core/api';
import type { TextFieldLike } from '@moonshot-ai/app-composer';

/** One row of the mention menu: a file/folder from the daemon search, or a
 *  skill from the session's skill list. */
export type MentionItem =
  | { kind: 'file' | 'folder'; file: FileItem }
  | {
      kind: 'skill';
      skill: AppSkill;
      /** Matched-character positions into the skill NAME (drives the same
       *  row highlighting as file match_positions). One contiguous run for
       *  exact/prefix/substring hits; scattered positions for a subsequence
       *  hit (e.g. 'larkim' → 'lark-im'). */
      matchPositions?: number[];
    };

/** The payload handed to the editor for pill insertion. */
export type MentionEntry =
  | { kind: 'file' | 'folder'; path: string; name: string }
  | { kind: 'skill'; name: string };

export interface MentionMenuDeps {
  /** The live composer text — the @token is read from it and rewritten on select. */
  text: Ref<string>;
  /** The editing surface, used to read the caret and place it after insertion. */
  editorRef: Ref<TextFieldLike | null>;
  /** File search for the @-query (getter; undefined disables file rows). */
  searchFiles: () => ((q: string) => Promise<FileItem[]>) | undefined;
  /** Session skills for the @-query (getter; undefined/omitted disables
   *  skill rows — the web textarea doesn't offer skills). */
  skills?: () => AppSkill[];
  /**
   * Pill-capable insertion (the desktop ProseMirror editor). When provided,
   * selection of BOTH kinds goes through it; when absent, selection falls
   * back to replacing the @token with the plain path text (legacy textarea
   * behavior; skill items are never offered then anyway).
   */
  insertMention?: (entry: MentionEntry, range: { start: number; end: number }) => void;
}

interface MentionToken {
  token: string;
  start: number;
  end: number;
}

/** Lowercase a skill name while keeping, for every UTF-16 unit of the
 *  lowered text, the original-name unit it derives from. The lowered text is
 *  the WHOLE-STRING toLowerCase() — per-code-point lowering would miss
 *  context-sensitive mappings (the final sigma: 'ΟΣ' must fold to 'ος', not
 *  'οσ'). Case-folding can also EXPAND a character ('İ' → 'i̇'), so
 *  lowered-text indices are not original coordinates either; the map is
 *  built by walking each original character's lowered width (context-
 *  sensitive variants like σ/ς occupy the same width, so the walk stays
 *  aligned). */
function lowerWithMap(name: string): { lower: string; map: number[] } {
  const lower = name.toLowerCase();
  const map: number[] = [];
  let unit = 0;
  for (const ch of name) {
    const width = ch.toLowerCase().length;
    // An expanded character's lowered units all map to its FIRST original
    // unit — the original character is indivisible for highlighting.
    for (let i = 0; i < width; i++) map.push(unit + Math.min(i, ch.length - 1));
    unit += ch.length;
  }
  return { lower, map };
}

/** Ordered-character (fuzzy) match positions: every character of `query`
 *  appears in `name` in order, not necessarily adjacent — immune to
 *  separators, so 'larkim' matches 'lark-im'. Null when it doesn't.
 *  `for...of` iterates code points but indexOf speaks UTF-16 units, so each
 *  hit records the character's FULL UTF-16 span — a surrogate pair (emoji
 *  are legal in skill names per the wire spec) must never be split across a
 *  hit/plain boundary when mentionMatchSpans slices by these positions. */
function subsequencePositions(nameLower: string, queryLower: string): number[] | null {
  const positions: number[] = [];
  let idx = 0;
  for (const ch of queryLower) {
    const found = nameLower.indexOf(ch, idx);
    if (found < 0) return null;
    for (let unit = 0; unit < ch.length; unit++) positions.push(found + unit);
    idx = found + ch.length;
  }
  return positions;
}

/** Skill match strength against the token (both already lowercased): exact >
 *  prefix > substring > subsequence (the last only for tokens of 3+ USER
 *  characters — counted in code points, not UTF-16 units, so '🍱a' is two —
 *  because with one or two characters every name subsequence-matches, which
 *  is pure noise). 0 when the name doesn't match at all. */
function skillMatchTier(nameLower: string, tokenLower: string): 4 | 3 | 2 | 1 | 0 {
  if (nameLower === tokenLower) return 4;
  if (nameLower.startsWith(tokenLower)) return 3;
  if (nameLower.includes(tokenLower)) return 2;
  if ([...tokenLower].length >= 3 && subsequencePositions(nameLower, tokenLower) !== null) return 1;
  return 0;
}

/** Matching skills with their match tier and matched-name positions (in
 *  ORIGINAL-name UTF-16 coordinates, mapped back through lowerWithMap), in
 *  the skill list's original order — the merged ranking buckets by tier
 *  afterwards anyway. Exact/prefix/substring hits are one contiguous run; a
 *  subsequence hit carries its scattered positions. */
function rankSkills(skills: AppSkill[], token: string): Array<{ skill: AppSkill; tier: 1 | 2 | 3 | 4; positions: number[] }> {
  const q = token.toLowerCase();
  const out: Array<{ skill: AppSkill; tier: 1 | 2 | 3 | 4; positions: number[] }> = [];
  for (const skill of skills) {
    const { lower, map } = lowerWithMap(skill.name);
    const tier = skillMatchTier(lower, q);
    if (tier === 0) continue;
    const loweredPositions =
      tier >= 2
        ? Array.from({ length: q.length }, (_, i) => lower.indexOf(q) + i)
        : subsequencePositions(lower, q)!;
    out.push({ skill, tier, positions: loweredPositions.map((i) => map[i]!) });
  }
  return out;
}

/** File match strength: a substring-or-better hit on the basename is STRONG;
 *  a bare subsequence (fs:suggest's weakest tier) is WEAK. Path-mode queries
 *  (containing '/') are always strong — the user is deliberately navigating
 *  directories. Classified client-side because the two daemon endpoints'
 *  scores are not comparable (fs:search scores every subsequence ~1.0). */
function fileIsStrong(file: FileItem, tokenLower: string): boolean {
  if (tokenLower.includes('/')) return true;
  return file.name.toLowerCase().includes(tokenLower);
}

/** Folder detection: the daemon's explicit kind first, trailing slash as the
 *  fallback (the web textarea path may not carry kind). */
function fileKind(file: FileItem): 'file' | 'folder' {
  return file.kind === 'directory' || file.path.endsWith('/') ? 'folder' : 'file';
}

/**
 * `@` mention menu: token detection, immediate file search (fs:suggest is
 * rg-backed and cheap) + instant local skill filter, keyboard navigation
 * state, and insertion.
 *
 * The composer keeps the keydown orchestration (arrow keys, Enter/Tab, Escape)
 * because it also juggles the slash menu and history recall; this composable
 * owns the menu's open/items/active/loading state and the search/insert logic.
 */
export function useMentionMenu(deps: MentionMenuDeps) {
  const { text, editorRef, searchFiles, skills, insertMention } = deps;

  const open = ref(false);
  const fileItems = ref<FileItem[]>([]);
  /** The token (lowercased) that produced the CURRENT fileItems — classifies
   *  the rows' strong/weak band in the merged ranking. Tracked at apply time
   *  so stale rows keep the band of the query that produced them. */
  const fileQuery = ref('');
  /** The file rows on screen belong to an OLDER query (a search for the live
   *  token is still pending): the menu keeps them visible but dimmed instead
   *  of flashing an empty "searching" state on every keystroke. Cleared when
   *  fresh results land or the menu closes. */
  const fileStale = ref(false);
  const skillItems = ref<Array<{ skill: AppSkill; tier: 1 | 2 | 3 | 4; positions: number[] }>>([]);
  const active = ref(0);
  const loading = ref(false);

  /** Flat MERGED row list handed to the menu (and to flat-index keyboard
   *  nav) — no sections. Bands, top to bottom: exact skill > prefix skill >
   *  strong file hits (substring-or-better on the basename; path-mode '/'
   *  queries) > substring skill > subsequence skill (≥3-char tokens) > weak
   *  file hits (subsequence only). Within a band, files keep the daemon's
   *  rank and skills keep the list's order. */
  const items = computed<MentionItem[]>(() => {
    const q = fileQuery.value;
    const strongFiles: MentionItem[] = [];
    const weakFiles: MentionItem[] = [];
    for (const file of fileItems.value) {
      const item: MentionItem = { kind: fileKind(file), file };
      (fileIsStrong(file, q) ? strongFiles : weakFiles).push(item);
    }
    const exactSkills: MentionItem[] = [];
    const prefixSkills: MentionItem[] = [];
    const substringSkills: MentionItem[] = [];
    const subsequenceSkills: MentionItem[] = [];
    for (const { skill, tier, positions } of skillItems.value) {
      const item: MentionItem = { kind: 'skill', skill, matchPositions: positions };
      if (tier === 4) exactSkills.push(item);
      else if (tier === 3) prefixSkills.push(item);
      else if (tier === 2) substringSkills.push(item);
      else subsequenceSkills.push(item);
    }
    return [...exactSkills, ...prefixSkills, ...strongFiles, ...substringSkills, ...subsequenceSkills, ...weakFiles];
  });

  // Monotonic sequence for file searches: only the newest request may apply
  // results or clear the loading flag. Bumped when a search fires AND the
  // moment the query changes — a re-entered query ('@foo' → '@bar' → '@foo'
  // while the first request is still in flight) leaves an in-flight '@foo'
  // request whose token matches the live one again, and without the
  // change-time bump its stale response would pass the guard before the
  // re-search even fires.
  let searchSeq = 0;
  // The query the current file candidates were derived for. When it changes,
  // the old rows stay on screen marked STALE (dimmed, unselectable) until the
  // new RPC returns. Skills re-filter locally on every update, so they
  // refresh on their own.
  let lastToken: string | null = null;
  // Distinguishes the two open===false states on a live @token: an explicit
  // close (Escape, blur, submit, select — everything routed through close())
  // must stay closed when the async skill list arrives, while a menu still
  // waiting on its in-flight search should refresh its candidates in place.
  // Reset by update() — the next keystroke re-derives the menu from scratch.
  let dismissed = false;

  /** Find the @token under the cursor in the current text value. Returns null if none. */
  function getMentionToken(): MentionToken | null {
    const val = text.value;
    const pos = editorRef.value?.selectionStart ?? val.length;
    // Walk backwards from the cursor to find the start of a @token, but never
    // past the start of the caret's inline run: on the pill editor, a mention
    // atom ends the run, so text belonging to a serialized pill (its Markdown
    // link form has no whitespace) must not swallow the scan — otherwise a
    // '@' typed right after a pill could never open the menu.
    const lowerBound = editorRef.value?.inlineTextRunStart?.() ?? 0;
    let start = pos - 1;
    while (start >= lowerBound && !/\s/.test(val[start]!)) {
      start--;
    }
    start++;
    start = Math.max(start, lowerBound);
    const tokenPart = val.slice(start, pos);
    // Both half-width '@' and full-width '＠' (U+FF20, what Chinese IMEs
    // produce) trigger the menu; slice(1) drops either one (both are a
    // single UTF-16 unit).
    if (!tokenPart.startsWith('@') && !tokenPart.startsWith('＠')) return null;
    // The end of the token is where the cursor is (or after the next space).
    return { token: tokenPart.slice(1), start, end: pos };
  }

  /** Identity of a menu row that survives a candidate refresh: kind plus the
   *  skill name or the file path. */
  function itemKey(item: MentionItem): string {
    return item.kind === 'skill' ? `skill:${item.skill.name}` : `${item.kind}:${item.file.path}`;
  }

  // Distinguishes a highlight the USER placed (arrow keys / hover) from the
  // system default: a user-placed highlight follows its row's identity across
  // async re-rankings (a fresh file landing, a late skill list), while the
  // default simply tracks the top row of the ranking. Composer writes
  // `active` directly for arrows/hover; the sync watcher treats any unguarded
  // write as user navigation.
  let userNavigated = false;
  let activeGuard = false;
  watch(
    active,
    () => {
      if (!activeGuard) userNavigated = true;
    },
    { flush: 'sync' },
  );
  /** Every system-side write to `active` goes through here (guarded). */
  function setActive(index: number): void {
    activeGuard = true;
    active.value = index;
    activeGuard = false;
  }

  /** Mark a highlight as USER-placed and set it. The Composers route arrow
   *  keys and hover through here instead of writing `active` directly: an
   *  arrow press on a single-row menu assigns the same index (0 → 0), which
   *  never fires the watch above — so without this explicit channel the
   *  navigation intent would leave no trace, and the next async re-ranking
   *  would treat the highlight as the system default and move it. */
  function navigate(index: number): void {
    userNavigated = true;
    setActive(index);
  }

  /** Restore the highlight after a re-ranking: a user-placed highlight
   *  follows its row by identity (falling back to the top row when the row
   *  is gone); the default tracks the top row. */
  function restoreActive(key: string | null): void {
    if (key === null || !userNavigated) {
      setActive(0);
      return;
    }
    const idx = items.value.findIndex((item) => itemKey(item) === key);
    setActive(idx === -1 ? 0 : idx);
  }

  /** Replace the file candidates without losing the highlight: async results
   *  arrive while the user may have arrowed onto a row. Records the producing
   *  token for the strong/weak banding. */
  function applyFileItems(next: FileItem[], token: string): void {
    // Capture the highlighted row's identity BEFORE touching fileQuery:
    // writing it re-bands the STALE candidates under the new query, which
    // can reorder the merged list and silently retarget the numeric index.
    const current = items.value[active.value];
    const key = current ? itemKey(current) : null;
    fileStale.value = false;
    fileQuery.value = token.toLowerCase();
    fileItems.value = next;
    restoreActive(key);
  }

  /** Fire the file search and apply results while they still match the live
   *  @token AND are still the newest request (see searchSeq). Every query
   *  fires immediately — fs:suggest is rg-backed and cheap on the local
   *  daemon, so there is no debounce to pace it; superseded in-flight
   *  requests are discarded by the guards instead. */
  async function runSearch(search: (q: string) => Promise<FileItem[]>, token: string): Promise<void> {
    const seq = ++searchSeq;
    const t0 = performance.now();
    loading.value = true;
    open.value = true;
    const stillCurrent = () => {
      const live = getMentionToken();
      return seq === searchSeq && live !== null && live.token === token && open.value;
    };
    try {
      const results = await search(token);
      if (stillCurrent()) applyFileItems(results, token);
    } catch {
      if (stillCurrent()) applyFileItems([], token);
    } finally {
      if (stillCurrent()) {
        // Perf breadcrumb for debugging mention latency (devtools console,
        // verbose level) — deliberately not surfaced in the UI.
        console.debug(`[mention] search "${token}" → ${fileItems.value.length} items in ${Math.round(performance.now() - t0)}ms`);
        loading.value = false;
      }
    }
  }

  function update(): void {
    const mt = getMentionToken();
    const search = searchFiles();
    // A fresh derivation (a keystroke) re-arms the menu — only close() marks
    // it dismissed. It also re-arms the default highlight: typing is a new
    // intent, so a deliberate navigation from the previous query context no
    // longer applies (an arrow AFTER this re-derivation marks it again).
    dismissed = false;
    userNavigated = false;
    // No @token under the caret — stay closed.
    if (!mt) {
      lastToken = null;
      open.value = false;
      loading.value = false;
      fileStale.value = false;
      return;
    }
    const token = mt.token;
    // The query changed: the old file candidates no longer match, but
    // clearing them flashes an empty "searching" state on every keystroke —
    // keep them on screen, marked STALE (dimmed), until the new results
    // land. Any in-flight search is invalidated NOW (see searchSeq) instead
    // of when the next search fires.
    if (token !== lastToken) {
      if (fileItems.value.length > 0) fileStale.value = true;
      searchSeq += 1;
    }
    lastToken = token;
    // Skills filter locally and instantly — but only once the query has
    // content; a bare '@' shows files only (the full skill list is noise).
    skillItems.value = token.length > 0 ? rankSkills(skills?.() ?? [], token) : [];
    // The default highlight starts on the first row of the merged ranking —
    // whatever band that row belongs to, skill included.
    setActive(0);
    if (!search) {
      fileItems.value = [];
      loading.value = false;
      fileStale.value = false;
      open.value = skillItems.value.length > 0;
      return;
    }
    if (token.length === 0) {
      // Bare '@': open immediately with the daemon's empty-query listing
      // (workspace root entries), and Esc dismisses.
      void runSearch(search, token);
      return;
    }
    // With local skill hits the menu opens immediately; the file candidates
    // fill in as soon as the search lands (the list stays visible while
    // searching — superseded in-flight requests are discarded by the
    // searchSeq/stillCurrent guards).
    if (skillItems.value.length > 0) open.value = true;
    void runSearch(search, token);
  }

  /** Re-derive the local skill candidates for the live @token — nothing else.
   *  Unlike update() this touches no open flag and fires no search, so the
   *  skill-list watcher can run it while a file search is still in flight
   *  without reopening (or re-arming) anything. Fresh skill hits can reorder
   *  the merged list (prefix/exact skills join the top bands), so a
   *  user-placed highlight is restored by row identity — otherwise the
   *  numeric index silently retargets a different row and the next Enter
   *  inserts it. */
  function refreshSkillItems(): void {
    const mt = getMentionToken();
    if (!mt) return;
    const current = items.value[active.value];
    const key = current ? itemKey(current) : null;
    skillItems.value = mt.token.length > 0 ? rankSkills(skills?.() ?? [], mt.token) : [];
    restoreActive(key);
  }

  // The session/workspace skill list loads asynchronously. When it arrives
  // (or swaps) while a @token is live, re-derive the skill candidates so they
  // fill in without another keystroke. A dismissed menu (close()) is never
  // revived: the refresh rewrites candidates only, it never touches open.
  // This never writes the watched source — no loop.
  watch(
    () => skills?.(),
    () => {
      if (!dismissed) refreshSkillItems();
    },
  );

  function toEntry(item: MentionItem): MentionEntry {
    if (item.kind === 'skill') return { kind: 'skill', name: item.skill.name };
    const path = item.file.path;
    return { kind: fileKind(item.file), path, name: item.file.name || path.split('/').filter(Boolean).pop() || path };
  }

  /** Close the menu. Candidates, the last-token memory and every in-flight
      search are invalidated (the searchSeq bump makes their stillCurrent()
      guard fail): a workspace switch reuses this composable, and without the
      reset an identical '@query' typed in the NEW workspace would look
      unchanged (same token, no seq bump) — re-showing the OLD workspace's
      rows as fresh, selectable results, and letting the old workspace's late
      response pass the stillCurrent() guard. Marks the menu dismissed so the
      skill-list watcher leaves it alone too. */
  function close(): void {
    dismissed = true;
    userNavigated = false;
    open.value = false;
    loading.value = false;
    fileStale.value = false;
    fileItems.value = [];
    lastToken = null;
    searchSeq += 1;
  }

  function select(item: MentionItem): void {
    const mt = getMentionToken();
    if (!mt) return;
    // A stale file row belongs to an OLDER query — kept visible (dimmed) for
    // orientation only, never selectable: an Enter/Tab/click out of muscle
    // memory would otherwise insert a path unrelated to the live token.
    // Skills re-filter locally on every keystroke, so they are never stale.
    if (item.kind !== 'skill' && fileStale.value) return;
    // Route through close() so the in-flight search is invalidated too: with
    // the token about to be replaced by a pill, its late response must not
    // reopen the menu (its stillCurrent guard never passes again anyway, but
    // close() also clears loading and the candidates synchronously).
    close();
    if (insertMention) {
      insertMention(toEntry(item), { start: mt.start, end: mt.end });
      return;
    }
    // Legacy plain-text path (web textarea — no pill editor, and skills are
    // never offered there). Replace the @query token with the file path.
    if (item.kind === 'skill') return;
    const val = text.value;
    text.value = val.slice(0, mt.start) + item.file.path + val.slice(mt.end);
    void nextTick(() => {
      const el = editorRef.value;
      if (!el) return;
      const newPos = mt.start + item.file.path.length;
      el.setSelectionRange(newPos, newPos);
      el.focus();
    });
  }

  return { open, items, fileItems, fileStale, skillItems, active, loading, update, close, select, navigate };
}
