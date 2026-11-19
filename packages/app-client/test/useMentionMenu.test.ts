import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref, unref, type Ref } from 'vue';
import {
  useMentionMenu,
  type AttachmentMentionCandidate,
  type FileSearch,
  type MentionEntry,
  type MentionItem,
  type SessionSearch,
} from '../src/composables';
import type { FileItem } from '@moonshot-ai/app-core/client';
import type { AppSkill } from '@moonshot-ai/app-core/api';
import type { TextFieldLike } from '@moonshot-ai/app-composer/runtime';
import type { SessionMentionCandidate } from '../src/lib/sessionReferences';

interface MockEditor {
  value: string;
  selectionStart: number;
  setSelectionRange: (start: number, end: number) => void;
  focus: () => void;
}

interface SetupOptions {
  skills?: AppSkill[] | Ref<AppSkill[]>;
  attachments?: AttachmentMentionCandidate[] | Ref<AttachmentMentionCandidate[]>;
  sessions?: SessionMentionCandidate[];
  searchSessions?: SessionSearch;
  insertMention?: (entry: MentionEntry, range: { start: number; end: number }) => void;
  completeMention?: (text: string, range: { start: number; end: number }) => void;
  runStart?: number;
}

function setup(initialText = '', searchFiles?: FileSearch, options: SetupOptions = {}) {
  const editor: MockEditor & { inlineTextRunStart?: () => number | null } = {
    value: initialText,
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
    attachments: options.attachments ? () => unref(options.attachments!) : undefined,
    sessions: options.sessions ? () => options.sessions! : undefined,
    searchSessions: options.searchSessions,
    insertMention: options.insertMention,
    completeMention: options.completeMention,
  });
  return { text, editor, mention };
}

function attachmentCandidate(
  attId: string,
  label: string,
  name: string,
  kind: 'image' | 'video' | 'file' = 'image',
): AttachmentMentionCandidate {
  return {
    label,
    entry: {
      attId,
      key: `blob:${attId}`,
      kind,
      name,
      mediaOrdinal: kind === 'image' || kind === 'video' ? 1 : undefined,
      refCount: 0,
      uploading: false,
      fileId: `file-${attId}`,
    },
  };
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
    expect(searchFiles).toHaveBeenCalledWith('', expect.anything());
    await Promise.resolve();
    await nextTick();
    expect(mention.open.value).toBe(true);
    expect(mention.fileItems.value).toEqual([{ path: 'README.md', name: 'README.md' }]);
    expect(mention.loading.value).toBe(false);
    expect(mention.skillItems.value).toEqual([]);
  });

  it('re-searches with the empty query when the query is deleted back to a bare @', async () => {
    const searchFiles = vi.fn().mockResolvedValue([{ path: 'src/a.ts', name: 'a.ts' }]);
    const { text, editor, mention } = setup('@a', searchFiles);
    mention.update();
    expect(searchFiles).toHaveBeenCalledWith('a', expect.anything());
    text.value = '@';
    editor.value = '@';
    editor.selectionStart = 1;
    mention.update();
    await vi.advanceTimersByTimeAsync(0);
    expect(searchFiles).toHaveBeenCalledTimes(2);
    expect(searchFiles).toHaveBeenLastCalledWith('', expect.anything());
    expect(mention.open.value).toBe(true);
  });

  it('stays closed when the @token is deleted while the search is in flight', async () => {
    const searchFiles = vi.fn().mockResolvedValue([{ path: 'src/a.ts', name: 'a.ts' }]);
    const { text, editor, mention } = setup('@a', searchFiles);
    mention.update();
    expect(searchFiles).toHaveBeenCalledWith('a', expect.anything());
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
    expect(searchFiles).toHaveBeenCalledWith('a', expect.anything());
    text.value = '@';
    editor.value = '@';
    editor.selectionStart = 1;
    mention.update();
    expect(searchFiles).toHaveBeenCalledWith('', expect.anything());
    resolvers[0]!([{ path: 'src/a.ts', name: 'a.ts' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mention.fileItems.value).toEqual([]);
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
    expect(searchFiles).toHaveBeenCalledWith('a', expect.anything());
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

  it('drops old file candidates while the new search is pending', async () => {
    const searchFiles = vi.fn().mockImplementation((q: string) =>
      Promise.resolve(q === 'a' ? [{ path: 'src/a.ts', name: 'a.ts' }] : [{ path: 'src/b.ts', name: 'b.ts' }]),
    );
    const { text, editor, mention } = setup('@a', searchFiles, {
      skills: [{ name: 'goal', description: '', path: '/s/goal/SKILL.md', source: 'builtin' }],
    });
    mention.update();
    await vi.advanceTimersByTimeAsync(200);
    expect(mention.fileItems.value).toEqual([{ path: 'src/a.ts', name: 'a.ts' }]);
    expect(mention.loading.value).toBe(false);
    text.value = '@goal';
    editor.value = '@goal';
    editor.selectionStart = 5;
    mention.update();
    expect(mention.fileItems.value).toEqual([]);
    expect(mention.loading.value).toBe(true);
    expect(mention.query.value).toBe('goal');
    expect(mention.items.value.map((item) => item.kind)).toEqual(['skill']);
    expect(mention.active.value).toBe(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(mention.fileItems.value).toEqual([{ path: 'src/b.ts', name: 'b.ts' }]);
    expect(mention.loading.value).toBe(false);
    expect(mention.active.value).toBe(0);
  });

  it('applies only the newest search when the same query is re-entered', async () => {
    const resolvers: Array<(items: FileItem[]) => void> = [];
    const searchFiles = vi.fn().mockImplementation(
      () => new Promise<FileItem[]>((resolve) => { resolvers.push(resolve); }),
    );
    const { text, editor, mention } = setup('@foo', searchFiles);
    mention.update();
    await vi.advanceTimersByTimeAsync(200);
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
    resolvers[1]!([{ path: 'src/bar.ts', name: 'bar.ts' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mention.fileItems.value).toEqual([]);
    expect(mention.loading.value).toBe(true);
    resolvers[0]!([{ path: 'src/stale.ts', name: 'stale.ts' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mention.fileItems.value).toEqual([]);
    expect(mention.loading.value).toBe(true);
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
    expect(searchFiles).toHaveBeenCalledWith('foo', expect.anything());
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
    expect(mention.fileItems.value).toEqual([]);
    expect(mention.loading.value).toBe(true);
    resolvers[2]!([{ path: 'src/fresh.ts', name: 'fresh.ts' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mention.fileItems.value).toEqual([{ path: 'src/fresh.ts', name: 'fresh.ts' }]);
    expect(mention.loading.value).toBe(false);
  });

  it('keeps the highlighted row when async file results add another section', async () => {
    const SKILLS: AppSkill[] = [
      { name: 'goal', description: 'Goal mode', path: '/skills/goal/SKILL.md', source: 'builtin' },
      { name: 'git-review', description: 'Review', path: '/skills/git-review/SKILL.md', source: 'project' },
      { name: 'wing', description: 'Wing', path: '/skills/wing/SKILL.md', source: 'project' },
    ];
    const searchFiles = vi.fn().mockResolvedValue([{ path: 'src/g.ts', name: 'g.ts' }]);
    const { mention } = setup('@g', searchFiles, { skills: SKILLS });
    mention.update();
    mention.active.value = 2;
    await vi.advanceTimersByTimeAsync(200);
    expect(mention.items.value.map((item) => (item.kind === 'skill' ? item.skill.name : item.file.name)))
      .toEqual(['goal', 'git-review', 'wing', 'g.ts']);
    expect(mention.active.value).toBe(2);
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
    mention.active.value = 1;
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

  it('aborts the in-flight search when a newer keystroke supersedes it', async () => {
    const signals: AbortSignal[] = [];
    const searchFiles = vi.fn<FileSearch>((_q, options) => {
      if (options?.signal) signals.push(options.signal);
      return new Promise<FileItem[]>(() => {});
    });
    const { text, editor, mention } = setup('@a', searchFiles);
    mention.update();
    text.value = '@ab';
    editor.value = '@ab';
    editor.selectionStart = 3;
    mention.update();
    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
  });

  it('aborts the in-flight search on close', async () => {
    let captured: AbortSignal | undefined;
    const searchFiles = vi.fn<FileSearch>((_q, options) => {
      captured = options?.signal;
      return new Promise<FileItem[]>(() => {});
    });
    const { mention } = setup('@a', searchFiles);
    mention.update();
    mention.close();
    expect(captured?.aborted).toBe(true);
  });

  it('aborts the in-flight search when the @token is deleted mid-flight', async () => {
    let captured: AbortSignal | undefined;
    const searchFiles = vi.fn<FileSearch>((_q, options) => {
      captured = options?.signal;
      return new Promise<FileItem[]>(() => {});
    });
    const { text, editor, mention } = setup('@a', searchFiles);
    mention.update();
    text.value = '';
    editor.value = '';
    editor.selectionStart = 0;
    mention.update();
    expect(captured?.aborted).toBe(true);
    expect(mention.loading.value).toBe(false);
    expect(mention.open.value).toBe(false);
  });

  it('swallows the aborted search rejection — not an error for the newest search', async () => {
    const rejects: Array<(err: unknown) => void> = [];
    const searchFiles = vi.fn(
      () => new Promise<FileItem[]>((_resolve, reject) => { rejects.push(reject); }),
    );
    const { text, editor, mention } = setup('@a', searchFiles);
    mention.update();
    text.value = '@ab';
    editor.value = '@ab';
    editor.selectionStart = 3;
    mention.update();
    rejects[0]!(new DOMException('The operation was aborted.', 'AbortError'));
    await vi.advanceTimersByTimeAsync(0);
    expect(mention.loading.value).toBe(true);
    expect(mention.open.value).toBe(true);
    expect(mention.fileItems.value).toEqual([]);
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

describe('useMentionMenu — attachment section', () => {
  it('opens immediately on a bare @ and keeps active attachments above other results', async () => {
    const searchFiles = vi.fn().mockResolvedValue([{ path: 'src/a.ts', name: 'a.ts' }]);
    const attachments = [
      attachmentCandidate('image-1', 'Image 1', 'logo-final.png'),
      attachmentCandidate('video-1', 'Video 1', 'demo.mov', 'video'),
    ];
    const { mention } = setup('@', searchFiles, { attachments });

    mention.update();

    expect(mention.open.value).toBe(true);
    expect(mention.items.value.map((item) => item.kind)).toEqual(['attachment', 'attachment']);
    await Promise.resolve();
    await nextTick();
    expect(mention.items.value.map((item) => item.kind)).toEqual([
      'attachment',
      'attachment',
      'file',
    ]);
  });

  it('filters attachments by their generated label and original file name', () => {
    const attachments = [
      attachmentCandidate('image-1', 'Image 1', 'logo-final.png'),
      attachmentCandidate('image-2', 'Image 2', 'office-map.png'),
    ];
    const byLabel = setup('@image2', undefined, { attachments });
    byLabel.mention.update();
    expect(byLabel.mention.items.value).toHaveLength(1);
    expect(byLabel.mention.items.value[0]?.kind).toBe('attachment');
    expect(
      byLabel.mention.items.value[0]?.kind === 'attachment' &&
      byLabel.mention.items.value[0].attachment.entry.attId,
    ).toBe('image-2');

    const byName = setup('@logo', undefined, { attachments });
    byName.mention.update();
    expect(byName.mention.items.value).toHaveLength(1);
    expect(
      byName.mention.items.value[0]?.kind === 'attachment' &&
      byName.mention.items.value[0].attachment.entry.attId,
    ).toBe('image-1');
  });

  it('groups non-media active attachments with project files after media', async () => {
    const searchFiles = vi.fn().mockResolvedValue([{ path: 'src/project.ts', name: 'project.ts' }]);
    const attachments = [
      attachmentCandidate('image-1', 'Image 1', 'logo.png'),
      attachmentCandidate('file-1', 'brief.pdf', 'brief.pdf', 'file'),
    ];
    const { mention } = setup('@', searchFiles, { attachments });

    mention.update();
    await Promise.resolve();
    await nextTick();

    expect(mention.items.value.map((item) => {
      if (item.kind === 'attachment') return `${item.kind}:${item.attachment.entry.kind}`;
      return item.kind;
    })).toEqual(['attachment:image', 'attachment:file', 'file']);
  });

  it('replaces the full @ query with an attachment entry on Enter or Tab', () => {
    const calls: Array<{ entry: MentionEntry; range: { start: number; end: number } }> = [];
    const candidate = attachmentCandidate('image-1', 'Image 1', 'logo-final.png');
    const { mention } = setup('compare @logo', undefined, {
      attachments: [candidate],
      insertMention: (entry, range) => calls.push({ entry, range }),
    });
    mention.update();
    const item = mention.items.value[0]!;

    mention.complete(item);

    expect(calls).toEqual([{
      entry: {
        kind: 'attachment',
        attId: 'image-1',
        name: 'Image 1',
        attachmentKind: 'image',
      },
      range: { start: 8, end: 13 },
    }]);
    expect(mention.open.value).toBe(false);
  });

  it('updates the visible section when the active attachment list changes', async () => {
    const attachments = ref([attachmentCandidate('image-1', 'Image 1', 'one.png')]);
    const { mention } = setup('@', undefined, { attachments });
    mention.update();
    expect(mention.items.value).toHaveLength(1);

    attachments.value = [
      ...attachments.value,
      attachmentCandidate('image-2', 'Image 2', 'two.png'),
    ];
    await nextTick();

    expect(mention.items.value).toHaveLength(2);
    expect(mention.open.value).toBe(true);
  });
});

describe('useMentionMenu — complete (Tab)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('completes the highlighted name into the token, keeps the menu open and re-filters', async () => {
    const searchFiles = vi.fn().mockResolvedValue([{ path: 'Folder', name: 'Folder', kind: 'directory' as const }]);
    const { text, editor, mention } = setup('@fo', searchFiles);
    mention.update();
    await vi.advanceTimersByTimeAsync(0);
    expect(mention.open.value).toBe(true);
    mention.complete(mention.items.value[mention.active.value]!);
    expect(text.value).toBe('@Folder/');
    expect(mention.open.value).toBe(true);
    await nextTick();
    expect(editor.selectionStart).toBe('@Folder/'.length);
    await vi.advanceTimersByTimeAsync(0);
    expect(searchFiles).toHaveBeenLastCalledWith('Folder/', expect.anything());
  });

  it('completes a file without the trailing slash', async () => {
    const { text, mention } = setup('@fo');
    mention.complete({ kind: 'file', file: { path: 'Folder.ts', name: 'Folder.ts' } });
    await nextTick();
    expect(text.value).toBe('@Folder.ts');
  });

  it('replaces only the token\'s current path segment (typed directory prefix survives)', async () => {
    const { text, editor, mention } = setup('@src/fo');
    mention.complete({ kind: 'folder', file: { path: 'src/Folder', name: 'Folder', kind: 'directory' } });
    await nextTick();
    expect(text.value).toBe('@src/Folder/');
    expect(editor.selectionStart).toBe('@src/Folder/'.length);
  });

  it('strips a folder name\'s own trailing slash before appending one', async () => {
    const { text, mention } = setup('@fo');
    mention.complete({ kind: 'folder', file: { path: 'Folder/', name: 'Folder/' } });
    await nextTick();
    expect(text.value).toBe('@Folder/');
  });

  it('keeps text after the caret untouched', async () => {
    const { text, editor, mention } = setup('@fo bar');
    editor.selectionStart = 3;
    mention.complete({ kind: 'file', file: { path: 'Folder.ts', name: 'Folder.ts' } });
    await nextTick();
    expect(text.value).toBe('@Folder.ts bar');
    expect(editor.selectionStart).toBe('@Folder.ts'.length);
  });

  it('is a no-op when there is no @token', async () => {
    const { text, mention } = setup('hello');
    mention.complete({ kind: 'file', file: { path: 'src/a.ts', name: 'a.ts' } });
    await nextTick();
    expect(text.value).toBe('hello');
  });

  it('routes through completeMention with the row\'s full path and never closes the menu', async () => {
    const calls: Array<{ text: string; range: { start: number; end: number } }> = [];
    const searchFiles = vi.fn().mockResolvedValue([{ path: 'src/Folder', name: 'Folder', kind: 'directory' as const }]);
    const { text, mention } = setup('@src/fo', searchFiles, {
      completeMention: (completion, range) => calls.push({ text: completion, range }),
    });
    mention.update();
    await vi.advanceTimersByTimeAsync(0);
    expect(mention.open.value).toBe(true);
    mention.complete({ kind: 'folder', file: { path: 'src/Folder', name: 'Folder', kind: 'directory' } });
    expect(calls).toEqual([{ text: 'src/Folder/', range: { start: 1, end: 7 } }]);
    expect(text.value).toBe('@src/fo');
    expect(mention.open.value).toBe(true);
  });

  it('routes a skill completion through completeMention with the skill name', async () => {
    const calls: Array<{ text: string; range: { start: number; end: number } }> = [];
    const { mention } = setup('run @go', undefined, {
      completeMention: (completion, range) => calls.push({ text: completion, range }),
    });
    mention.complete({ kind: 'skill', skill: { name: 'goal', description: '', path: '/s/goal/SKILL.md', source: 'builtin' } });
    expect(calls).toEqual([{ text: 'goal', range: { start: 5, end: 7 } }]);
  });

  it('falls back to atomic pill insertion for names containing whitespace', () => {
    const calls: Array<{ entry: MentionEntry; range: { start: number; end: number } }> = [];
    const { text, mention } = setup('@My', undefined, {
      insertMention: (entry, range) => calls.push({ entry, range }),
    });

    mention.complete({
      kind: 'folder',
      file: { path: 'My Folder', name: 'My Folder', kind: 'directory' },
    });

    expect(text.value).toBe('@My');
    expect(calls).toEqual([{
      entry: { kind: 'folder', path: 'My Folder', name: 'My Folder' },
      range: { start: 0, end: 3 },
    }]);
    expect(mention.open.value).toBe(false);
  });

  it('falls back to atomic pill insertion for Markdown label delimiters', () => {
    const calls: Array<{ entry: MentionEntry; range: { start: number; end: number } }> = [];
    const { mention } = setup('@a', undefined, {
      insertMention: (entry, range) => calls.push({ entry, range }),
    });

    mention.complete({
      kind: 'file',
      file: { path: '[a](b).ts', name: '[a](b).ts' },
    });

    expect(calls).toEqual([{
      entry: { kind: 'file', path: '[a](b).ts', name: '[a](b).ts' },
      range: { start: 0, end: 2 },
    }]);
  });

  it('still falls back to a pill when the unsafe candidate is already fully typed', () => {
    const calls: Array<{ entry: MentionEntry; range: { start: number; end: number } }> = [];
    const { mention } = setup('@src\\foo', undefined, {
      insertMention: (entry, range) => calls.push({ entry, range }),
    });

    mention.complete({
      kind: 'file',
      file: { path: 'src\\foo', name: 'foo' },
    });

    expect(calls).toEqual([{
      entry: { kind: 'file', path: 'src\\foo', name: 'foo' },
      range: { start: 0, end: 8 },
    }]);
  });

  it('completes a safe deep candidate with the row\'s full path', () => {
    const calls: Array<{ text: string; range: { start: number; end: number } }> = [];
    const { mention } = setup('@src/comp', undefined, {
      completeMention: (text, range) => calls.push({ text, range }),
    });

    mention.complete({
      kind: 'file',
      file: { path: 'src/components/Button.vue', name: 'Button.vue' },
    });

    expect(calls).toEqual([{
      text: 'src/components/Button.vue',
      range: { start: 1, end: 9 },
    }]);
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
    expect(mention.open.value).toBe(true);
    expect(mention.skillItems.value.map((s) => s.skill.name)).toEqual(['goal', 'git-review', 'grammar']);
  });

  it('carries contiguous name-match positions for row highlighting', () => {
    const { mention } = setup('@rev', undefined, { skills: SKILLS });
    mention.update();
    const row = mention.items.value.find((item) => item.kind === 'skill' && item.skill.name === 'git-review');
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
    expect(mention.skillItems.value.map((s) => s.skill.name)).toEqual(['lark-im']);
    expect(mention.open.value).toBe(true);
    const row = mention.items.value[0];
    expect(row?.kind).toBe('skill');
    expect(row && row.kind === 'skill' && row.matchPositions).toEqual([0, 1, 2, 3, 5, 6]);
  });

  it('does not subsequence-match skills for short tokens', () => {
    const { mention } = setup('@lm', undefined, {
      skills: [{ name: 'lark-im', description: '', path: '/s/lark-im/SKILL.md', source: 'project' }],
    });
    mention.update();
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
    expect(mention.items.value.map((item) => (item.kind === 'skill' ? item.skill.name : item.file.name)))
      .toEqual(['g.ts', 'g2.ts']);
    mention.active.value = 1;
    skillsRef.value = SKILLS;
    await nextTick();
    expect(mention.items.value.map((item) => (item.kind === 'skill' ? item.skill.name : item.file.name)))
      .toEqual(['goal', 'git-review', 'grammar', 'g.ts', 'g2.ts']);
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
    expect(mention.items.value).toHaveLength(1);
    mention.navigate(0);
    resolvers[0]!([{ path: 'src/goal.ts', name: 'goal.ts' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mention.items.value.map((item) => (item.kind === 'skill' ? item.skill.name : item.file.name)))
      .toEqual(['goal.ts', 'x-goal']);
    const activeItem = mention.items.value[mention.active.value]!;
    expect(activeItem.kind === 'skill' && activeItem.skill.name).toBe('x-goal');
  });

  it('keeps the highlighted row when file results land under the new query', async () => {
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
    expect(mention.items.value.map((item) => (item.kind === 'skill' ? item.skill.name : item.file.name)))
      .toEqual(['a.ts', 'goal', 'z-goal']);

    text.value = '@goal';
    editor.value = '@goal';
    editor.selectionStart = 5;
    mention.update();
    expect(mention.items.value.map((item) => (item.kind === 'skill' ? item.skill.name : item.file.name)))
      .toEqual(['goal', 'z-goal']);
    mention.navigate(1);

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
    expect(row && row.kind === 'skill' && row.matchPositions).toEqual([0, 1, 2, 4, 5]);
  });

  it('maps match positions back to original coordinates when case-folding expands a character', () => {
    const { mention } = setup('@ab', undefined, {
      skills: [{ name: 'xİAB', description: '', path: '/s/exp/SKILL.md', source: 'project' }],
    });
    mention.update();
    const row = mention.items.value[0];
    expect(row?.kind).toBe('skill');
    expect(row && row.kind === 'skill' && row.matchPositions).toEqual([2, 3]);
  });

  it('counts the subsequence gate in code points, not UTF-16 units', () => {
    const { mention } = setup('@🍱a', undefined, {
      skills: [{ name: '🍱---a', description: '', path: '/s/gate/SKILL.md', source: 'project' }],
    });
    mention.update();
    expect(mention.skillItems.value).toEqual([]);
    expect(mention.open.value).toBe(false);
  });

  it('matches context-sensitive case mappings with whole-string lowering (final sigma)', () => {
    const { mention } = setup('@ος', undefined, {
      skills: [{ name: 'ΟΣ', description: '', path: '/s/sigma/SKILL.md', source: 'project' }],
    });
    mention.update();
    const row = mention.items.value[0];
    expect(row?.kind).toBe('skill');
    expect(row && row.kind === 'skill' && row.matchPositions).toEqual([0, 1]);
  });

  it('uses an in-place skill-list update on the next query derivation', () => {
    const skillsRef = ref<AppSkill[]>([SKILLS[0]!]);
    const { text, editor, mention } = setup('@g', undefined, { skills: skillsRef });
    mention.update();
    expect(mention.skillItems.value.map((s) => s.skill.name)).toEqual(['goal']);

    skillsRef.value.push(SKILLS[1]!);
    text.value = '@rev';
    editor.value = '@rev';
    editor.selectionStart = 4;
    mention.update();

    expect(mention.skillItems.value.map((s) => s.skill.name)).toEqual(['git-review']);
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
    expect(mention.open.value).toBe(true);
    expect(mention.skillItems.value).toEqual([]);
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
    expect(mention.open.value).toBe(true);
    expect(mention.loading.value).toBe(true);
    expect(mention.skillItems.value).toEqual([]);
    skillsRef.value = SKILLS;
    await nextTick();
    expect(mention.skillItems.value.map((s) => s.skill.name)).toEqual(['goal']);
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
    expect(calls).toEqual([{ kind: 'skill', name: 'goal', path: '/skills/goal/SKILL.md' }]);
  });

  it('does not fall back to text splicing when insertMention is present', () => {
    const { text, mention } = setup('hello @a', undefined, { insertMention: () => {} });
    mention.select({ kind: 'file', file: { path: 'src/a.ts', name: 'a.ts' } });
    expect(text.value).toBe('hello @a');
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
    expect(searchFiles).toHaveBeenCalledWith('a', expect.anything());
    expect(mention.open.value).toBe(true);
  });

  it('select replaces the full-width token (including the ＠)', () => {
    const calls: Array<{ entry: MentionEntry; range: { start: number; end: number } }> = [];
    const { mention } = setup('hi ＠a', undefined, {
      insertMention: (entry, range) => calls.push({ entry, range }),
    });
    mention.select({ kind: 'file', file: { path: 'src/a.ts', name: 'a.ts' } });
    expect(calls[0]).toEqual({
      entry: { kind: 'file', path: 'src/a.ts', name: 'a.ts' },
      range: { start: 3, end: 5 },
    });
  });
});

describe('useMentionMenu — @ typed directly after CJK text', () => {
  it.each([
    ['你好@a', 2],
    ['你好，@a', 3],
    ['こんにちは@a', 5],
    ['안녕@a', 2],
    ['hi 你好＠a', 5],
  ])('detects the token in %s', (input, start) => {
    const { mention } = setup(input);
    expect(mention.getToken()).toEqual({ token: 'a', start, end: input.length });
  });

  it.each(['abc@a', 'user@example.com', '邮箱foo@a', 'été@a'])('detects no token in %s', (input) => {
    const { mention } = setup(input);
    expect(mention.getToken()).toBeNull();
  });

  it('keeps a leading @ token whole when it contains CJK and another @', () => {
    const { mention } = setup('@文档@a');
    expect(mention.getToken()).toEqual({ token: '文档@a', start: 0, end: 5 });
  });

  it('select replaces only the @token, not the CJK text before it', () => {
    const calls: Array<{ entry: MentionEntry; range: { start: number; end: number } }> = [];
    const { mention } = setup('你好@a', undefined, {
      insertMention: (entry, range) => calls.push({ entry, range }),
    });
    mention.select({ kind: 'file', file: { path: 'src/a.ts', name: 'a.ts' } });
    expect(calls[0]?.range).toEqual({ start: 2, end: 4 });
  });
});

describe('useMentionMenu — dismiss (Esc)', () => {
  const skills: AppSkill[] = [{ name: 'goal', description: '', path: '/s/goal/SKILL.md', source: 'builtin' }];

  function type(ctx: ReturnType<typeof setup>, value: string): void {
    ctx.text.value = value;
    ctx.editor.value = value;
    ctx.editor.selectionStart = value.length;
    ctx.mention.update();
  }

  it('stays closed while the dismissed token keeps being edited', () => {
    const ctx = setup('@g', undefined, { skills });
    ctx.mention.update();
    expect(ctx.mention.open.value).toBe(true);
    ctx.mention.dismiss();
    expect(ctx.mention.open.value).toBe(false);
    type(ctx, '@go');
    expect(ctx.mention.open.value).toBe(false);
    type(ctx, '@g');
    expect(ctx.mention.open.value).toBe(false);
  });

  it('reopens once the @ is deleted and typed again', () => {
    const ctx = setup('@g', undefined, { skills });
    ctx.mention.update();
    ctx.mention.dismiss();
    type(ctx, '');
    type(ctx, '@g');
    expect(ctx.mention.open.value).toBe(true);
  });

  it('opens for a different @token', () => {
    const ctx = setup('@g', undefined, { skills });
    ctx.mention.update();
    ctx.mention.dismiss();
    type(ctx, '@g @go');
    expect(ctx.mention.open.value).toBe(true);
  });

  it('a plain close does not suppress the next keystroke', () => {
    const ctx = setup('@g', undefined, { skills });
    ctx.mention.update();
    ctx.mention.close();
    type(ctx, '@go');
    expect(ctx.mention.open.value).toBe(true);
  });
});

describe('useMentionMenu — sessions', () => {
  function session(id: string, title: string, workspaceName = 'app'): SessionMentionCandidate {
    return { id, workspaceId: 'wd_app_0123456789ab', title, workspaceName, time: '2h' };
  }

  const SESSIONS = [session('session_1', 'Fix login redirect'), session('session_2', 'Refactor parser')];

  function typeToken(target: ReturnType<typeof setup>, value: string): void {
    target.text.value = value;
    target.editor.value = value;
    target.editor.selectionStart = value.length;
    target.mention.update();
  }

  function kinds(items: readonly { kind: string }[]): string[] {
    return items.map((item) => item.kind);
  }

  it('shows the Sessions entry above project files on a bare @', async () => {
    const searchFiles = vi.fn().mockResolvedValue([{ path: 'src/a.ts', name: 'a.ts' }]);
    const { mention } = setup('@', searchFiles, { sessions: SESSIONS });
    mention.update();
    expect(kinds(mention.items.value)).toEqual(['session-group']);
    await Promise.resolve();
    await nextTick();
    expect(kinds(mention.items.value)).toEqual(['session-group', 'file']);
  });

  it('lists the Sessions entry after other results when the query matches a session', async () => {
    const searchFiles = vi.fn().mockResolvedValue([{ path: 'src/login.ts', name: 'login.ts' }]);
    const { mention } = setup('@login', searchFiles, { sessions: SESSIONS });
    mention.update();
    await Promise.resolve();
    await nextTick();
    expect(kinds(mention.items.value)).toEqual(['file', 'session-group']);
  });

  it('hides the Sessions entry when no session matches the query', () => {
    const { mention } = setup('@zzz', undefined, { sessions: SESSIONS });
    mention.update();
    expect(kinds(mention.items.value)).toEqual([]);
    expect(mention.open.value).toBe(false);
  });

  it('opens the session submenu from the entry and filters it by the query typed after @', async () => {
    const searchFiles = vi.fn().mockResolvedValue([{ path: 'src/a.ts', name: 'a.ts' }]);
    const target = setup('@', searchFiles, { sessions: SESSIONS });
    const { mention } = target;
    mention.update();
    await Promise.resolve();
    await nextTick();
    searchFiles.mockClear();

    mention.select(mention.items.value[0]!);
    expect(mention.sessionMenuOpen.value).toBe(true);
    expect(mention.open.value).toBe(true);
    expect(mention.items.value.map((item) => item.kind === 'session' && item.session.id)).toEqual(['session_1', 'session_2']);

    typeToken(target, '@log');
    expect(searchFiles).not.toHaveBeenCalled();
    expect(mention.items.value).toEqual([
      { kind: 'session', session: SESSIONS[0], matchPositions: [4, 5, 6] },
    ]);
  });

  it('keeps the submenu open without matches so the user can step back', () => {
    const target = setup('@', undefined, { sessions: SESSIONS });
    target.mention.update();
    target.mention.select({ kind: 'session-group' });
    typeToken(target, '@zzz');
    expect(target.mention.items.value).toEqual([]);
    expect(target.mention.open.value).toBe(true);
  });

  it('inserts the chosen session with its workspace-scoped path and closes the menu', () => {
    const calls: Array<{ entry: MentionEntry; range: { start: number; end: number } }> = [];
    const target = setup('see @', undefined, {
      sessions: SESSIONS,
      insertMention: (entry, range) => calls.push({ entry, range }),
    });
    target.mention.update();
    target.mention.select({ kind: 'session-group' });
    typeToken(target, 'see @fix');
    target.mention.select(target.mention.items.value[0]!);

    expect(calls).toEqual([{
      entry: { kind: 'session', name: 'Fix login redirect', path: 'wd_app_0123456789ab/session_1' },
      range: { start: 4, end: 8 },
    }]);
    expect(target.mention.open.value).toBe(false);
    expect(target.mention.sessionMenuOpen.value).toBe(false);
  });

  it('enters the submenu on Tab and returns to the root list on leaveSessionMenu', async () => {
    const searchFiles = vi.fn().mockResolvedValue([{ path: 'src/a.ts', name: 'a.ts' }]);
    const { mention } = setup('@', searchFiles, { sessions: SESSIONS });
    mention.update();
    mention.complete({ kind: 'session-group' });
    expect(mention.sessionMenuOpen.value).toBe(true);

    searchFiles.mockClear();
    mention.leaveSessionMenu();
    expect(mention.sessionMenuOpen.value).toBe(false);
    expect(searchFiles).toHaveBeenCalledWith('', expect.anything());
    await Promise.resolve();
    await nextTick();
    expect(kinds(mention.items.value)).toEqual(['session-group', 'file']);
  });

  it('resets the submenu when the menu closes', () => {
    const { mention } = setup('@', undefined, { sessions: SESSIONS });
    mention.update();
    mention.select({ kind: 'session-group' });
    mention.close();
    expect(mention.sessionMenuOpen.value).toBe(false);
    mention.update();
    expect(kinds(mention.items.value)).toEqual(['session-group']);
  });

  it('ranks title prefixes before title substrings and workspace-name matches', () => {
    const sessions = [
      session('session_a', 'Refactor login'),
      session('session_b', 'Login page'),
      session('session_c', 'Other work', 'login-service'),
    ];
    const { mention } = setup('@login', undefined, { sessions });
    mention.update();
    mention.select({ kind: 'session-group' });
    expect(mention.items.value.map((item) => item.kind === 'session' && item.session.id)).toEqual(['session_b', 'session_a', 'session_c']);
  });

  function sessionIds(items: readonly MentionItem[]): string[] {
    return items.flatMap((item) => (item.kind === 'session' ? [item.session.id] : []));
  }

  it('matches the last prompt and an exact session id, but not id fragments', () => {
    const sessions = [
      { ...session('session_a', 'Refactor parser'), lastPrompt: 'Look into the OAuth callback' },
      session('session_b', 'Fix login redirect'),
    ];
    const target = setup('@oauth', undefined, { sessions });
    target.mention.update();
    target.mention.select({ kind: 'session-group' });
    expect(sessionIds(target.mention.items.value)).toEqual(['session_a']);

    typeToken(target, '@SESSION_B');
    expect(sessionIds(target.mention.items.value)).toEqual(['session_b']);

    typeToken(target, '@sess');
    expect(target.mention.items.value).toEqual([]);
  });

  describe('server search', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('searches the server after a pause and ranks found sessions with the loaded ones', async () => {
      const searchSessions = vi.fn<SessionSearch>().mockResolvedValue([
        session('session_old', 'Login audit from last year'),
        session('session_1', 'Fix login redirect'),
      ]);
      const { mention } = setup('@login', undefined, { sessions: SESSIONS, searchSessions });
      mention.update();
      expect(searchSessions).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(150);
      expect(searchSessions).toHaveBeenCalledTimes(1);
      expect(searchSessions).toHaveBeenCalledWith('login', { signal: expect.any(AbortSignal) });

      mention.select({ kind: 'session-group' });
      expect(sessionIds(mention.items.value)).toEqual(['session_old', 'session_1']);
    });

    it('waits for typing to pause and ignores a superseded search', async () => {
      const calls: Array<{ query: string; signal: AbortSignal; resolve: (found: SessionMentionCandidate[]) => void }> = [];
      const searchSessions: SessionSearch = (query, { signal }) =>
        new Promise((resolve) => {
          calls.push({ query, signal, resolve });
        });
      const target = setup('@', undefined, { sessions: SESSIONS, searchSessions });
      target.mention.update();
      target.mention.select({ kind: 'session-group' });

      typeToken(target, '@a');
      await vi.advanceTimersByTimeAsync(100);
      typeToken(target, '@au');
      await vi.advanceTimersByTimeAsync(150);
      expect(calls.map((call) => call.query)).toEqual(['au']);

      typeToken(target, '@aud');
      expect(calls[0]!.signal.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(150);
      expect(calls.map((call) => call.query)).toEqual(['au', 'aud']);

      calls[0]!.resolve([session('session_stale', 'Audit stale')]);
      calls[1]!.resolve([session('session_audit', 'Audit trail')]);
      await vi.advanceTimersByTimeAsync(0);
      expect(sessionIds(target.mention.items.value)).toEqual(['session_audit']);
    });

    it('shows the submenu as loading while a search is pending and never searches a blank query', async () => {
      let resolve!: (found: SessionMentionCandidate[]) => void;
      const searchSessions = vi.fn<SessionSearch>(() => new Promise((done) => {
        resolve = done;
      }));
      const target = setup('@', undefined, { sessions: SESSIONS, searchSessions });
      target.mention.update();
      target.mention.select({ kind: 'session-group' });
      await vi.advanceTimersByTimeAsync(150);
      expect(searchSessions).not.toHaveBeenCalled();
      expect(target.mention.loading.value).toBe(false);

      typeToken(target, '@zz');
      expect(target.mention.loading.value).toBe(true);
      expect(target.mention.open.value).toBe(true);
      await vi.advanceTimersByTimeAsync(150);
      expect(target.mention.loading.value).toBe(true);

      resolve([]);
      await vi.advanceTimersByTimeAsync(0);
      expect(target.mention.loading.value).toBe(false);
      expect(target.mention.items.value).toEqual([]);
    });

    it('opens the menu for sessions found only on the server and drops them when it closes', async () => {
      const searchSessions = vi.fn<SessionSearch>().mockResolvedValue([session('session_old', 'Login audit')]);
      const target = setup('@login', undefined, { sessions: [], searchSessions });
      target.mention.update();
      expect(target.mention.open.value).toBe(false);

      await vi.advanceTimersByTimeAsync(150);
      expect(kinds(target.mention.items.value)).toEqual(['session-group']);
      expect(target.mention.open.value).toBe(true);

      target.mention.close();
      target.mention.update();
      expect(target.mention.items.value).toEqual([]);
    });
  });
});
