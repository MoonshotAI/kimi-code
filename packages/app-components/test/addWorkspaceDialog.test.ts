// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import {
  DaemonApiError,
  FS_ALREADY_EXISTS_CODE,
  FS_PATH_NOT_FOUND_CODE,
  FS_PERMISSION_DENIED_CODE,
  FS_VALIDATION_FAILED_CODE,
  type FsBrowseResult,
} from '@moonshot-ai/app-core/api';
import AddWorkspaceDialog from '../src/dialogs/AddWorkspaceDialog.vue';

let app: App | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
  document.body.innerHTML = '';
});

const homeBrowse: FsBrowseResult = {
  path: '/home',
  parent: '/',
  entries: [
    { name: 'alpha', path: '/home/alpha', isDir: true },
    { name: 'beta', path: '/home/beta', isDir: true },
    { name: 'notes.md', path: '/home/notes.md', isDir: false },
  ],
};

async function browse(path?: string): Promise<FsBrowseResult> {
  if (path === undefined || path === '/home') return homeBrowse;
  return { path, parent: '/home', entries: [] };
}

function mountDialog(opts: {
  multiple?: boolean;
  defaultPath?: string;
  hostId?: string;
  locale?: 'en' | 'zh';
  browseFs?: (path: string | undefined, signal: AbortSignal) => Promise<FsBrowseResult>;
  searchFs?: (root: string, query: string, signal: AbortSignal) => Promise<{ path: string; label: string }[]>;
  getFsHome?: () => Promise<{ home: string; recentRoots: string[] }>;
  mkdirFs?: (path: string) => Promise<{ path: string }>;
} = {}) {
  const add = vi.fn();
  const addMany = vi.fn();
  const close = vi.fn();
  app = createApp({
    render: () =>
      h(AddWorkspaceDialog, {
        browseFs: opts.browseFs ?? browse,
        searchFs: opts.searchFs ?? (async () => []),
        getFsHome: opts.getFsHome ?? (async () => ({ home: '/home', recentRoots: [] })),
        mkdirFs: opts.mkdirFs,
        defaultPath: opts.defaultPath,
        hostId: opts.hostId,
        multiple: opts.multiple,
        onAdd: add,
        onAddMany: addMany,
        onClose: close,
      }),
  });
  app.use(createKimiI18n({ locale: opts.locale ?? 'en' }));
  app.mount(host);
  return { add, addMany, close };
}

async function settled(): Promise<void> {
  for (let i = 0; i < 6; i++) await nextTick();
}

function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.folder-row')];
}

function checkboxes(): HTMLInputElement[] {
  return [...document.querySelectorAll<HTMLInputElement>('.folder-row .ui-check__input')];
}

function primaryAction(): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>('.actions .ui-button--primary');
  expect(el).not.toBeNull();
  return el!;
}

describe('AddWorkspaceDialog multi-select mode', () => {
  it('shows checkboxes and emits addMany with the toggled paths', async () => {
    const { addMany } = mountDialog({ multiple: true });
    await settled();

    expect(checkboxes()).toHaveLength(2);
    expect(rows()).toHaveLength(2);
    expect(document.querySelectorAll('.pathbar input')).toHaveLength(1);
    expect(document.querySelector('.filter-input')).toBeNull();
    expect(primaryAction().disabled).toBe(true);
    const input = document.querySelector<HTMLInputElement>('.pathbar input')!;
    input.dispatchEvent(new FocusEvent('focus'));
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);

    checkboxes()[0]!.click();
    checkboxes()[1]!.click();
    await nextTick();
    expect(primaryAction().disabled).toBe(false);
    expect(primaryAction().textContent).toContain('2');

    primaryAction().click();
    await nextTick();
    expect(addMany).toHaveBeenCalledWith(['/home/alpha', '/home/beta']);
  });

  it('untoggling a row removes it from the selection', async () => {
    const { addMany } = mountDialog({ multiple: true });
    await settled();

    checkboxes()[0]!.click();
    checkboxes()[1]!.click();
    checkboxes()[0]!.click();
    await nextTick();

    primaryAction().click();
    await nextTick();
    expect(addMany).toHaveBeenCalledWith(['/home/beta']);
  });

  it('collects a typed absolute path without expanding another input', async () => {
    mountDialog({ multiple: true });
    await settled();

    const input = document.querySelector<HTMLInputElement>('.pathbar input')!;
    expect(input).not.toBeNull();
    input.value = '/tmp/pasted';
    input.dispatchEvent(new Event('input'));
    await nextTick();
    document.querySelector<HTMLButtonElement>('.path-add')!.click();
    await nextTick();

    expect(primaryAction().disabled).toBe(false);
    expect(primaryAction().textContent).toContain('1');
  });

  it('filters sibling folders while typing and opens the active suggestion with the keyboard', async () => {
    vi.useFakeTimers();
    try {
      const { add } = mountDialog();
      await settled();
      const input = document.querySelector<HTMLInputElement>('.pathbar input')!;
      input.value = '/home/';
      input.dispatchEvent(new Event('input'));
      await nextTick();
      await vi.advanceTimersByTimeAsync(170);
      await settled();
      expect(rows().map((row) => row.textContent)).toEqual(['alpha', 'beta']);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      await nextTick();
      expect(input.getAttribute('aria-activedescendant')).toMatch(/-1$/);

      input.value = '/home/a';
      input.dispatchEvent(new Event('input'));
      await nextTick();
      await vi.advanceTimersByTimeAsync(170);
      await settled();

      expect(rows().map((row) => row.textContent)).toEqual(['alpha']);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      await nextTick();
      expect(input.getAttribute('aria-activedescendant')).toMatch(/-0$/);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await settled();

      expect(input.value).toBe('/home/alpha');
      expect(add).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('adds a typed absolute path on Enter when no suggestion is active', async () => {
    const { add } = mountDialog();
    await settled();
    const input = document.querySelector<HTMLInputElement>('.pathbar input')!;
    input.value = '/tmp/pasted';
    input.dispatchEvent(new Event('input'));
    await nextTick();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await nextTick();

    expect(add).toHaveBeenCalledWith('/tmp/pasted');
  });

  it('allows selecting the current empty folder in multi mode', async () => {
    const { addMany } = mountDialog({ multiple: true, defaultPath: '/home/alpha' });
    await settled();

    expect(document.querySelector('.fl-empty')).not.toBeNull();
    const selectCurrent = document.querySelector<HTMLButtonElement>('.actions .ui-button--secondary:last-child')!;
    expect(selectCurrent.textContent).toContain('Select this folder');
    selectCurrent.click();
    await nextTick();

    expect(primaryAction().disabled).toBe(false);
    primaryAction().click();
    await nextTick();
    expect(addMany).toHaveBeenCalledWith(['/home/alpha']);
  });

  it('keeps single mode unchanged: no checkboxes, open-this-folder emits add', async () => {
    const { add } = mountDialog();
    await settled();

    expect(checkboxes()).toHaveLength(0);
    primaryAction().click();
    await nextTick();
    expect(add).toHaveBeenCalledWith('/home');
  });
});

describe('AddWorkspaceDialog remote browsing', () => {
  it('keeps browse failures in the remote context and retries there', async () => {
    const browseFs = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ path: '/srv', parent: '/', entries: [] });
    const getFsHome = vi.fn(async () => ({ home: '/home', recentRoots: [] }));
    mountDialog({ hostId: 'devbox', defaultPath: '/srv', browseFs, getFsHome });
    await settled();

    expect(getFsHome).not.toHaveBeenCalled();
    expect(document.querySelector('.browse-error')).not.toBeNull();
    expect(document.querySelector('.browse-error-detail')?.textContent).toBe('offline');
    expect(document.querySelector<HTMLInputElement>('.pathbar input')?.value).toBe('/srv');
    document.querySelector<HTMLButtonElement>('.browse-error .ui-button')!.click();
    await settled();

    expect(browseFs).toHaveBeenLastCalledWith('/srv', expect.any(AbortSignal));
    expect(getFsHome).not.toHaveBeenCalled();
    expect(document.querySelector('.browse-error')).toBeNull();
  });

  it('opens the remote home directory when no default path is configured', async () => {
    const browseFs = vi.fn(browse);
    const getFsHome = vi.fn(async () => ({ home: '/home', recentRoots: [] }));
    mountDialog({ hostId: 'devbox', defaultPath: '', browseFs, getFsHome });
    await settled();

    expect(browseFs).toHaveBeenCalledExactlyOnceWith(undefined, expect.any(AbortSignal));
    expect(getFsHome).not.toHaveBeenCalled();
    expect(document.querySelector('.browse-error')).toBeNull();
    expect(document.querySelector<HTMLInputElement>('.pathbar input')?.value).toBe('/home');
    expect(rows().map((row) => row.textContent)).toEqual(['alpha', 'beta']);
  });

  it.each([
    {
      input: 'C:\\Users\\alice\\pro',
      home: 'C:\\Users\\alice',
      parent: 'C:\\Users\\alice',
      project: 'C:\\Users\\alice\\project',
    },
    {
      input: 'C:/Users/alice/pro',
      home: 'C:/Users/alice',
      parent: 'C:/Users/alice',
      project: 'C:/Users/alice/project',
    },
    {
      input: 'C:\\Users/alice\\pro',
      home: 'C:\\Users\\alice',
      parent: 'C:\\Users/alice',
      project: 'C:\\Users/alice\\project',
    },
    {
      input: '\\\\server\\share\\pro',
      home: '\\\\server\\share',
      parent: '\\\\server\\share',
      project: '\\\\server\\share\\project',
    },
  ])('completes the Windows path $input without treating it as a search', async ({ input, home, parent, project }) => {
    vi.useFakeTimers();
    try {
      const searchFs = vi.fn(async () => []);
      const browseFs = vi.fn(async (path?: string): Promise<FsBrowseResult> => ({
        path: path ?? home,
        parent: 'C:\\',
        entries: [{ name: 'project', path: project, isDir: true }],
      }));
      const { add } = mountDialog({ hostId: 'devbox', browseFs, searchFs });
      await settled();
      const field = document.querySelector<HTMLInputElement>('.pathbar input')!;
      field.value = input;
      field.dispatchEvent(new Event('input'));
      await nextTick();

      expect(primaryAction().disabled).toBe(true);
      await vi.advanceTimersByTimeAsync(170);
      await settled();
      expect(searchFs).not.toHaveBeenCalled();
      expect(browseFs).toHaveBeenLastCalledWith(parent, expect.any(AbortSignal));
      expect(rows().map((row) => row.textContent)).toEqual(['project']);
      expect(primaryAction().disabled).toBe(true);

      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await settled();
      expect(field.value).toBe(project);
      expect(add).not.toHaveBeenCalled();
      expect(primaryAction().disabled).toBe(false);

      primaryAction().click();
      expect(add).toHaveBeenCalledExactlyOnceWith(project);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AddWorkspaceDialog navigation state', () => {
  it('ignores an older directory response that finishes after the latest one', async () => {
    let finishAlpha!: (result: FsBrowseResult) => void;
    const browseFs = vi.fn(async (path?: string): Promise<FsBrowseResult> => {
      if (path === undefined || path === '/home') return homeBrowse;
      if (path === '/home/alpha') {
        return new Promise<FsBrowseResult>((resolve) => {
          finishAlpha = resolve;
        });
      }
      return { path: path!, parent: '/home', entries: [] };
    });
    mountDialog({ browseFs });
    await settled();

    const openButtons = rows().map((row) => row.querySelector<HTMLButtonElement>('.folder-open')!);
    openButtons[0]!.click();
    openButtons[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(finishAlpha).toBeTypeOf('function'));
    await settled();
    finishAlpha({ path: '/home/alpha', parent: '/home', entries: [] });
    await settled();

    expect(document.querySelector<HTMLInputElement>('.pathbar input')?.value).toBe('/home/beta');
  });

  it('aborts navigation superseded by a text search', async () => {
    let signal: AbortSignal | undefined;
    const browseFs = vi.fn(async (_path: string | undefined, requestSignal: AbortSignal): Promise<FsBrowseResult> => {
      if (requestSignal.aborted) throw new DOMException('Aborted', 'AbortError');
      signal = requestSignal;
      return new Promise<FsBrowseResult>(() => {});
    });
    mountDialog({ defaultPath: '/home', browseFs });
    await settled();
    const input = document.querySelector<HTMLInputElement>('.pathbar input')!;
    input.value = 'alpha';
    input.dispatchEvent(new Event('input'));
    await nextTick();

    expect(signal?.aborted).toBe(true);
  });

  it('searches once and retries a failed search', async () => {
    vi.useFakeTimers();
    try {
      const searchFs = vi.fn()
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValue([{ path: '/home/alpha/nested', label: 'alpha/nested' }]);
      mountDialog({ searchFs });
      await settled();
      const input = document.querySelector<HTMLInputElement>('.pathbar input')!;
      input.value = 'nested';
      input.dispatchEvent(new Event('input'));
      await vi.advanceTimersByTimeAsync(230);
      await settled();

      expect(searchFs).toHaveBeenCalledExactlyOnceWith('/home', 'nested', expect.any(AbortSignal));
      expect(document.querySelector('.search-error')).not.toBeNull();
      document.querySelector<HTMLButtonElement>('.search-error .ui-button')!.click();
      await settled();
      expect(searchFs).toHaveBeenCalledTimes(2);
      expect(rows().map((row) => row.textContent)).toEqual(['alpha/nested']);
      expect(document.querySelector('.search-error')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts a superseded search when the query changes and on unmount', async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      const searchFs = vi.fn(async (_root: string, _query: string, signal: AbortSignal) => {
        signals.push(signal);
        return new Promise<{ path: string; label: string }[]>(() => {});
      });
      mountDialog({ searchFs });
      await settled();
      const input = document.querySelector<HTMLInputElement>('.pathbar input')!;
      input.value = 'alpha';
      input.dispatchEvent(new Event('input'));
      await vi.advanceTimersByTimeAsync(230);
      input.value = 'beta';
      input.dispatchEvent(new Event('input'));
      await vi.advanceTimersByTimeAsync(230);

      expect(signals).toHaveLength(2);
      expect(signals[0]!.aborted).toBe(true);
      expect(signals[1]!.aborted).toBe(false);
      app?.unmount();
      app = null;
      expect(signals[1]!.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AddWorkspaceDialog new folder creation', () => {
  it('omits the new folder button when mkdirFs is not provided', async () => {
    mountDialog({ multiple: true });
    await settled();

    expect(document.querySelector('.new-folder-trigger')).toBeNull();
  });

  it('creates a folder in the current directory, enters it, and allows adding it in multi mode', async () => {
    let resolveMkdir!: (res: { path: string }) => void;
    const mkdirFs = vi.fn(
      () =>
        new Promise<{ path: string }>((resolve) => {
          resolveMkdir = resolve;
        }),
    );
    const browseFs = vi.fn(async (path?: string): Promise<FsBrowseResult> => {
      if (path === undefined || path === '/home') return homeBrowse;
      return { path, parent: '/home', entries: [] };
    });
    const { addMany } = mountDialog({ multiple: true, browseFs, mkdirFs });
    await settled();

    expect(document.querySelector('.ui-dialog__close')).not.toBeNull();
    const trigger = document.querySelector<HTMLButtonElement>('.new-folder-trigger')!;
    expect(trigger).not.toBeNull();
    expect(trigger.textContent).toContain('New folder');
    trigger.click();
    await settled();

    const input = document.querySelector<HTMLInputElement>('.createbar input')!;
    expect(input).not.toBeNull();
    input.value = '  gamma  ';
    input.dispatchEvent(new Event('input'));
    await nextTick();

    document.querySelector<HTMLButtonElement>('.new-folder-submit')!.click();
    await nextTick();
    expect(document.querySelector('.ui-dialog__close')).toBeNull();

    resolveMkdir({ path: '/home/gamma' });
    await settled();
    expect(document.querySelector('.ui-dialog__close')).not.toBeNull();

    expect(mkdirFs).toHaveBeenCalledWith('/home/gamma');
    expect(browseFs).toHaveBeenLastCalledWith('/home/gamma', expect.any(AbortSignal));
    expect(document.querySelector('.createbar')).toBeNull();
    expect(document.querySelector<HTMLInputElement>('.pathbar input')?.value).toBe('/home/gamma');

    const selectCurrent = document.querySelector<HTMLButtonElement>('.actions .ui-button--secondary:last-child')!;
    selectCurrent.click();
    await nextTick();
    primaryAction().click();
    await nextTick();
    expect(addMany).toHaveBeenCalledWith(['/home/gamma']);
  });

  it('submits on Enter, respects IME composition, and cancels on Escape without closing the dialog', async () => {
    vi.useFakeTimers();
    try {
      const mkdirFs = vi.fn(async (path: string) => ({ path }));
      const { close } = mountDialog({ multiple: true, mkdirFs });
      await settled();

      document.querySelector<HTMLButtonElement>('.new-folder-trigger')!.click();
      await settled();

      const input = document.querySelector<HTMLInputElement>('.createbar input')!;
      input.value = 'ime-folder';
      input.dispatchEvent(new Event('input'));
      input.dispatchEvent(new CompositionEvent('compositionstart'));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await settled();
      expect(mkdirFs).not.toHaveBeenCalled();

      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await settled();
      expect(document.querySelector('.createbar')).not.toBeNull();
      expect(close).not.toHaveBeenCalled();

      input.dispatchEvent(new CompositionEvent('compositionend'));
      vi.advanceTimersByTime(150);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await settled();
      expect(document.querySelector('.createbar')).toBeNull();
      expect(close).not.toHaveBeenCalled();

      document.querySelector<HTMLButtonElement>('.new-folder-trigger')!.click();
      await settled();
      const reopenedInput = document.querySelector<HTMLInputElement>('.createbar input')!;
      reopenedInput.value = 'enter-folder';
      reopenedInput.dispatchEvent(new Event('input'));
      reopenedInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await settled();
      expect(mkdirFs).toHaveBeenCalledWith('/home/enter-folder');
    } finally {
      vi.useRealTimers();
    }
  });

  it('validates empty and invalid folder names and clears the error when typing', async () => {
    const mkdirFs = vi.fn(async (path: string) => ({ path }));
    mountDialog({ multiple: true, mkdirFs, locale: 'zh' });
    await settled();

    document.querySelector<HTMLButtonElement>('.new-folder-trigger')!.click();
    await settled();

    const submit = document.querySelector<HTMLButtonElement>('.new-folder-submit')!;
    submit.click();
    await settled();
    expect(mkdirFs).not.toHaveBeenCalled();
    expect(document.querySelector('.create-error')?.textContent).toBe('请输入文件夹名称');

    const input = document.querySelector<HTMLInputElement>('.createbar input')!;
    input.value = 'nested/folder';
    input.dispatchEvent(new Event('input'));
    await nextTick();
    expect(document.querySelector('.create-error')).toBeNull();

    submit.click();
    await settled();
    expect(mkdirFs).not.toHaveBeenCalled();
    expect(document.querySelector('.create-error')?.textContent).toBe('文件夹名称无效，请更换名称');

    for (const bad of ['.', '..', 'a\\b']) {
      input.value = bad;
      input.dispatchEvent(new Event('input'));
      await nextTick();
      submit.click();
      await settled();
      expect(mkdirFs).not.toHaveBeenCalled();
      expect(document.querySelector('.create-error')?.textContent).toBe('文件夹名称无效，请更换名称');
    }
  });

  it('joins POSIX root and Windows paths and validates Windows-specific folder names', async () => {
    const mkdirFs = vi.fn(async (path: string) => ({ path }));
    const browseRoot = vi.fn(async (path?: string): Promise<FsBrowseResult> => ({
      path: path ?? '/',
      parent: path && path !== '/' ? '/' : null,
      entries: [],
    }));
    mountDialog({ defaultPath: '/', browseFs: browseRoot, mkdirFs });
    await settled();

    document.querySelector<HTMLButtonElement>('.new-folder-trigger')!.click();
    await settled();
    let input = document.querySelector<HTMLInputElement>('.createbar input')!;
    input.value = 'opt-app';
    input.dispatchEvent(new Event('input'));
    document.querySelector<HTMLButtonElement>('.new-folder-submit')!.click();
    await settled();
    expect(mkdirFs).toHaveBeenCalledWith('/opt-app');

    app?.unmount();
    app = null;
    document.body.innerHTML = '';
    host = document.createElement('div');
    document.body.append(host);

    const browseWin = vi.fn(async (path?: string): Promise<FsBrowseResult> => ({
      path: path ?? 'C:\\Users\\demo',
      parent: 'C:\\Users',
      entries: [],
    }));
    mountDialog({ defaultPath: 'C:\\Users\\demo', browseFs: browseWin, mkdirFs });
    await settled();

    document.querySelector<HTMLButtonElement>('.new-folder-trigger')!.click();
    await settled();
    input = document.querySelector<HTMLInputElement>('.createbar input')!;
    input.value = 'CON';
    input.dispatchEvent(new Event('input'));
    document.querySelector<HTMLButtonElement>('.new-folder-submit')!.click();
    await settled();
    expect(mkdirFs).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.create-error')?.textContent).toBe('Invalid folder name. Choose another name');

    input.value = 'win-app';
    input.dispatchEvent(new Event('input'));
    document.querySelector<HTMLButtonElement>('.new-folder-submit')!.click();
    await settled();
    expect(mkdirFs).toHaveBeenLastCalledWith('C:\\Users\\demo\\win-app');
    expect(document.querySelector<HTMLInputElement>('.pathbar input')?.value).toBe('C:\\Users\\demo\\win-app');
  });

  it.each([
    {
      code: FS_ALREADY_EXISTS_CODE,
      zh: '已存在同名文件或文件夹，请更换名称',
      en: 'A file or folder with this name already exists. Choose another name',
    },
    {
      code: FS_PERMISSION_DENIED_CODE,
      zh: '没有权限在此目录创建文件夹，请选择其他位置',
      en: "You don't have permission to create folders here. Choose another location",
    },
    {
      code: FS_PATH_NOT_FOUND_CODE,
      zh: '当前目录不存在，请返回上一级重试',
      en: "This folder doesn't exist. Go up a level and try again",
    },
    {
      code: FS_VALIDATION_FAILED_CODE,
      zh: '文件夹名称无效，请更换名称',
      en: 'Invalid folder name. Choose another name',
    },
  ])('maps daemon error code $code in zh and en', async ({ code, zh, en }) => {
    for (const [locale, expected] of [['zh', zh], ['en', en]] as const) {
      const mkdirFs = vi.fn(async () => {
        throw new DaemonApiError({ code, msg: 'failed', requestId: 'req-1' });
      });
      mountDialog({ multiple: true, mkdirFs, locale });
      await settled();

      document.querySelector<HTMLButtonElement>('.new-folder-trigger')!.click();
      await settled();
      const input = document.querySelector<HTMLInputElement>('.createbar input')!;
      input.value = 'dup';
      input.dispatchEvent(new Event('input'));
      document.querySelector<HTMLButtonElement>('.new-folder-submit')!.click();
      await settled();

      expect(document.querySelector('.create-error')?.textContent).toBe(expected);
      app?.unmount();
      app = null;
      document.body.innerHTML = '';
      host = document.createElement('div');
      document.body.append(host);
    }
  });

  it('refreshes the parent directory without a browse failure when entering the created folder fails', async () => {
    let created = false;
    const mkdirFs = vi.fn(async (path: string) => {
      created = true;
      return { path };
    });
    const browseFs = vi.fn(async (path?: string): Promise<FsBrowseResult> => {
      if (path === '/home/unreadable') return { path: '', parent: null, entries: [] };
      return {
        path: '/home',
        parent: '/',
        entries: created
          ? [...homeBrowse.entries, { name: 'unreadable', path: '/home/unreadable', isDir: true }]
          : homeBrowse.entries,
      };
    });
    mountDialog({ multiple: true, browseFs, mkdirFs });
    await settled();

    document.querySelector<HTMLButtonElement>('.new-folder-trigger')!.click();
    await settled();
    const input = document.querySelector<HTMLInputElement>('.createbar input')!;
    input.value = 'unreadable';
    input.dispatchEvent(new Event('input'));
    document.querySelector<HTMLButtonElement>('.new-folder-submit')!.click();
    await settled();

    expect(document.querySelector('.browse-error')).toBeNull();
    expect(document.querySelector('.createbar')).toBeNull();
    expect(document.querySelector<HTMLInputElement>('.pathbar input')?.value).toBe('/home');
    expect(rows().map((r) => r.textContent?.trim())).toContain('unreadable');
  });
});
