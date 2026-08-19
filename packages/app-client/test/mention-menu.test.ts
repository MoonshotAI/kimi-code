import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref, type Ref } from 'vue';
import type { FileItem } from '@moonshot-ai/app-core/client';
import type { AppSkill } from '@moonshot-ai/app-core/api';
import { useMentionMenu } from '../src/composables';
import type { TextFieldLike } from '@moonshot-ai/app-composer';

// The mention search fires immediately on the keystroke (no debounce), so it
// is always in flight when a close lands: blur / session switch / submit all
// close the menu, and that in-flight search must never reopen it afterwards.

interface MockEditor {
  selectionStart: number;
  setSelectionRange: (start: number, end: number) => void;
  focus: () => void;
}

function setup(initialText: string, search?: (q: string) => Promise<FileItem[]>, skills?: Ref<AppSkill[]>) {
  const editor: MockEditor = {
    // Caret sits at the end of the text, right after the @token.
    selectionStart: initialText.length,
    setSelectionRange(start: number) {
      this.selectionStart = start;
    },
    focus: () => {},
  };
  const text = ref(initialText);
  const editorRef = ref(editor as unknown as TextFieldLike) as Ref<TextFieldLike | null>;
  const mention = useMentionMenu({
    text,
    editorRef,
    searchFiles: () => search,
    skills: skills ? () => skills.value : undefined,
  });
  return { text, editor, mention };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useMentionMenu — close', () => {
  it('invalidates the immediately-fired search on close, so its late response never reopens', async () => {
    let resolveSearch: (items: FileItem[]) => void = () => {};
    const search = vi.fn(
      () =>
        new Promise<FileItem[]>((resolve) => {
          resolveSearch = resolve;
        }),
    );
    const { mention } = setup('@a', search);

    mention.update();
    // No debounce: the search fires on the keystroke itself.
    expect(search).toHaveBeenCalledTimes(1);

    // The composer blurred while the request was in flight.
    mention.close();
    resolveSearch([{ path: 'src/a.ts', name: 'a.ts' }]);
    await vi.advanceTimersByTimeAsync(0);

    expect(mention.open.value).toBe(false);
    expect(mention.loading.value).toBe(false);
    expect(mention.items.value).toEqual([]);
  });

  it('select invalidates the in-flight search too, so it never reopens', async () => {
    let resolveSearch: (items: FileItem[]) => void = () => {};
    const search = vi.fn(
      () =>
        new Promise<FileItem[]>((resolve) => {
          resolveSearch = resolve;
        }),
    );
    const { mention } = setup('@a', search);

    mention.update();
    expect(search).toHaveBeenCalledTimes(1);

    // A mouse pick on an instantly-opened row, before the response landed.
    // The token is replaced right away; the late response must not reopen
    // the menu (close() bumped the sequence, so its guard never passes).
    mention.select({ kind: 'file', file: { path: 'src/a.ts', name: 'a.ts' } });
    resolveSearch([{ path: 'src/a.ts', name: 'a.ts' }]);
    await vi.advanceTimersByTimeAsync(0);

    expect(mention.open.value).toBe(false);
    expect(mention.loading.value).toBe(false);
    expect(mention.items.value).toEqual([]);
  });

  it('drops an in-flight search result instead of applying it', async () => {
    let resolveSearch: (items: FileItem[]) => void = () => {};
    const search = vi.fn(
      () =>
        new Promise<FileItem[]>((resolve) => {
          resolveSearch = resolve;
        }),
    );
    const { mention } = setup('@a', search);

    mention.update();
    // The search fired on the keystroke: menu open, request in flight.
    expect(mention.open.value).toBe(true);
    expect(mention.loading.value).toBe(true);

    mention.close();
    expect(mention.open.value).toBe(false);
    expect(mention.loading.value).toBe(false);

    resolveSearch([{ path: 'src/a.ts', name: 'a.ts' }]);
    await vi.advanceTimersByTimeAsync(0);

    expect(mention.open.value).toBe(false);
    expect(mention.items.value).toEqual([]);
  });

  it('still opens and loads results when left alone', async () => {
    const search = vi.fn(async (): Promise<FileItem[]> => [{ path: 'src/a.ts', name: 'a.ts' }]);
    const { mention } = setup('@a', search);

    mention.update();
    await vi.advanceTimersByTimeAsync(300);

    expect(mention.open.value).toBe(true);
    expect(mention.loading.value).toBe(false);
    expect(mention.items.value).toEqual([{ kind: 'file', file: { path: 'src/a.ts', name: 'a.ts' } }]);
  });

  it('drops cached candidates on close so an identical re-query re-searches (workspace switch)', async () => {
    // Workspace A's '@foo' already has results on screen.
    const search = vi.fn(async (): Promise<FileItem[]> => [{ path: 'old-ws/a.ts', name: 'a.ts' }]);
    const { mention } = setup('@foo', search);
    mention.update();
    await vi.advanceTimersByTimeAsync(250);
    expect(mention.fileItems.value).toHaveLength(1);

    // The session/workspace switch closes the menu; its candidates must go
    // with it — they are paths from the OLD workspace.
    mention.close();
    expect(mention.fileItems.value).toEqual([]);

    // The identical '@foo' typed in workspace B must re-search, not re-show
    // A's rows as fresh, selectable results.
    mention.update();
    await vi.advanceTimersByTimeAsync(250);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('invalidates an in-flight search across a close + identical re-query', async () => {
    const resolvers: Array<(items: FileItem[]) => void> = [];
    const search = vi.fn(
      () =>
        new Promise<FileItem[]>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const { mention } = setup('@foo', search);

    // Workspace A: search fires and stays in flight.
    mention.update();
    await vi.advanceTimersByTimeAsync(250);
    expect(mention.loading.value).toBe(true);

    // Switch workspace (close), then type the identical '@foo' again: a new
    // search fires while A's request is still pending.
    mention.close();
    mention.update();
    await vi.advanceTimersByTimeAsync(250);
    expect(search).toHaveBeenCalledTimes(2);

    // A's late response must not pass the token/sequence guard — its rows
    // belong to another workspace's tree.
    resolvers[0]!([{ path: 'old-ws/a.ts', name: 'a.ts' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mention.fileItems.value).toEqual([]);

    // …while the NEW workspace's own response applies normally.
    resolvers[1]!([{ path: 'new-ws/b.ts', name: 'b.ts' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mention.fileItems.value).toEqual([{ path: 'new-ws/b.ts', name: 'b.ts' }]);
  });
});

describe('useMentionMenu — the default highlight is the top row of the merged ranking', () => {
  it('a prefix skill hit legitimately owns the top row over a strong file hit', async () => {
    // The '@a' scenario: a skill matches locally at keystroke time, and in
    // the merged ranking a prefix skill hit outranks a strong file hit.
    const skillList = ref<AppSkill[]>([{ name: 'a-skill', description: '' } as AppSkill]);
    const search = vi.fn(async (): Promise<FileItem[]> => [{ path: 'apps', name: 'apps', kind: 'directory' } as FileItem]);
    const { mention } = setup('@a', search, skillList);

    mention.update();
    await vi.advanceTimersByTimeAsync(0);
    expect(mention.items.value.map((item) => (item.kind === 'skill' ? item.skill.name : item.file.name)))
      .toEqual(['a-skill', 'apps']);
    // The default highlight simply sits on the top row, skill band included.
    expect(mention.active.value).toBe(0);
    expect(mention.items.value[0]?.kind).toBe('skill');
  });

  it('the highlight follows its row identity when fresh file results land', async () => {
    const skillList = ref<AppSkill[]>([]);
    const search = vi.fn(async (): Promise<FileItem[]> => [{ path: 'src/foo.ts', name: 'foo.ts' }]);
    const { text, editor, mention } = setup('@fo', search, skillList);

    mention.update();
    await vi.advanceTimersByTimeAsync(0);
    expect(mention.fileItems.value).toHaveLength(1);

    // The query changes: the file rows go stale and the highlight resets to
    // the top row (a new intent).
    text.value = '@foo';
    editor.selectionStart = 4;
    mention.update();
    expect(mention.fileStale.value).toBe(true);
    expect(mention.active.value).toBe(0);

    // A prefix skill arriving mid-window takes the top band legitimately…
    skillList.value = [{ name: 'foo-skill', description: '' } as AppSkill];
    await nextTick();
    expect(mention.items.value[0]?.kind).toBe('skill');

    // …and when the fresh file results land, the highlight follows the row it
    // was on (the skill) instead of being reclaimed by the file hits.
    await vi.advanceTimersByTimeAsync(0);
    expect(mention.fileStale.value).toBe(false);
    expect(mention.items.value[mention.active.value]?.kind).toBe('skill');
  });
});
