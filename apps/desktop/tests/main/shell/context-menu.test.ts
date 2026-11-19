import { describe, it, expect, vi } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';

const { popupMock, buildMock, getLocaleMock, focusedWindowMock, writeTextMock, warnMock } = vi.hoisted(() => ({
  writeTextMock: vi.fn(async () => {}),
  popupMock: vi.fn(),
  buildMock: vi.fn(),
  getLocaleMock: vi.fn(() => 'en-US'),
  focusedWindowMock: vi.fn(() => ({} as object | null)),
  warnMock: vi.fn(),
}));

vi.mock('electron', () => ({
  clipboard: { writeText: writeTextMock },
  app: { getLocale: () => getLocaleMock() },
  Menu: { buildFromTemplate: buildMock },
  BaseWindow: { getFocusedWindow: focusedWindowMock },
}));

vi.mock('../../../src/main/diagnostics/log', () => ({ log: { info: vi.fn(), warn: warnMock, error: vi.fn() } }));

buildMock.mockImplementation(() => ({ popup: popupMock }));

import {
  browserMenuTemplate,
  editableMenuTemplate,
  installBrowserContextMenu,
  installEditableContextMenu,
  selectionPreview,
  selectionMenuTemplate,
  setContextMenuLocale,
  type EditableContextInfo,
} from '../../../src/main/shell/context-menu';
import { IPC } from '../../../src/main/ipc/ipc-channels';

function info(overrides: Partial<EditableContextInfo> = {}): EditableContextInfo {
  return {
    isEditable: true,
    selectionText: '',
    editFlags: {
      canUndo: true,
      canRedo: false,
      canCut: false,
      canCopy: false,
      canPaste: true,
      canSelectAll: true,
    },
    ...overrides,
  };
}

function roles(template: MenuItemConstructorOptions[]): (string | undefined)[] {
  return template.map((item) => item.role as string | undefined);
}

function findByRole(
  template: MenuItemConstructorOptions[],
  role: string,
): MenuItemConstructorOptions | undefined {
  return template.find((item) => item.role === role);
}

describe('editableMenuTemplate', () => {
  it('mirrors the Edit menu vocabulary: cut/copy/paste/selectAll as editFlags-gated roles, undo/redo forwarded', () => {
    const forward = vi.fn();
    const template = editableMenuTemplate(info(), 'en', false, vi.fn(), forward);
    expect(roles(template)).toEqual([
      undefined,
      undefined,
      undefined,
      'cut',
      'copy',
      'paste',
      undefined,
      'selectAll',
    ]);
    const undo = template[0];
    const redo = template[1];
    expect(undo).toMatchObject({ label: 'Undo', enabled: true });
    expect(redo).toMatchObject({ label: 'Redo', enabled: true });
    (undo as { click: () => void }).click();
    (redo as { click: () => void }).click();
    expect(forward.mock.calls).toEqual([['undo'], ['redo']]);
    expect(findByRole(template, 'cut')?.enabled).toBe(false);
    expect(findByRole(template, 'paste')?.enabled).toBe(true);
    expect(findByRole(template, 'selectAll')?.enabled).toBe(true);
  });

  it('adds Look Up and pasteAndMatchStyle on macOS only', () => {
    const mac = editableMenuTemplate(info(), 'en', true, vi.fn(), vi.fn());
    expect(roles(mac)).toContain('pasteAndMatchStyle');
    expect(mac[0]?.label).toBe('Look Up “”');
    const win = editableMenuTemplate(info(), 'en', false, vi.fn(), vi.fn());
    expect(roles(win)).not.toContain('pasteAndMatchStyle');
    expect(win[0]?.label).toBe('Undo');
  });

  it('labels every item explicitly so the menu follows the in-app language', () => {
    const zh = editableMenuTemplate(info(), 'zh', true, vi.fn(), vi.fn());
    expect(zh.some((item) => item.label === '撤销')).toBe(true);
    expect(zh.some((item) => item.label === '重做')).toBe(true);
    expect(findByRole(zh, 'cut')?.label).toBe('剪切');
    expect(findByRole(zh, 'copy')?.label).toBe('拷贝');
    expect(findByRole(zh, 'paste')?.label).toBe('粘贴');
    expect(findByRole(zh, 'pasteAndMatchStyle')?.label).toBe('粘贴并匹配样式');
    expect(findByRole(zh, 'selectAll')?.label).toBe('全选');
    const en = editableMenuTemplate(info(), 'en', false, vi.fn(), vi.fn());
    expect(en.some((item) => item.label === 'Undo')).toBe(true);
    expect(findByRole(en, 'selectAll')?.label).toBe('Select All');
  });

  it('Look Up carries the selection and fires showDefinitionForSelection', () => {
    const showDefinition = vi.fn();
    const template = editableMenuTemplate(
      info({ selectionText: 'transcript' }),
      'en',
      true,
      showDefinition,
      vi.fn(),
    );
    expect(template[0]?.label).toBe('Look Up “transcript”');
    expect(template[0]?.enabled).toBe(true);
    (template[0] as { click: () => void }).click();
    expect(showDefinition).toHaveBeenCalledOnce();
  });

  it('Look Up is disabled with an empty selection and localized in zh', () => {
    const template = editableMenuTemplate(info(), 'zh', true, vi.fn(), vi.fn());
    expect(template[0]?.label).toBe('查找“”');
    expect(template[0]?.enabled).toBe(false);
  });
});

describe('selectionMenuTemplate', () => {
  it('offers only read-only items, with Look Up on macOS', () => {
    const showDefinition = vi.fn();
    const mac = selectionMenuTemplate('hello world', 'en', true, showDefinition);
    expect(mac.map((item) => item.role ?? item.type ?? item.label)).toEqual(['copy', 'separator', 'Look Up “hello world”']);
    (mac[2] as { click: () => void }).click();
    expect(showDefinition).toHaveBeenCalledOnce();
    expect(selectionMenuTemplate('hello', 'zh', false, vi.fn())).toEqual([{ role: 'copy', label: '拷贝' }]);
  });
});

describe('selectionPreview', () => {
  it('collapses whitespace and caps long selections', () => {
    expect(selectionPreview('  hello\n  world  ')).toBe('hello world');
    expect(selectionPreview('x'.repeat(60))).toBe(`${'x'.repeat(48)}…`);
  });

  it('truncates by grapheme cluster — no unpaired surrogates at the cap', () => {
    expect(selectionPreview(`${'a'.repeat(47)}👍 tail`)).toBe(`${'a'.repeat(47)}👍…`);
    expect(selectionPreview(`${'a'.repeat(48)}👍 tail`)).toBe(`${'a'.repeat(48)}…`);
    expect(selectionPreview(`${'a'.repeat(47)}🇨🇳 tail`)).toBe(`${'a'.repeat(47)}🇨🇳…`);
  });
});

describe('browserMenuTemplate', () => {
  it('opens links in the requested destination and copies link and highlight URLs', () => {
    const open = vi.fn();
    const template = browserMenuTemplate({ isEditable: false, selectionText: 'selected words', linkURL: 'https://example.test/link', pageURL: 'https://example.test/page#old', x: 0, y: 0, editFlags: { canCopy: true, canPaste: false } }, 'en', vi.fn(), undefined, open);
    const click = (label: string) => (template.find((item) => item.label === label) as { click(): void }).click();
    click('Open Link in New Tab');
    click('Open Link in New Window');
    expect(open.mock.calls).toEqual([['https://example.test/link', 'tab'], ['https://example.test/link', 'window']]);
    click('Copy Link Address');
    expect(writeTextMock).toHaveBeenLastCalledWith('https://example.test/link');
    click('Copy Link to Highlight');
    expect(writeTextMock).toHaveBeenLastCalledWith('https://example.test/page#:~:text=selected%20words');
    if (process.platform === 'darwin') expect(template.some((item) => item.role === 'services')).toBe(true);
  });
  it('logs a link copy that the clipboard rejects', async () => {
    writeTextMock.mockRejectedValueOnce(new Error('pasteboard unavailable'));
    const template = browserMenuTemplate({ isEditable: false, selectionText: '', linkURL: 'https://example.test/link', pageURL: 'https://example.test/page', x: 0, y: 0, editFlags: { canCopy: false, canPaste: false } }, 'en', vi.fn(), undefined, vi.fn());
    (template.find((item) => item.label === 'Copy Link Address') as { click(): void }).click();
    await vi.waitFor(() => expect(warnMock).toHaveBeenCalledExactlyOnceWith('[kimi-desktop] clipboard write failed: pasteboard unavailable'));
  });
  it('enables new tab for a file link on a local page, but keeps new window web-only', () => {
    const open = vi.fn();
    const item = (template: ReturnType<typeof browserMenuTemplate>, label: string) => template.find((entry) => entry.label === label) as { enabled?: boolean; click(): void };
    const local = browserMenuTemplate({ isEditable: false, selectionText: '', linkURL: 'file:///Users/me/site/other.html', pageURL: 'file:///Users/me/site/index.html', x: 0, y: 0, editFlags: { canCopy: true, canPaste: false } }, 'en', vi.fn(), undefined, open);
    expect(item(local, 'Open Link in New Tab').enabled).toBe(true);
    expect(item(local, 'Open Link in New Window').enabled).toBe(false);
    item(local, 'Open Link in New Tab').click();
    expect(open).toHaveBeenCalledWith('file:///Users/me/site/other.html', 'tab');
    const web = browserMenuTemplate({ isEditable: false, selectionText: '', linkURL: 'file:///Users/me/site/other.html', pageURL: 'https://example.test/page', x: 0, y: 0, editFlags: { canCopy: true, canPaste: false } }, 'en', vi.fn(), undefined, open);
    expect(item(web, 'Open Link in New Tab').enabled).toBe(false);
    expect(item(web, 'Open Link in New Window').enabled).toBe(false);
  });
  it('offers localized copy, paste and inspect-element actions', () => {
    const inspect = vi.fn();
    const template = browserMenuTemplate(
      {
        isEditable: true,
        selectionText: 'selected',
        x: 12,
        y: 24,
        editFlags: { canCopy: true, canPaste: true },
      },
      'zh',
      inspect,
    );
    expect(template.slice(0, 5)).toMatchObject([
      { role: 'copy', label: '复制', enabled: true },
      { role: 'paste', label: '粘贴', enabled: true },
      { type: 'separator' },
      { label: '标注', enabled: false },
      { label: '检查元素' },
    ]);
    (template[4] as { click: () => void }).click();
    expect(inspect).toHaveBeenCalledOnce();
  });

  it('keeps paste disabled outside editable page content', () => {
    const template = browserMenuTemplate(
      {
        isEditable: false,
        selectionText: '',
        x: 0,
        y: 0,
        editFlags: { canCopy: false, canPaste: true },
      },
      'en',
      vi.fn(),
    );
    expect(findByRole(template, 'copy')?.enabled).toBe(false);
    expect(findByRole(template, 'paste')?.enabled).toBe(false);
    expect(template[4]?.label).toBe('Inspect element');
  });
});

describe('installEditableContextMenu', () => {
  function fakeContents() {
    let handler: ((event: unknown, params: unknown) => void) | null = null;
    return {
      showDefinitionForSelection: vi.fn(),
      inspectElement: vi.fn(),
      send: vi.fn(),
      isDestroyed: () => false,
      on: vi.fn((channel: string, cb: (event: unknown, params: unknown) => void) => {
        if (channel === 'context-menu') handler = cb;
      }),
      fire(params: unknown) {
        handler?.({}, params);
      },
    };
  }

  it('pops the menu only for editable targets', () => {
    const contents = fakeContents();
    installEditableContextMenu(contents as never);
    popupMock.mockClear();

    contents.fire({ isEditable: false });
    expect(popupMock).not.toHaveBeenCalled();

    contents.fire({
      isEditable: true,
      selectionText: 'hi',
      editFlags: {
        canUndo: true,
        canRedo: true,
        canCut: true,
        canCopy: true,
        canPaste: true,
        canSelectAll: true,
      },
    });
    expect(popupMock).toHaveBeenCalledOnce();
  });

  it('undo/redo clicks forward to the renderer over the menu-action channel', () => {
    const contents = fakeContents();
    installEditableContextMenu(contents as never);
    buildMock.mockClear();
    contents.fire({
      isEditable: true,
      selectionText: '',
      editFlags: {
        canUndo: false,
        canRedo: false,
        canCut: false,
        canCopy: false,
        canPaste: false,
        canSelectAll: true,
      },
    });
    const template = buildMock.mock.calls.at(-1)?.[0] as MenuItemConstructorOptions[];
    const undo = template.find((item) => item.label === 'Undo');
    const redo = template.find((item) => item.label === 'Redo');
    (undo as { click: () => void }).click();
    (redo as { click: () => void }).click();
    expect(contents.send.mock.calls).toEqual([
      [IPC.menuAction, 'undo'],
      [IPC.menuAction, 'redo'],
    ]);
  });

  it('resolves the locale from the renderer push', () => {
    const contents = fakeContents();
    installEditableContextMenu(contents as never);
    const params = {
      isEditable: true,
      selectionText: 'hi',
      editFlags: {
        canUndo: true,
        canRedo: true,
        canCut: true,
        canCopy: true,
        canPaste: true,
        canSelectAll: true,
      },
    };

    setContextMenuLocale('zh');
    contents.fire(params);
    let template = buildMock.mock.calls.at(-1)?.[0] as MenuItemConstructorOptions[];
    if (process.platform === 'darwin') {
      expect(template[0]?.label).toContain('查找');
    }

    setContextMenuLocale('en');
    contents.fire(params);
    template = buildMock.mock.calls.at(-1)?.[0] as MenuItemConstructorOptions[];
    if (process.platform === 'darwin') {
      expect(template[0]?.label).toContain('Look Up');
    }
  });
});

describe('installBrowserContextMenu', () => {
  it('annotates the prepared target and does not reopen a menu after the page is hidden', async () => {
    let handler: ((event: unknown, params: unknown) => void) | undefined;
    const contents = { isDestroyed: () => false, inspectElement: vi.fn(), on: (_event: string, callback: typeof handler) => { handler = callback; } };
    const annotate = vi.fn();
    let visible = true;
    installBrowserContextMenu(contents as never, () => visible, async () => annotate);
    popupMock.mockClear();
    handler?.({}, { isEditable: false, selectionText: '', x: 5, y: 10, editFlags: { canCopy: false, canPaste: false } });
    await Promise.resolve();
    const menu = buildMock.mock.calls.at(-1)?.[0] as MenuItemConstructorOptions[];
    expect(menu[3]).toMatchObject({ label: 'Annotate element', enabled: true });
    (menu[3] as { click: () => void }).click();
    expect(annotate).toHaveBeenCalledOnce();
    expect(contents.inspectElement).not.toHaveBeenCalled();
    popupMock.mockClear();
    handler?.({}, { isEditable: false, selectionText: '', x: 5, y: 10, editFlags: { canCopy: false, canPaste: false } });
    visible = false;
    await Promise.resolve();
    expect(popupMock).not.toHaveBeenCalled();
  });

  it('pops for page content and inspects the clicked coordinates', () => {
    const handlers: { contextMenu?: (event: unknown, params: unknown) => void } = {};
    const contents = {
      inspectElement: vi.fn(),
      isDestroyed: () => false,
      on: vi.fn((channel: string, cb: (event: unknown, params: unknown) => void) => {
        if (channel === 'context-menu') handlers.contextMenu = cb;
      }),
    };
    let visible = true;
    installBrowserContextMenu(contents as never, () => visible);
    buildMock.mockClear();
    popupMock.mockClear();
    handlers.contextMenu?.({}, {
      isEditable: false,
      selectionText: 'text',
      x: 40,
      y: 60,
      editFlags: { canCopy: true, canPaste: false },
    });
    expect(popupMock).toHaveBeenCalledOnce();
    const template = buildMock.mock.calls.at(-1)?.[0] as MenuItemConstructorOptions[];
    (template[4] as { click: () => void }).click();
    expect(contents.inspectElement).toHaveBeenCalledWith(40, 60);
    focusedWindowMock.mockReturnValueOnce(null);
    popupMock.mockClear();
    handlers.contextMenu?.({}, {
      isEditable: false, selectionText: '', x: 40, y: 60,
      editFlags: { canCopy: false, canPaste: false },
    });
    expect(popupMock).not.toHaveBeenCalled();
    visible = false;
    handlers.contextMenu?.({}, {});
    expect(popupMock).not.toHaveBeenCalled();
  });
});
