import { describe, it, expect, vi } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';

const { popupMock, buildMock, getLocaleMock } = vi.hoisted(() => ({
  popupMock: vi.fn(),
  buildMock: vi.fn(),
  getLocaleMock: vi.fn(() => 'en-US'),
}));

vi.mock('electron', () => ({
  app: { getLocale: () => getLocaleMock() },
  Menu: { buildFromTemplate: buildMock },
}));

buildMock.mockImplementation(() => ({ popup: popupMock }));

import {
  editableMenuTemplate,
  installEditableContextMenu,
  selectionPreview,
  setContextMenuLocale,
  type EditableContextInfo,
} from '../../src/main/context-menu';
import { IPC } from '../../src/main/ipc-channels';

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
      undefined, // undo (forwarded, not a role)
      undefined, // redo (forwarded, not a role)
      undefined, // separator
      'cut',
      'copy',
      'paste',
      undefined, // separator
      'selectAll',
    ]);
    // Forwarded undo/redo are always enabled: Chromium's canUndo/canRedo are
    // invalid for the ProseMirror composer, and both the PM history command
    // and the execCommand fallback no-op on an empty stack.
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
    // Role-default labels come from the OS locale at startup — they would mix
    // languages when the in-app language differs from the OS.
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

describe('selectionPreview', () => {
  it('collapses whitespace and caps long selections', () => {
    expect(selectionPreview('  hello\n  world  ')).toBe('hello world');
    expect(selectionPreview('x'.repeat(60))).toBe(`${'x'.repeat(48)}…`);
  });

  it('truncates by grapheme cluster — no unpaired surrogates at the cap', () => {
    // 47 ASCII chars + an emoji (2 UTF-16 units): unit 48 would be a lone
    // high surrogate; the cap must keep the whole emoji instead.
    expect(selectionPreview(`${'a'.repeat(47)}👍 tail`)).toBe(`${'a'.repeat(47)}👍…`);
    expect(selectionPreview(`${'a'.repeat(48)}👍 tail`)).toBe(`${'a'.repeat(48)}…`);
    // A flag emoji is TWO code points — one grapheme.
    expect(selectionPreview(`${'a'.repeat(47)}🇨🇳 tail`)).toBe(`${'a'.repeat(47)}🇨🇳…`);
  });
});

describe('installEditableContextMenu', () => {
  function fakeContents() {
    let handler: ((event: unknown, params: unknown) => void) | null = null;
    return {
      showDefinitionForSelection: vi.fn(),
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
