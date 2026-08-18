import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref, unref, type Ref } from 'vue';
import { useMentionMenu, type MentionEntry } from '../src/composables';
import type { FileItem } from '@moonshot-ai/app-core/client';
import type { AppSkill } from '@moonshot-ai/app-core/api';
import type { TextFieldLike } from '@moonshot-ai/app-composer';

interface MockEditor {
  value: string;
  selectionStart: number;
  setSelectionRange: (start: number, end: number) => void;
  focus: () => void;
}

interface SetupOptions {
  /** A ref simulates the session skill list arriving asynchronously. */
  skills?: AppSkill[] | Ref<AppSkill[]>;
  insertMention?: (entry: MentionEntry, range: { start: number; end: number }) => void;
  /** Simulates the PM editor's inline-run lower bound for the token scan. */
  runStart?: number;
}

function setup(initialText = '', searchFiles?: (q: string) => Promise<FileItem[]>, options: SetupOptions = {}) {
  const editor: MockEditor & { inlineTextRunStart?: () => number | null } = {
    value: initialText,
    // Caret defaults to the end of the text.
    selectionStart: initialText.length,
    setSelectionRange(start: number) {
      this.selectionStart = start;
    },
    focus: () => {},
  };
  if (options.runStart !== undefined) editor.inlineTextRunStart = () => options.runStart!;
  const text = ref(initialText);
  const editorRef = ref(editor as unknown as TextFieldLike) as Ref<TextFieldLike | null>;
  const mention = useMentionMenu({
    text,
    editorRef,
    searchFiles: () => searchFiles,
    skills: options.skills ? () => unref(options.skills!) : undefined,
    insertMention: options.insertMention,
  });
  return { text, editor, mention };
}

describe('useMentionMenu — update', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays closed when there is no @token', async () => {
    const searchFiles = vi.fn().mockResolvedValue([]);
    const { mention } = setup('hello', searchFiles);
    mention.update();
    await vi.advanceTimersByTimeAsync(200);
    expect(mention.open.value).toBe(false);
    expect(searchFiles).not.toHaveBeenCalled();
  });

  it('stays closed when searchFiles is not provided', async () => {
    const { mention } = setup('@a');
    mention.update();
    await vi.advanceTimersByTimeAsync(200);
    expect(mention.open.value).toBe(false);
  });

  it('opens immediately with a bare @ and searches the empty query (no debounce)', async () => {
    const searchFiles = vi.fn().mockResolvedValue([{ path: 'README.md', name: 'README.md' }]);
    const { mention } = setup('@', searchFiles);
    mention.update();
    // Immediate — no debounce wait — with the daemon's empty-query listing.
    expect(searchFiles).toHaveBeenCalledWith('');
    await vi.advanceTimersByTimeAsync(0);
    expect(mention.open.value).toBe(true);
    expect(mention.fileItems.value).toEqual([{ path: 'README.md', name: 'README.md' }]);
    expect(mention.loading.value).toBe(false);
    // No skills on a bare @ (the full list would be noise).
    expect(mention.skillItems.value).toEqual([]);
  });

  it('re-searches with the empty query when the query is deleted back to a bare @', async () => {
    const searchFiles = vi.fn().mockResolvedValue([{ path: 'src/a.ts', name: 'a.ts' }]);
    const { text, editor, mention } = setup('@a', searchFiles);
    mention.update();
    // Backspace the 'a' before the debounce fires — the bare-@ listing
    // replaces the pending query search immediately.
    text.value = '@';
    editor.value = '@';
    editor.selectionStart = 1;
    mention.update();
    await vi.advanceTimersByTimeAsync(500);
    expect(searchFiles).toHaveBeenCalledTimes(1);
    expect(searchFiles).toHaveBeenCalledWith('');
    expect(mention.open.value).toBe(true);
  });

  it('stays closed when the @token is deleted before the debounce fires', async () => {
    const searchFiles = vi.fn().mockResolvedValue([{ path: 'src/a.ts', name: 'a.ts' }]);
    const { text, editor, mention } = setup('@a', searchFiles);
    mention.update();
    // Delete the whole token before the debounce fires.
    text.value = '';
    editor.value = '';
    editor.selectionStart = 0;
    mention.update();
    await vi.advanceTimersByTimeAsync(500);
    expect(searchFiles).not.toHaveBeenCalled();
    expect(mention.open.value).toBe(false);
  });

  it('ignores in-flight results that resolve after backspacing to a bare @', async () => {
    const resolvers: Array<(items: FileItem[]) => void> = [];
    const searchFiles = vi.fn().mockImplementation(
      () => new Promise<FileItem[]>((resolve) => { resolvers.push(resolve); }),
    );
    const { text, editor, mention } = setup('@a', searchFiles);
    mention.update();
    await vi.advanceTimersByTimeAsync(200); // debounced search('a') fires
    expect(searchFiles).toHaveBeenCalledWith('a');
    // Backspace to a bare @ while the 'a' search is in flight — this fires an
    // immediate empty-query search.
    text.value = '@';
    editor.value = '@';
    editor.selectionStart = 1;
    mention.update();
    expect(searchFiles).toHaveBeenCalledWith('');
    // The stale 'a' response must not populate the menu…
    resolvers[0]!([{ path: 'src/a.ts', name: 'a.ts' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mention.fileItems.value).toEqual([]);
    // …and the empty-query response lands when it resolves.
    resolvers[1]!([{ path: 'README.md', name: 'README.md' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mention.open.value).toBe(true);
    expect(mention.fileItems.value).toEqual([{ path: 'README.md', name: 'README.md' }]);
    expect(mention.loading.value).toBe(false);
  });

  it('opens with search results after the debounce', async () => {
    const searchFiles = vi.fn().mockResolvedValue([{ path: 'src/a.ts', name: 'a.ts' }]);
    const { mention } = setup('@a', searchFiles);
    mention.update();
    expect(mention.open.value).toBe(false); // debounced, not yet
    await vi.advanceTimersByTimeAsync(200);
    expect(searchFiles).toHaveBeenCalledWith('a');
    expect(mention.open.value).toBe(true);
    expect(mention.fileItems.value).toEqual([{ path: 'src/a.ts', name: 'a.ts' }]);
    expect(mention.loading.value).toBe(false);
    expect(mention.active.value).toBe(0);
  });

  it('clears items and stops loading when the search throws', async () => {
    const searchFiles = vi.fn().mockRejectedValue(new Error('boom'));
    const { mention } = setup('@a', searchFiles);
    mention.update();
    await vi.advanceTimersByTimeAsync(200);
    expect(mention.fileItems.value).toEqual([]);
    expect(mention.loading.value).toBe(false);
  });

  it('keeps old file candidates visible but stale-marked while the new search is pending', async () => {
    const searchFiles = vi.fn().mockImplementation((q: string) =>
      Promise.resolve(q === 'a' ? [{ path: 'src/a.ts', name: 'a.ts' }] : [{ path: 'src/b.ts', name: 'b.ts' }]),
    );
    const { text, editor, mention } = setup('@a', searchFiles, {
      skills: [{ name: 'goal', description: '', path: '/s/goal/SKILL.md', source: 'builtin' }],
    });
    mention.update();
    await vi.advanceTimersByTimeAsync(200);
    expect(mention.fileItems.value).toEqual([{ path: 'src/a.ts', name: 'a.ts' }]);
    expect(mention.fileStale.value).toBe(false);
    // Retype the query — the old candidates STAY on screen, marked stale
    // (dimmed), instead of flashing an empty "searching" state on every
    // keystroke; the menu never collapses. The default highlight stays on the
    // first row (a dimmed, briefly-unselectable stale file) — it never jumps
    // to a skill automatically, no matter how fresh the skill rows are.
    text.value = '@goal';
    editor.value = '@goal';
    editor.selectionStart = 5;
    mention.update();
    expect(mention.fileItems.value).toEqual([{ path: 'src/a.ts', name: 'a.ts' }]);
    expect(mention.fileStale.value).toBe(true);
    expect(mention.skillItems.value.map((s) => s.name)).toEqual(['goal']);
    expect(mention.active.value).toBe(0); // first row, never auto-borrowed to a skill
    await vi.advanceTimersByTimeAsync(200);
    expect(mention.fileItems.value).toEqual([{ path: 'src/b.ts', name: 'b.ts' }]);
    expect(mention.fileStale.value).toBe(false);
    // …and the landing hands the first fresh file row the highlight.
    expect(mention.active.value).toBe(0);
  });

  it('rejects selecting a stale file row (skills stay selectable)', async () => {
    const calls: unknown[] = [];
    const searchFiles = vi.fn().mockImplementation(
      () => new Promise<FileItem[]>(() => {}), // never resolves — stays stale
    );
    const { text, editor, mention } = setup('@a', searchFiles, {
      skills: [{ name: 'goal', description: '', path: '/s/goal/SKILL.md', source: 'builtin' }],
      insertMention: (entry) => calls.push(entry),
    });
    // Seed fresh results for '@a' via a resolvable search, then retype.
    mention.update();
    await vi.advanceTimersByTimeAsync(200);
    searchFiles.mockImplementation((q: string) =>
      Promise.resolve(q === 'a' ? [{ path: 'src/a.ts', name: 'a.ts' }] : [{ path: 'src/b.ts', name: 'b.ts' }]),
    );
    text.value = '@a';
    editor.value = '@a';
    editor.selectionStart = 2;
    mention.update();
    await vi.advanceTimersByTimeAsync(200);
    expect(mention.fileItems.value).toEqual([{ path: 'src/a.ts', name: 'a.ts' }]);
    // Retype '@g': file rows are now stale; skills re-filter instantly.
    text.value = '@g';
    editor.value = '@g';
    editor.selectionStart = 2;
    mention.update();
    expect(mention.fileStale.value).toBe(true);
    mention.select({ kind: 'file', file: { path: 'src/a.ts', name: 'a.ts' } });
    expect(calls).toEqual([]);
    expect(mention.open.value).toBe(true); // rejected — menu NOT closed
    mention.select({ kind: 'skill', skill: { name: 'goal', description: '', path: '/s/goal/SKILL.md', source: 'builtin' } });
    expect(calls).toEqual([{ kind: 'skill', name: 'goal' }]);
  });

  it('applies only the newest search when the same query is re-entered', async () => {
    const resolvers: Array<(items: FileItem[]) => void> = [];
    const searchFiles = vi.fn().mockImplementation(
      () => new Promise<FileItem[]>((resolve) => { resolvers.push(resolve); }),
    );
    const { text, editor, mention } = setup('@foo', searchFiles);
    mention.update();
    await vi.advanceTimersByTimeAsync(200); // search A ('foo') in flight
    // '@foo' → '@bar' → '@foo': searches B and C fire.
    text.value = '@bar';
    editor.value = '@bar';
    editor.selectionStart = 4;
    mention.update();
    await vi.advanceTimersByTimeAsync(200);
    text.value = '@foo';
    editor.value = '@foo';
    editor.selectionStart = 4;
    mention.update();
    await vi.advanceTimersByTimeAsync(200);
    expect(searchFiles.mock.calls.map((call) => call[0])).toEqual(['foo', 'bar', 'foo']);
    // The stale 'bar' response must neither apply nor clear the loading flag…
    resolvers[1]!([{ path: 'src/bar.ts', name: 'bar.ts' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mention.fileItems.value).toEqual([]);
    expect(mention.loading.value).toBe(true);
    // …and neither must the older 'foo' response (same live token, but not
    // the newest request)…
    resolvers[0]!([{ path: 'src/stale.ts', name: 'stale.ts' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mention.fileItems.value).toEqual([]);
    expect(mention.loading.value).toBe(true);
    // …while the newest 'foo' response lands.
    resolvers[2]!([{ path: 'src/fresh.ts', name: 'fresh.ts' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mention.fileItems.value).toEqual([{ path: 'src/fresh.ts', name: 'fresh.ts' }]);
    expect(mention.loading.value).toBe(false);
  });

  it('discards an in-flight response when the query round-trips inside the debounce window', async () => {
    const resolvers: Array<(items: FileItem[]) => void> = [];
    const searchFiles = vi.fn().mockImplementation(
      () => new Promise<FileItem[]>((resolve) => { resolvers.push(resolve); }),
    );
    const { text, editor, mention } = setup('@foo', searchFiles);
    mention.update();
    await vi.advanceTimersByTimeAsync(200); // search A ('foo') in flight
    expect(searchFiles).toHaveBeenCalledWith('foo');
    // '@foo' → '@bar' → '@foo' within 200ms: the re-search is still
    // debouncing when the ORIGINAL 'foo' response returns…
    text.value = '@bar';
    editor.value = '@bar';
    editor.selectionStart = 4;
    mention.update();
    text.value = '@foo';
    editor.value = '@foo';
    editor.selectionStart = 4;
    mention.update();
    resolvers[0]!([{ path: 'src/stale.ts', name: 'stale.ts' }]);
    await vi.advanceTimersByTimeAsync(0);
    // …and it must be dropped — the query change already invalidated the
    // request, so the menu shows nothing (and keeps loading) instead of
    // flashing stale candidates until the re-search lands.
    expect(mention.fileItems.value).toEqual([]);
    expect(mention.loading.value).toBe(true);
    // The debounced re-search fires and its response is the one that lands.
    await vi.advanceTimersByTimeAsync(200);
    expect(searchFiles).toHaveBeenCalledTimes(2);
    expect(searchFiles).toHaveBeenLastCalledWith('foo');
    resolvers[1]!([{ path: 'src/fresh.ts', name: 'fresh.ts' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mention.fileItems.value).toEqual([{ path: 'src/fresh.ts', name: 'fresh.ts' }]);
    expect(mention.loading.value).toBe(false);
  });

  it('keeps the highlighted row when async file results shift the indices', async () => {
    const SKILLS: AppSkill[] = [
      { name: 'goal', description: 'Goal mode', path: '/skills/goal/SKILL.md', source: 'builtin' },
      { name: 'git-review', description: 'Review', path: '/skills/git-review/SKILL.md', source: 'project' },
    ];
    const searchFiles = vi.fn().mockResolvedValue([{ path: 'src/g.ts', name: 'g.ts' }]);
    const { mention } = setup('@g', searchFiles, { skills: SKILLS });
    mention.update();
    // The skills open immediately; the user arrows onto 'git-review' before
    // the file search returns.
    mention.active.value = 1;
    await vi.advanceTimersByTimeAsync(200);
    // The file section prepended ahead of the skills…
    expect(mention.items.value.map((item) => (item.kind === 'skill' ? item.skill.name : item.file.name)))
      .toEqual(['g.ts', 'goal', 'git-review']);
    // …and the highlight followed 'git-review' to its new index instead of
    // resetting to row 0 (an Enter now would insert the wrong row).
    expect(mention.active.value).toBe(2);
    const activeItem = mention.items.value[mention.active.value]!;
    expect(activeItem.kind === 'skill' && activeItem.skill.name).toBe('git-review');
  });

  it('resets the highlight to row 0 when a refreshed result set drops that row', async () => {
    const resolvers: Array<(items: FileItem[]) => void> = [];
    const searchFiles = vi.fn().mockImplementation(
      () => new Promise<FileItem[]>((resolve) => { resolvers.push(resolve); }),
    );
    const { text, editor, mention } = setup('@a', searchFiles);
    mention.update();
    await vi.advanceTimersByTimeAsync(200); // search A ('a') in flight
    resolvers[0]!([{ path: 'src/a.ts', name: 'a.ts' }, { path: 'src/ab.ts', name: 'ab.ts' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mention.fileItems.value).toHaveLength(2);
    mention.active.value = 1; // highlight 'ab.ts'
    // Re-enter the query — fiddle inside the debounce window and land back on
    // 'a': the re-search returns a set WITHOUT ab.ts, so the highlight must
    // not linger on a row that no longer exists.
    text.value = '@ab';
    editor.value = '@ab';
    editor.selectionStart = 3;
    mention.update();
    text.value = '@a';
    editor.value = '@a';
    editor.selectionStart = 2;
    mention.update();
    await vi.advanceTimersByTimeAsync(200);
    expect(searchFiles).toHaveBeenCalledTimes(2);
    resolvers[1]!([{ path: 'src/a.ts', name: 'a.ts' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mention.fileItems.value).toEqual([{ path: 'src/a.ts', name: 'a.ts' }]);
    expect(mention.active.value).toBe(0);
  });
});

describe('useMentionMenu — select', () => {
  it('replaces the @token with the chosen path', async () => {
    const { text, editor, mention } = setup('hello @a');
    editor.value = 'hello @a';
    mention.select({ kind: 'file', file: { path: 'src/a.ts', name: 'a.ts' } });
    expect(text.value).toBe('hello src/a.ts');
    expect(mention.open.value).toBe(false);
    await nextTick();
  });

  it('is a no-op when there is no @token', () => {
    const { text, mention } = setup('hello');
    mention.select({ kind: 'file', file: { path: 'src/a.ts', name: 'a.ts' } });
    expect(text.value).toBe('hello');
  });
});

describe('useMentionMenu — skills section', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const SKILLS: AppSkill[] = [
    { name: 'goal', description: 'Goal mode', path: '/skills/goal/SKILL.md', source: 'builtin' },
    { name: 'git-review', description: 'Review', path: '/skills/git-review/SKILL.md', source: 'project' },
    { name: 'grammar', description: 'Grammar', path: '/skills/grammar/SKILL.md', source: 'project' },
  ];

  it('filters skills locally and opens immediately (prefix hits first)', async () => {
    const { mention } = setup('@g', undefined, { skills: SKILLS });
    mention.update();
    // No debounce for the local section — open before any timer fires.
    expect(mention.open.value).toBe(true);
    expect(mention.skillItems.value.map((s) => s.name)).toEqual(['goal', 'git-review', 'grammar']);
  });

  it('stays closed when neither skills nor file search produce anything', () => {
    const { mention } = setup('@zzz', undefined, { skills: SKILLS });
    mention.update();
    expect(mention.open.value).toBe(false);
  });

  it('keeps skills out when the skills dep is not provided (web textarea path)', async () => {
    const searchFiles = vi.fn().mockResolvedValue([]);
    const { mention } = setup('@g', searchFiles);
    mention.update();
    await vi.advanceTimersByTimeAsync(200);
    expect(mention.skillItems.value).toEqual([]);
  });

  it('re-derives the open menu when the skill list arrives late', async () => {
    const skillsRef = ref<AppSkill[]>([]);
    const searchFiles = vi.fn().mockResolvedValue([]);
    const { mention } = setup('@goal', searchFiles, { skills: skillsRef });
    mention.update();
    await vi.advanceTimersByTimeAsync(200);
    // The menu opened on the file section alone — the skill list was still
    // loading when the token was typed.
    expect(mention.open.value).toBe(true);
    expect(mention.skillItems.value).toEqual([]);
    // The session's skills arrive while the menu is still open on the token.
    skillsRef.value = SKILLS;
    await nextTick();
    expect(mention.skillItems.value.map((s) => s.name)).toEqual(['goal']);
    expect(mention.open.value).toBe(true);
  });

  it('does not reopen a closed menu when the skill list arrives', async () => {
    const skillsRef = ref<AppSkill[]>([]);
    const { mention } = setup('@goal', undefined, { skills: skillsRef });
    mention.update();
    expect(mention.open.value).toBe(false);
    skillsRef.value = SKILLS;
    await nextTick();
    expect(mention.open.value).toBe(false);
  });

  it('re-derives the skill candidates while the file search is still debouncing', async () => {
    const skillsRef = ref<AppSkill[]>([]);
    const searchFiles = vi.fn().mockResolvedValue([]);
    const { mention } = setup('@goal', searchFiles, { skills: skillsRef });
    mention.update();
    // Inside the debounce window the menu has not opened yet (no local skill
    // hits, the file search has not fired).
    expect(mention.open.value).toBe(false);
    expect(searchFiles).not.toHaveBeenCalled();
    // The skills arrive now — the section fills in WITHOUT forcing the menu
    // open (the pending search owns opening).
    skillsRef.value = SKILLS;
    await nextTick();
    expect(mention.skillItems.value.map((s) => s.name)).toEqual(['goal']);
    expect(mention.open.value).toBe(false);
    // The debounced search then opens the menu with the skill section in place.
    await vi.advanceTimersByTimeAsync(200);
    expect(mention.open.value).toBe(true);
    expect(mention.skillItems.value.map((s) => s.name)).toEqual(['goal']);
  });

  it('does not refresh or reopen an explicitly closed menu when the skill list arrives', async () => {
    const skillsRef = ref<AppSkill[]>([]);
    const searchFiles = vi.fn().mockResolvedValue([]);
    const { mention } = setup('@goal', searchFiles, { skills: skillsRef });
    mention.update();
    // Escape mid-debounce: the menu is closed explicitly while the @token is
    // still live — a late skill list must neither fill in nor reopen it.
    mention.close();
    skillsRef.value = SKILLS;
    await nextTick();
    expect(mention.skillItems.value).toEqual([]);
    expect(mention.open.value).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(searchFiles).not.toHaveBeenCalled();
    expect(mention.open.value).toBe(false);
  });

  it('re-arms the skill-list refresh on the next keystroke after an explicit close', async () => {
    const skillsRef = ref<AppSkill[]>([]);
    const searchFiles = vi.fn().mockResolvedValue([]);
    const { text, editor, mention } = setup('@g', searchFiles, { skills: skillsRef });
    mention.update();
    mention.close();
    // Type another character — the fresh derivation re-arms the watcher.
    text.value = '@go';
    editor.value = '@go';
    editor.selectionStart = 3;
    mention.update();
    skillsRef.value = SKILLS;
    await nextTick();
    expect(mention.skillItems.value.map((s) => s.name)).toEqual(['goal']);
    expect(mention.open.value).toBe(false);
  });
});

describe('useMentionMenu — pill insertion (insertMention dep)', () => {
  it('routes file selection through insertMention with the token range', () => {
    const calls: Array<{ entry: MentionEntry; range: { start: number; end: number } }> = [];
    const { mention } = setup('hello @a', undefined, {
      insertMention: (entry, range) => calls.push({ entry, range }),
    });
    mention.select({ kind: 'file', file: { path: 'src/a.ts', name: 'a.ts' } });
    expect(calls).toEqual([
      { entry: { kind: 'file', path: 'src/a.ts', name: 'a.ts' }, range: { start: 6, end: 8 } },
    ]);
    expect(mention.open.value).toBe(false);
  });

  it('marks trailing-slash paths as folders', () => {
    const calls: MentionEntry[] = [];
    const { mention } = setup('@s', undefined, { insertMention: (entry) => calls.push(entry) });
    mention.select({ kind: 'folder', file: { path: 'src/', name: 'src' } });
    expect(calls[0]).toEqual({ kind: 'folder', path: 'src/', name: 'src' });
  });

  it('routes skill selection through insertMention with a skill entry', () => {
    const calls: MentionEntry[] = [];
    const { mention } = setup('run @go', undefined, {
      skills: [{ name: 'goal', description: '', path: '/skills/goal/SKILL.md', source: 'builtin' }],
      insertMention: (entry) => calls.push(entry),
    });
    mention.select({ kind: 'skill', skill: { name: 'goal', description: '', path: '/skills/goal/SKILL.md', source: 'builtin' } });
    expect(calls).toEqual([{ kind: 'skill', name: 'goal' }]);
  });

  it('does not fall back to text splicing when insertMention is present', () => {
    const { text, mention } = setup('hello @a', undefined, { insertMention: () => {} });
    mention.select({ kind: 'file', file: { path: 'src/a.ts', name: 'a.ts' } });
    expect(text.value).toBe('hello @a'); // untouched — the editor owns the doc
  });
});

describe('useMentionMenu — pill-boundary token detection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const SKILL = { name: 'goal', description: '', path: '/skills/goal/SKILL.md', source: 'builtin' };
  // '[x](kimi-code://skill/x)' is 24 chars; the '@g' token follows at 24..26.
  const AFTER_PILL = '[x](kimi-code://skill/x)@g';

  it('detects the @token typed right after a pill', () => {
    const { mention } = setup(AFTER_PILL, undefined, { skills: [SKILL], runStart: 24 });
    mention.update();
    expect(mention.open.value).toBe(true);
    expect(mention.skillItems.value.map((s) => s.name)).toEqual(['goal']);
  });

  it('without the run bound (textarea), the same text detects no token', () => {
    const { mention } = setup(AFTER_PILL, undefined, { skills: [SKILL] });
    mention.update();
    expect(mention.open.value).toBe(false);
  });

  it('select replaces only the @token after the pill, not the pill text', () => {
    const calls: Array<{ range: { start: number; end: number } }> = [];
    const { mention } = setup(AFTER_PILL, undefined, {
      skills: [SKILL],
      runStart: 24,
      insertMention: (_entry, range) => calls.push({ range }),
    });
    mention.select({ kind: 'skill', skill: SKILL });
    expect(calls[0]?.range).toEqual({ start: 24, end: 26 });
  });

  it('a whitespace-delimited token inside the post-pill run still works', () => {
    const text = '[x](kimi-code://skill/x) ask @go';
    const { mention } = setup(text, undefined, { skills: [SKILL], runStart: 25 });
    mention.update();
    expect(mention.skillItems.value.map((s) => s.name)).toEqual(['goal']);
  });
});

describe('useMentionMenu — full-width ＠ trigger (Chinese IMEs)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens on a full-width ＠ and searches with the following query', async () => {
    const searchFiles = vi.fn().mockResolvedValue([{ path: 'src/a.ts', name: 'a.ts' }]);
    const { mention } = setup('＠a', searchFiles);
    mention.update();
    await vi.advanceTimersByTimeAsync(200);
    expect(searchFiles).toHaveBeenCalledWith('a');
    expect(mention.open.value).toBe(true);
  });

  it('select replaces the full-width token (including the ＠)', () => {
    const calls: Array<{ entry: MentionEntry; range: { start: number; end: number } }> = [];
    const { mention } = setup('hi ＠a', undefined, {
      insertMention: (entry, range) => calls.push({ entry, range }),
    });
    mention.select({ kind: 'file', file: { path: 'src/a.ts', name: 'a.ts' } });
    // 'hi ' is 3 chars; '＠a' spans 3..5.
    expect(calls[0]).toEqual({
      entry: { kind: 'file', path: 'src/a.ts', name: 'a.ts' },
      range: { start: 3, end: 5 },
    });
  });
});
