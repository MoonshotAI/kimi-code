import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref, type Ref } from 'vue';
import type { FileItem } from '@moonshot-ai/app-core/client';
import type { AppSkill } from '@moonshot-ai/app-core/api';
import { useMentionMenu, type FileSearch } from '../src/composables';
import type { TextFieldLike } from '@moonshot-ai/app-composer/runtime';

interface MockEditor {
  selectionStart: number;
  setSelectionRange: (start: number, end: number) => void;
  focus: () => void;
}

function setup(initialText: string, search?: FileSearch, skills?: Ref<AppSkill[]>) {
  const editor: MockEditor = {
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
    expect(search).toHaveBeenCalledTimes(1);

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
    const search = vi.fn(async (): Promise<FileItem[]> => [{ path: 'old-ws/a.ts', name: 'a.ts' }]);
    const { mention } = setup('@foo', search);
    mention.update();
    await vi.advanceTimersByTimeAsync(250);
    expect(mention.fileItems.value).toHaveLength(1);

    mention.close();
    expect(mention.fileItems.value).toEqual([]);

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

    mention.update();
    await vi.advanceTimersByTimeAsync(250);
    expect(mention.loading.value).toBe(true);

    mention.close();
    mention.update();
    await vi.advanceTimersByTimeAsync(250);
    expect(search).toHaveBeenCalledTimes(2);

    resolvers[0]!([{ path: 'old-ws/a.ts', name: 'a.ts' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mention.fileItems.value).toEqual([]);

    resolvers[1]!([{ path: 'new-ws/b.ts', name: 'b.ts' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mention.fileItems.value).toEqual([{ path: 'new-ws/b.ts', name: 'b.ts' }]);
  });
});

describe('useMentionMenu — the default highlight is the top row of the merged ranking', () => {
  it('a prefix skill hit legitimately owns the top row over a strong file hit', async () => {
    const skillList = ref<AppSkill[]>([{ name: 'a-skill', description: '' } as AppSkill]);
    const search = vi.fn(async (): Promise<FileItem[]> => [{ path: 'apps', name: 'apps', kind: 'directory' } as FileItem]);
    const { mention } = setup('@a', search, skillList);

    mention.update();
    await vi.advanceTimersByTimeAsync(0);
    expect(mention.items.value.map((item) => (item.kind === 'skill' ? item.skill.name : item.file.name)))
      .toEqual(['a-skill', 'apps']);
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

    text.value = '@foo';
    editor.selectionStart = 4;
    mention.update();
    expect(mention.fileStale.value).toBe(true);
    expect(mention.active.value).toBe(0);

    skillList.value = [{ name: 'foo-skill', description: '' } as AppSkill];
    await nextTick();
    expect(mention.items.value[0]?.kind).toBe('skill');

    await vi.advanceTimersByTimeAsync(0);
    expect(mention.fileStale.value).toBe(false);
    expect(mention.items.value[mention.active.value]?.kind).toBe('skill');
  });
});
