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
    // The 'a' search fired on the keystroke…
    expect(searchFiles).toHaveBeenCalledWith('a');
    // …and backspacing to a bare @ replaces it with the empty-query listing.
    text.value = '@';
    editor.value = '@';
    editor.selectionStart = 1;
    mention.update();
    await vi.advanceTimersByTimeAsync(0);
    expect(searchFiles).toHaveBeenCalledTimes(2);
    expect(searchFiles).toHaveBeenLastCalledWith('');
    expect(mention.open.value).toBe(true);
  });

  it('stays closed when the @token is deleted while the search is in flight', async () => {
    const searchFiles = vi.fn().mockResolvedValue([{ path: 'src/a.ts', name: 'a.ts' }]);
    const { text, editor, mention } = setup('@a', searchFiles);
    mention.update();
    // The 'a' search fired on the keystroke; deleting the whole token closes
    // the menu before its response lands (and that response is dropped).
    expect(searchFiles).toHaveBeenCalledWith('a');
    text.value = '';
    editor.value = '';
    editor.selectionStart = 0;
    mention.update();
    await vi.advanceTimersByTimeAsync(0);
    expect(mention.open.value).toBe(false);
    expect(mention.fileItems.value).toEqual([]);
    expect(mention.loading.value).toBe(false);
  });

  it('ignores in-flight results that resolve after backspacing to a bare @', async () => {
    const resolvers: Array<(items: FileItem[]) => void> = [];
    const searchFiles = vi.fn().mockImplementation(
      () => new Promise<FileItem[]>((resolve) => { resolvers.push(resolve); }),
    );
    const { text, editor, mention } = setup('@a', searchFiles);
    mention.update();
    expect(searchFiles).toHaveBeenCalledWith('a'); // fires on the keystroke
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

  it('opens immediately with search results (no debounce)', async () => {
    const searchFiles = vi.fn().mockResolvedValue([{ path: 'src/a.ts', name: 'a.ts' }]);
    const { mention } = setup('@a', searchFiles);
    mention.update();
    // The search fires on the keystroke and opens the menu while in flight.
    expect(searchFiles).toHaveBeenCalledWith('a');
    expect(mention.open.value).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
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
    // keystroke; the menu never collapses. The default highlight resets to
    // the top row of the merged ranking (a new intent) — here the freshly
    // prefix-matched skill legitimately owns it.
    text.value = '@goal';
    editor.value = '@goal';
    editor.selectionStart = 5;
    mention.update();
    expect(mention.fileItems.value).toEqual([{ path: 'src/a.ts', name: 'a.ts' }]);
    expect(mention.fileStale.value).toBe(true);
    expect(mention.skillItems.value.map((s) => s.skill.name)).toEqual(['goal']);
    expect(mention.active.value).toBe(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(mention.fileItems.value).toEqual([{ path: 'src/b.ts', name: 'b.ts' }]);
    expect(mention.fileStale.value).toBe(false);
    // …and the landing keeps the highlight on the same row (the skill), which
    // still tops the ranking over the weak 'b.ts' subsequence hit.
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

  it('discards an in-flight response when the query round-trips while requests are in flight', async () => {
    const resolvers: Array<(items: FileItem[]) => void> = [];
    const searchFiles = vi.fn().mockImplementation(
      () => new Promise<FileItem[]>((resolve) => { resolvers.push(resolve); }),
    );
    const { text, editor, mention } = setup('@foo', searchFiles);
    mention.update();
    expect(searchFiles).toHaveBeenCalledWith('foo'); // search A fires at once
    // '@foo' → '@bar' → '@foo' in quick succession: B and C fire immediately —
    // and the ORIGINAL 'foo' response arrives while its own re-query (C) is
    // still in flight…
    text.value = '@bar';
    editor.value = '@bar';
    editor.selectionStart = 4;
    mention.update();
    text.value = '@foo';
    editor.value = '@foo';
    editor.selectionStart = 4;
    mention.update();
    expect(searchFiles.mock.calls.map((call) => call[0])).toEqual(['foo', 'bar', 'foo']);
    resolvers[0]!([{ path: 'src/stale.ts', name: 'stale.ts' }]);
    await vi.advanceTimersByTimeAsync(0);
    // …and it must be dropped — the query change already invalidated the
    // request, so the menu shows nothing (and keeps loading) instead of
    // flashing stale candidates until the re-search lands.
    expect(mention.fileItems.value).toEqual([]);
    expect(mention.loading.value).toBe(true);
    // The newest 'foo' response (C) is the one that lands.
    resolvers[2]!([{ path: 'src/fresh.ts', name: 'fresh.ts' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mention.fileItems.value).toEqual([{ path: 'src/fresh.ts', name: 'fresh.ts' }]);
    expect(mention.loading.value).toBe(false);
  });

  it('keeps the highlighted row when async file results shift the indices', async () => {
    const SKILLS: AppSkill[] = [
      { name: 'goal', description: 'Goal mode', path: '/skills/goal/SKILL.md', source: 'builtin' },
      { name: 'git-review', description: 'Review', path: '/skills/git-review/SKILL.md', source: 'project' },
      { name: 'wing', description: 'Wing', path: '/skills/wing/SKILL.md', source: 'project' },
    ];
    const searchFiles = vi.fn().mockResolvedValue([{ path: 'src/g.ts', name: 'g.ts' }]);
    const { mention } = setup('@g', searchFiles, { skills: SKILLS });
    mention.update();
    // The skills open immediately; the user arrows onto 'wing' (the
    // substring-tier row) before the file search returns.
    mention.active.value = 2;
    await vi.advanceTimersByTimeAsync(200);
    // The file hits merged into the ranking: 'g.ts' is a strong (prefix) file
    // hit, so it lands between the prefix skills and the substring skill…
    expect(mention.items.value.map((item) => (item.kind === 'skill' ? item.skill.name : item.file.name)))
      .toEqual(['goal', 'git-review', 'g.ts', 'wing']);
    // …and the highlight followed 'wing' to its new index instead of
    // resetting to row 0 (an Enter now would insert the wrong row).
    expect(mention.active.value).toBe(3);
    const activeItem = mention.items.value[mention.active.value]!;
    expect(activeItem.kind === 'skill' && activeItem.skill.name).toBe('wing');
  });

  it('resets the highlight to row 0 when a refreshed result set drops that row', async () => {
    const resolvers: Array<(items: FileItem[]) => void> = [];
    const searchFiles = vi.fn().mockImplementation(
      () => new Promise<FileItem[]>((resolve) => { resolvers.push(resolve); }),
    );
    const { text, editor, mention } = setup('@a', searchFiles);
    mention.update();
    resolvers[0]!([{ path: 'src/a.ts', name: 'a.ts' }, { path: 'src/ab.ts', name: 'ab.ts' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mention.fileItems.value).toHaveLength(2);
    mention.active.value = 1; // highlight 'ab.ts'
    // Re-enter the query — fiddle and land back on 'a' (each keystroke fires
    // its own search immediately): the newest re-search returns a set WITHOUT
    // ab.ts, so the highlight must not linger on a row that no longer exists.
    text.value = '@ab';
    editor.value = '@ab';
    editor.selectionStart = 3;
    mention.update();
    text.value = '@a';
    editor.value = '@a';
    editor.selectionStart = 2;
    mention.update();
    expect(searchFiles).toHaveBeenCalledTimes(3);
    resolvers[2]!([{ path: 'src/a.ts', name: 'a.ts' }]);
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
    expect(mention.skillItems.value.map((s) => s.skill.name)).toEqual(['goal', 'git-review', 'grammar']);
  });

  it('carries contiguous name-match positions for row highlighting', () => {
    const { mention } = setup('@rev', undefined, { skills: SKILLS });
    mention.update();
    const row = mention.items.value.find((item) => item.kind === 'skill' && item.skill.name === 'git-review');
    // 'git-review' contains 'rev' at offset 4 — one contiguous run.
    expect(row && row.kind === 'skill' && row.matchPositions).toEqual([4, 5, 6]);
  });

  it('matches skills by subsequence for tokens of 3+ chars (separator-bridging)', () => {
    const { mention } = setup('@larkim', undefined, {
      skills: [
        { name: 'lark-im', description: '', path: '/s/lark-im/SKILL.md', source: 'project' },
        { name: 'lark-wiki', description: '', path: '/s/lark-wiki/SKILL.md', source: 'project' },
      ],
    });
    mention.update();
    // 'larkim' is a subsequence of 'lark-im' but NOT of 'lark-wiki' (there
    // the 'i' comes after the last possible 'm' position ordering fails).
    expect(mention.skillItems.value.map((s) => s.skill.name)).toEqual(['lark-im']);
    expect(mention.open.value).toBe(true);
    // …with the scattered (non-contiguous) match positions for highlighting.
    const row = mention.items.value[0];
    expect(row?.kind).toBe('skill');
    expect(row && row.kind === 'skill' && row.matchPositions).toEqual([0, 1, 2, 3, 5, 6]);
  });

  it('does not subsequence-match skills for short tokens', () => {
    const { mention } = setup('@lm', undefined, {
      skills: [{ name: 'lark-im', description: '', path: '/s/lark-im/SKILL.md', source: 'project' }],
    });
    mention.update();
    // Two characters subsequence-match nearly everything — pure noise, so
    // the subsequence tier only kicks in at 3+.
    expect(mention.skillItems.value).toEqual([]);
    expect(mention.open.value).toBe(false);
  });

  it('keeps the highlighted row by identity when a late skill list reorders the merged list', async () => {
    const skillsRef = ref<AppSkill[]>([]);
    const searchFiles = vi.fn().mockResolvedValue([
      { path: 'src/g.ts', name: 'g.ts' },
      { path: 'src/g2.ts', name: 'g2.ts' },
    ]);
    const { mention } = setup('@g', searchFiles, { skills: skillsRef });
    mention.update();
    await vi.advanceTimersByTimeAsync(0);
    // The user arrows onto the second file row.
    expect(mention.items.value.map((item) => (item.kind === 'skill' ? item.skill.name : item.file.name)))
      .toEqual(['g.ts', 'g2.ts']);
    mention.active.value = 1;
    // The skill list arrives late: prefix skills join the top bands,
    // reordering the merged list…
    skillsRef.value = SKILLS;
    await nextTick();
    expect(mention.items.value.map((item) => (item.kind === 'skill' ? item.skill.name : item.file.name)))
      .toEqual(['goal', 'git-review', 'grammar', 'g.ts', 'g2.ts']);
    // …but the highlight follows 'g2.ts' to its new index — a numeric index
    // left behind would silently retarget 'git-review', and Enter would
    // insert it.
    const activeItem = mention.items.value[mention.active.value]!;
    expect(activeItem.kind === 'file' && activeItem.file.name).toBe('g2.ts');
  });

  it('keeps the highlight on a single-row skill after an arrow press that cannot move it', async () => {
    const resolvers: Array<(items: FileItem[]) => void> = [];
    const searchFiles = vi.fn().mockImplementation(
      () => new Promise<FileItem[]>((resolve) => { resolvers.push(resolve); }),
    );
    const { mention } = setup('@goal', searchFiles, {
      skills: [{ name: 'x-goal', description: '', path: '/s/x-goal/SKILL.md', source: 'project' }],
    });
    mention.update();
    // One candidate: a substring skill. The user presses ArrowDown — the
    // index cannot move (0 → 0, no watch fires), but navigate() must still
    // register the intent.
    expect(mention.items.value).toHaveLength(1);
    mention.navigate(0);
    // A strong file hit lands and joins ABOVE the substring skill…
    resolvers[0]!([{ path: 'src/goal.ts', name: 'goal.ts' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mention.items.value.map((item) => (item.kind === 'skill' ? item.skill.name : item.file.name)))
      .toEqual(['goal.ts', 'x-goal']);
    // …but the highlight stays with the skill the user acted on.
    const activeItem = mention.items.value[mention.active.value]!;
    expect(activeItem.kind === 'skill' && activeItem.skill.name).toBe('x-goal');
  });

  it('captures the highlighted row before re-banding stale candidates under the new query', async () => {
    const resolvers: Array<(items: FileItem[]) => void> = [];
    const searchFiles = vi.fn().mockImplementation(
      () => new Promise<FileItem[]>((resolve) => { resolvers.push(resolve); }),
    );
    const skills: AppSkill[] = [
      { name: 'goal', description: '', path: '/s/goal/SKILL.md', source: 'project' },
      { name: 'z-goal', description: '', path: '/s/z-goal/SKILL.md', source: 'project' },
    ];
    const { text, editor, mention } = setup('@a', searchFiles, { skills });
    mention.update();
    resolvers[0]!([{ path: 'src/a.ts', name: 'a.ts' }]);
    await vi.advanceTimersByTimeAsync(0);
    // '@a' landed a strong file hit above the substring skills.
    expect(mention.items.value.map((item) => (item.kind === 'skill' ? item.skill.name : item.file.name)))
      .toEqual(['a.ts', 'goal', 'z-goal']);

    // Retype '@goal': the file row goes stale but keeps its strong band (it
    // was produced by 'a'); the user arrows onto the substring skill.
    text.value = '@goal';
    editor.value = '@goal';
    editor.selectionStart = 5;
    mention.update();
    expect(mention.items.value.map((item) => (item.kind === 'skill' ? item.skill.name : item.file.name)))
      .toEqual(['goal', 'a.ts', 'z-goal']);
    mention.navigate(2); // 'z-goal'

    // The new results land. applyFileItems must capture the highlight BEFORE
    // re-banding the stale 'a.ts' under 'goal' (which drops it to the weak
    // band and shifts 'z-goal' up) — capturing after would mistake the stale
    // file for the highlighted row.
    resolvers[1]!([{ path: 'src/b.ts', name: 'b.ts' }]);
    await vi.advanceTimersByTimeAsync(0);
    const activeItem = mention.items.value[mention.active.value]!;
    expect(activeItem.kind === 'skill' && activeItem.skill.name).toBe('z-goal');
  });

  it('covers the full UTF-16 span of surrogate pairs in subsequence skill matches', () => {
    const { mention } = setup('@a🍱🍱', undefined, {
      skills: [{ name: 'a🍱x🍱', description: '', path: '/s/emoji/SKILL.md', source: 'project' }],
    });
    mention.update();
    const row = mention.items.value[0];
    expect(row?.kind).toBe('skill');
    // '🍱' is a surrogate pair: each matched emoji must contribute BOTH
    // UTF-16 units, or mentionMatchSpans would slice a pair in two.
    expect(row && row.kind === 'skill' && row.matchPositions).toEqual([0, 1, 2, 4, 5]);
  });

  it('maps match positions back to original coordinates when case-folding expands a character', () => {
    const { mention } = setup('@ab', undefined, {
      skills: [{ name: 'xİAB', description: '', path: '/s/exp/SKILL.md', source: 'project' }],
    });
    mention.update();
    const row = mention.items.value[0];
    expect(row?.kind).toBe('skill');
    // 'İ' case-folds to 'i̇' (one unit → two), so the lowered match's index
    // is not the original's: 'AB' sits at [2,3] in 'xİAB', not [3,4].
    expect(row && row.kind === 'skill' && row.matchPositions).toEqual([2, 3]);
  });

  it('counts the subsequence gate in code points, not UTF-16 units', () => {
    const { mention } = setup('@🍱a', undefined, {
      skills: [{ name: '🍱---a', description: '', path: '/s/gate/SKILL.md', source: 'project' }],
    });
    mention.update();
    // Two user characters (three UTF-16 units): below the 3-char gate, so no
    // subsequence match.
    expect(mention.skillItems.value).toEqual([]);
    expect(mention.open.value).toBe(false);
  });

  it('matches context-sensitive case mappings with whole-string lowering (final sigma)', () => {
    const { mention } = setup('@ος', undefined, {
      skills: [{ name: 'ΟΣ', description: '', path: '/s/sigma/SKILL.md', source: 'project' }],
    });
    mention.update();
    const row = mention.items.value[0];
    // 'ΟΣ' folds to 'ος' (final sigma) — per-code-point lowering would give
    // 'οσ' and the exact match would vanish.
    expect(row?.kind).toBe('skill');
    expect(row && row.kind === 'skill' && row.matchPositions).toEqual([0, 1]);
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
    expect(mention.skillItems.value.map((s) => s.skill.name)).toEqual(['goal']);
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

  it('re-derives the skill candidates while the file search is in flight', async () => {
    const skillsRef = ref<AppSkill[]>([]);
    let resolveSearch: (items: FileItem[]) => void = () => {};
    const searchFiles = vi.fn(
      () =>
        new Promise<FileItem[]>((resolve) => {
          resolveSearch = resolve;
        }),
    );
    const { mention } = setup('@goal', searchFiles, { skills: skillsRef });
    mention.update();
    // The search fired on the keystroke: menu open (loading), no local skill
    // hits yet.
    expect(mention.open.value).toBe(true);
    expect(mention.loading.value).toBe(true);
    expect(mention.skillItems.value).toEqual([]);
    // The skills arrive mid-flight — the section fills in in place, without
    // waiting for the search.
    skillsRef.value = SKILLS;
    await nextTick();
    expect(mention.skillItems.value.map((s) => s.skill.name)).toEqual(['goal']);
    // …and the search's landing keeps it.
    resolveSearch([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mention.open.value).toBe(true);
    expect(mention.skillItems.value.map((s) => s.skill.name)).toEqual(['goal']);
  });

  it('does not refresh or reopen an explicitly closed menu when the skill list arrives', async () => {
    const skillsRef = ref<AppSkill[]>([]);
    const searchFiles = vi.fn().mockResolvedValue([]);
    const { mention } = setup('@goal', searchFiles, { skills: skillsRef });
    mention.update();
    // The search fired on the keystroke; Escape while it is in flight closes
    // the menu explicitly while the @token is still live — a late skill list
    // must neither fill in nor reopen it.
    expect(searchFiles).toHaveBeenCalledTimes(1);
    mention.close();
    skillsRef.value = SKILLS;
    await nextTick();
    expect(mention.skillItems.value).toEqual([]);
    expect(mention.open.value).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(searchFiles).toHaveBeenCalledTimes(1);
    expect(mention.open.value).toBe(false);
  });

  it('re-arms the skill-list refresh on the next keystroke after an explicit close', async () => {
    const skillsRef = ref<AppSkill[]>([]);
    const searchFiles = vi.fn().mockResolvedValue([]);
    const { text, editor, mention } = setup('@g', searchFiles, { skills: skillsRef });
    mention.update();
    mention.close();
    // Type another character — the fresh derivation re-arms the watcher and
    // fires a new search immediately.
    text.value = '@go';
    editor.value = '@go';
    editor.selectionStart = 3;
    mention.update();
    skillsRef.value = SKILLS;
    await nextTick();
    expect(mention.skillItems.value.map((s) => s.skill.name)).toEqual(['goal']);
    await vi.advanceTimersByTimeAsync(0);
    expect(mention.open.value).toBe(true);
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
    expect(mention.skillItems.value.map((s) => s.skill.name)).toEqual(['goal']);
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
    expect(mention.skillItems.value.map((s) => s.skill.name)).toEqual(['goal']);
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
