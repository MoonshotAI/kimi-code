import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref, type Ref } from 'vue';
import type { FileItem } from '@moonshot-ai/app-core/client';
import type { AppSkill } from '@moonshot-ai/app-core/api';
import { useMentionMenu } from '../src/composables';
import type { TextFieldLike } from '@moonshot-ai/app-composer';

// The debounced mention search must not outlive a close: blur / session
// switch / submit all close the menu, and a pending (or in-flight) search
// must never reopen it afterwards.

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
  it('cancels a pending debounced search so the menu never opens', async () => {
    const search = vi.fn(async (): Promise<FileItem[]> => [{ path: 'src/a.ts', name: 'a.ts' }]);
    const { mention } = setup('@a', search);

    mention.update();
    // Close inside the 200ms debounce window (e.g. the composer blurred).
    mention.close();
    await vi.advanceTimersByTimeAsync(300);

    expect(mention.open.value).toBe(false);
    expect(mention.loading.value).toBe(false);
    expect(search).not.toHaveBeenCalled();
  });

  it('select cancels a pending debounced search too, so it never reopens', async () => {
    const search = vi.fn(async (): Promise<FileItem[]> => [{ path: 'src/a.ts', name: 'a.ts' }]);
    const { mention } = setup('@a', search);

    mention.update();
    // Select inside the 200ms debounce window (a mouse pick on an
    // instantly-opened row). The token is replaced right away.
    mention.select({ kind: 'file', file: { path: 'src/a.ts', name: 'a.ts' } });
    await vi.advanceTimersByTimeAsync(300);

    // Without the cancel the timer would fire now, reopen the menu and latch
    // loading on (the token is gone, so its stillCurrent guard never passes).
    expect(mention.open.value).toBe(false);
    expect(mention.loading.value).toBe(false);
    expect(search).not.toHaveBeenCalled();
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
    await vi.advanceTimersByTimeAsync(250);
    // The debounce fired: menu open, search in flight.
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

describe('useMentionMenu — the highlight never auto-moves to a skill', () => {
  it('keeps the highlight on the file section even when skills match instantly', async () => {
    // The '@a' scenario: a skill matches locally at keystroke time, but the
    // default highlight must wait for real file hits, not sit on the skill.
    const skillList = ref<AppSkill[]>([{ name: 'a-skill', description: '' } as AppSkill]);
    const search = vi.fn(async (): Promise<FileItem[]> => [{ path: 'apps', name: 'apps', kind: 'directory' } as FileItem]);
    const { mention } = setup('@a', search, skillList);

    mention.update();
    expect(mention.skillItems.value).toHaveLength(1);
    expect(mention.active.value).toBe(0);

    // Fresh results land: the first real file row owns the highlight — the
    // skill's instant availability never earns the default.
    await vi.advanceTimersByTimeAsync(250);
    expect(mention.fileItems.value[0]?.path).toBe('apps');
    expect(mention.items.value[mention.active.value]).toEqual({ kind: 'folder', file: { path: 'apps', name: 'apps', kind: 'directory' } });
  });

  it('does not let an asynchronously-landing skill capture the highlight during the stale window', async () => {
    const skillList = ref<AppSkill[]>([]);
    const search = vi.fn(async (): Promise<FileItem[]> => [{ path: 'src/foo.ts', name: 'foo.ts' }]);
    const { text, editor, mention } = setup('@fo', search, skillList);

    mention.update();
    await vi.advanceTimersByTimeAsync(250);
    expect(mention.fileItems.value).toHaveLength(1);

    // The query changes: the file rows go stale; the highlight stays on the
    // (dimmed, briefly unselectable) stale row rather than jumping to a skill.
    text.value = '@foo';
    editor.selectionStart = 4;
    mention.update();
    expect(mention.fileStale.value).toBe(true);
    expect(mention.active.value).toBe(0);

    // A skill arriving mid-window must not capture the highlight…
    skillList.value = [{ name: 'foo-skill', description: '' } as AppSkill];
    await nextTick();
    expect(mention.active.value).toBe(0);

    // …and when the fresh file results land, the first fresh file row takes it.
    await vi.advanceTimersByTimeAsync(250);
    expect(mention.fileStale.value).toBe(false);
    expect(mention.items.value[mention.active.value]?.kind).not.toBe('skill');
  });
});
