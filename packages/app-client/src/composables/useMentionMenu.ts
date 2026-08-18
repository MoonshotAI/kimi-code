// packages/app-client/src/composables/useMentionMenu.ts
import { computed, nextTick, ref, watch, type Ref } from 'vue';
import type { FileItem } from '@moonshot-ai/app-core/client';
import type { AppSkill } from '@moonshot-ai/app-core/api';
import type { TextFieldLike } from '@moonshot-ai/app-composer';

/** One row of the mention menu: a file/folder from the daemon search, or a
 *  skill from the session's skill list. */
export type MentionItem =
  | { kind: 'file' | 'folder'; file: FileItem }
  | { kind: 'skill'; skill: AppSkill };

/** The payload handed to the editor for pill insertion. */
export type MentionEntry =
  | { kind: 'file' | 'folder'; path: string; name: string }
  | { kind: 'skill'; name: string };

export interface MentionMenuDeps {
  /** The live composer text — the @token is read from it and rewritten on select. */
  text: Ref<string>;
  /** The editing surface, used to read the caret and place it after insertion. */
  editorRef: Ref<TextFieldLike | null>;
  /** File search for the @-query (getter; undefined disables the file section). */
  searchFiles: () => ((q: string) => Promise<FileItem[]>) | undefined;
  /** Session skills for the @-query (getter; undefined/omitted disables the
   *  skill section — the web textarea doesn't offer skills). */
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

/** Case-insensitive name match: prefix hits first, then substring hits. */
function filterSkills(skills: AppSkill[], token: string): AppSkill[] {
  const q = token.toLowerCase();
  const prefix: AppSkill[] = [];
  const substring: AppSkill[] = [];
  for (const skill of skills) {
    const name = skill.name.toLowerCase();
    if (name.startsWith(q)) prefix.push(skill);
    else if (name.includes(q)) substring.push(skill);
  }
  return [...prefix, ...substring];
}

/** Folder detection: the daemon's explicit kind first, trailing slash as the
 *  fallback (the web textarea path may not carry kind). */
function fileKind(file: FileItem): 'file' | 'folder' {
  return file.kind === 'directory' || file.path.endsWith('/') ? 'folder' : 'file';
}

/**
 * `@` mention menu: token detection, debounced file search + instant local
 * skill filter, keyboard navigation state, and insertion.
 *
 * The composer keeps the keydown orchestration (arrow keys, Enter/Tab, Escape)
 * because it also juggles the slash menu and history recall; this composable
 * owns the menu's open/items/active/loading state and the search/insert logic.
 */
export function useMentionMenu(deps: MentionMenuDeps) {
  const { text, editorRef, searchFiles, skills, insertMention } = deps;

  const open = ref(false);
  const fileItems = ref<FileItem[]>([]);
  /** The file rows on screen belong to an OLDER query (a search for the live
   *  token is still pending): the menu keeps them visible but dimmed instead
   *  of flashing an empty "searching" state on every keystroke. Cleared when
   *  fresh results land or the menu closes. */
  const fileStale = ref(false);
  const skillItems = ref<AppSkill[]>([]);
  const active = ref(0);
  const loading = ref(false);

  /** Flat row list handed to the menu (and to flat-index keyboard nav):
   *  files/folders first, skills trailing. */
  const items = computed<MentionItem[]>(() => [
    ...fileItems.value.map((file) => ({ kind: fileKind(file), file })),
    ...skillItems.value.map((skill) => ({ kind: 'skill' as const, skill })),
  ]);

  // Debounce timer for the file search.
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Monotonic sequence for file searches: only the newest request may apply
  // results or clear the loading flag. Bumped when a search fires AND the
  // moment the query changes — a re-entered query ('@foo' → '@bar' → '@foo'
  // inside the debounce window) leaves an in-flight '@foo' request whose
  // token matches the live one again, and without the change-time bump its
  // stale response would pass the guard before the re-search even fires.
  let searchSeq = 0;
  // The query the current candidates were derived for. When it changes, the
  // file section is dropped immediately instead of staying visible (and
  // clickable) until the new RPC returns. Skills re-filter locally on every
  // update, so they refresh on their own.
  let lastToken: string | null = null;
  // Distinguishes the two open===false states on a live @token: an explicit
  // close (Escape, blur, submit, select — everything routed through close())
  // must stay closed when the async skill list arrives, while a menu still
  // waiting on its debounced search should refresh its candidates in place.
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

  /** Identity of a menu row that survives a file-section refresh: kind plus
   *  the skill name or the file path. */
  function itemKey(item: MentionItem): string {
    return item.kind === 'skill' ? `skill:${item.skill.name}` : `${item.kind}:${item.file.path}`;
  }

  // Distinguishes a highlight the USER placed (arrow keys / hover) from one
  // the system defaulted: a default highlight that lands on a skill only
  // because the file section is empty or stale is not a choice, and a fresh
  // file landing reclaims it — but a deliberately navigated row follows its
  // identity across a landing. Composer writes `active` directly for
  // arrows/hover; the sync watcher treats any unguarded write as navigation.
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

  /** Replace the file candidates without losing the highlight. Async results
   *  arrive while the user may have arrowed onto a row — restore the active
   *  row by identity. The one exception: a NON-deliberate highlight sitting
   *  on a skill (the file section was empty or stale when it landed there —
   *  skills never earn the default over real file hits), which a non-empty
   *  landing resets to the first fresh file row. */
  function applyFileItems(next: FileItem[]): void {
    fileStale.value = false;
    const current = items.value[active.value];
    const key = current ? itemKey(current) : null;
    fileItems.value = next;
    if (!userNavigated && next.length > 0 && current?.kind === 'skill') {
      setActive(0);
      return;
    }
    if (key === null) {
      setActive(0);
      return;
    }
    const idx = items.value.findIndex((item) => itemKey(item) === key);
    setActive(idx === -1 ? 0 : idx);
  }

  /** Fire the file search and apply results while they still match the live
   *  @token AND are still the newest request (see searchSeq). Shared by the
   *  debounced path and the immediate bare-@ path. */
  async function runSearch(search: (q: string) => Promise<FileItem[]>, token: string): Promise<void> {
    const seq = ++searchSeq;
    loading.value = true;
    open.value = true;
    const stillCurrent = () => {
      const live = getMentionToken();
      return seq === searchSeq && live !== null && live.token === token && open.value;
    };
    try {
      const results = await search(token);
      if (stillCurrent()) applyFileItems(results);
    } catch {
      if (stillCurrent()) applyFileItems([]);
    } finally {
      if (stillCurrent()) loading.value = false;
    }
  }

  function update(): void {
    const mt = getMentionToken();
    const search = searchFiles();
    if (timer !== null) clearTimeout(timer);
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
    skillItems.value = token.length > 0 ? filterSkills(skills?.() ?? [], token) : [];
    // The default highlight ALWAYS starts on the first row — never
    // auto-moved onto a skill. Auto-borrowing the highlight for skills
    // during the stale window made the FIRST Enter target a skill the user
    // never aimed at ('@a' → changeset), and the borrow stuck after fresh
    // results landed. A brief dead Enter on a dimmed stale row is the
    // smaller evil; the user can arrow onto a skill manually at any time.
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
      // (workspace root entries) — no debounce, and Esc dismisses.
      void runSearch(search, token);
      return;
    }
    // With local skill hits the menu opens immediately; the file section
    // fills in after the debounce (the list stays visible while searching).
    if (skillItems.value.length > 0) open.value = true;
    timer = setTimeout(() => {
      timer = null;
      // Fire only when the @token this debounce was scheduled for is still
      // live — a close that ran without clearing the timer (or a token
      // rewrite in the meantime) must not let the search reopen the menu.
      const live = getMentionToken();
      if (!live || live.token !== token) return;
      void runSearch(search, token);
    }, 200);
  }

  /** Re-derive the local skill candidates for the live @token — nothing else.
   *  Unlike update() this touches no timers, no open flag and no highlight,
   *  so the skill-list watcher can run it while a debounced file search is
   *  still pending without reopening (or re-arming) anything. */
  function refreshSkillItems(): void {
    const mt = getMentionToken();
    if (!mt) return;
    skillItems.value = mt.token.length > 0 ? filterSkills(skills?.() ?? [], mt.token) : [];
    // Keep the highlight on a real row if the refreshed list shrank.
    if (active.value >= items.value.length) setActive(0);
  }

  // The session/workspace skill list loads asynchronously. When it arrives
  // (or swaps) while a @token is live, re-derive the skill section so it
  // fills in without another keystroke — both when the menu is already open
  // AND while its file search is still debouncing (open is false in that
  // window, so gating on open skipped the refresh and the skills stayed
  // missing until the next input). A dismissed menu (close()) is never
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

  /** Close the menu and cancel any pending debounced search. Without the
      cancel, a timer started just before the close (blur, session switch,
      submit, Escape) would fire afterwards and reopen the menu. Candidates,
      the last-token memory and every in-flight search are invalidated too:
      a workspace switch reuses this composable, and without the reset an
      identical '@query' typed in the NEW workspace would look unchanged
      (same token, no seq bump) — re-showing the OLD workspace's rows as
      fresh, selectable results, and letting the old workspace's late
      response pass the stillCurrent() guard. Marks the menu dismissed so
      the skill-list watcher leaves it alone too. */
  function close(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
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
    // Route through close() so a pending debounced search is cancelled too:
    // with the token about to be replaced by a pill, a timer fired afterwards
    // would reopen the menu and latch loading on (its stillCurrent guard
    // never passes again).
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

  return { open, items, fileItems, fileStale, skillItems, active, loading, update, close, select };
}
