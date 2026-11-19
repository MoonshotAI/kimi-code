import { app, BaseWindow, clipboard, Menu } from 'electron';
import type { MenuItemConstructorOptions, WebContents } from 'electron';

import { IPC } from '../ipc/ipc-channels';
import { log } from '../diagnostics/log';
import type { TrayLocale } from './tray';

interface ContextMenuStrings {
  lookUp: string;
  undo: string;
  redo: string;
  cut: string;
  copy: string;
  paste: string;
  pasteAndMatchStyle: string;
  selectAll: string;
  inspectElement: string;
  annotateElement: string;
  openLinkTab: string;
  openLinkWindow: string;
  copyLink: string;
  copyHighlight: string;
  services: string;
}

const CONTEXT_MENU_STRINGS: Record<TrayLocale, ContextMenuStrings> = {
  zh: {
    lookUp: '查找“{selection}”',
    undo: '撤销',
    redo: '重做',
    cut: '剪切',
    copy: '拷贝',
    paste: '粘贴',
    pasteAndMatchStyle: '粘贴并匹配样式',
    selectAll: '全选',
    inspectElement: '检查元素',
    annotateElement: '标注',
    openLinkTab: '在新标签页打开',
    openLinkWindow: '在新窗口打开',
    copyLink: '复制链接',
    copyHighlight: '复制选中文字的链接',
    services: '服务',
  },
  en: {
    lookUp: 'Look Up “{selection}”',
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    pasteAndMatchStyle: 'Paste and Match Style',
    selectAll: 'Select All',
    inspectElement: 'Inspect element',
    annotateElement: 'Annotate element',
    openLinkTab: 'Open Link in New Tab',
    openLinkWindow: 'Open Link in New Window',
    copyLink: 'Copy Link Address',
    copyHighlight: 'Copy Link to Highlight',
    services: 'Services',
  },
};

let contextMenuLocale: TrayLocale | null = null;

export function effectiveContextMenuLocale(): TrayLocale {
  if (contextMenuLocale !== null) {
    return contextMenuLocale;
  }
  try {
    return app.getLocale().toLowerCase().startsWith('zh') ? 'zh' : 'en';
  } catch {
    return 'en';
  }
}

export function setContextMenuLocale(locale: TrayLocale): void {
  contextMenuLocale = locale;
}

const SELECTION_PREVIEW_MAX = 48;

export function selectionPreview(text: string): string {
  const collapsed = text.replaceAll(/\s+/g, ' ').trim();
  let count = 0;
  let out = '';
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(collapsed)) {
    if (count === SELECTION_PREVIEW_MAX) return `${out}…`;
    out += segment;
    count += 1;
  }
  return collapsed;
}

export interface EditableContextInfo {
  isEditable: boolean;
  selectionText: string;
  editFlags: {
    canUndo: boolean;
    canRedo: boolean;
    canCut: boolean;
    canCopy: boolean;
    canPaste: boolean;
    canSelectAll: boolean;
  };
}

export interface BrowserContextInfo {
  linkURL?: string;
  pageURL?: string;
  isEditable: boolean;
  selectionText: string;
  x: number;
  y: number;
  editFlags: {
    canCopy: boolean;
    canPaste: boolean;
  };
}

function writeClipboardText(text: string): void {
  void clipboard.writeText(text).catch((error: unknown) => {
    log.warn(`[kimi-desktop] clipboard write failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

export function browserMenuTemplate(
  info: BrowserContextInfo,
  locale: TrayLocale,
  inspectElement: () => void,
  annotateElement?: () => void,
  openLink?: (url: string, target: 'tab' | 'window') => void,
): MenuItemConstructorOptions[] {
  const strings = CONTEXT_MENU_STRINGS[locale];
  const link = info.linkURL;
  const web = link !== undefined && /^https?:\/\//i.test(link);
  const localFileLink = link !== undefined && /^file:/i.test(link) && /^file:/i.test(info.pageURL ?? '');
  const highlight = info.selectionText.trim();
  return [
    ...(link ? [
      { label: strings.openLinkTab, enabled: (web || localFileLink) && openLink !== undefined, click: () => openLink?.(link, 'tab') },
      { label: strings.openLinkWindow, enabled: web && openLink !== undefined, click: () => openLink?.(link, 'window') },
      { label: strings.copyLink, click: () => writeClipboardText(link) },
      { type: 'separator' as const },
    ] : []),
    {
      role: 'copy',
      label: locale === 'zh' ? '复制' : strings.copy,
      enabled: info.editFlags.canCopy || info.selectionText.length > 0,
    },
    {
      role: 'paste',
      label: strings.paste,
      enabled: info.isEditable && info.editFlags.canPaste,
    },
    { type: 'separator' },
    { label: strings.annotateElement, enabled: annotateElement !== undefined, click: annotateElement },
    { label: strings.inspectElement, click: inspectElement },
    ...(highlight && info.pageURL && /^(https?:\/\/|file:)/i.test(info.pageURL) ? [{
      label: strings.copyHighlight,
      click: () => {
        const url = new URL(info.pageURL!);
        url.hash = ':~:text=' + encodeURIComponent(highlight.replace(/\s+/g, ' ')).replaceAll('-', '%2D');
        writeClipboardText(url.href);
      },
    }] : []),
    ...(process.platform === 'darwin' ? [{ type: 'separator' as const }, { role: 'services' as const, label: strings.services, submenu: [] }] : []),
  ];
}

export function editableMenuTemplate(
  info: EditableContextInfo,
  locale: TrayLocale,
  isMac: boolean,
  showDefinition: () => void,
  forwardEdit: (command: 'undo' | 'redo') => void,
): MenuItemConstructorOptions[] {
  const strings = CONTEXT_MENU_STRINGS[locale];
  const hasSelection = info.selectionText.trim().length > 0;
  return [
    ...(isMac
      ? [
          {
            label: strings.lookUp.replace('{selection}', selectionPreview(info.selectionText)),
            enabled: hasSelection,
            click: showDefinition,
          },
          { type: 'separator' as const },
        ]
      : []),
    { label: strings.undo, enabled: true, click: () => forwardEdit('undo') },
    { label: strings.redo, enabled: true, click: () => forwardEdit('redo') },
    { type: 'separator' as const },
    { role: 'cut' as const, label: strings.cut, enabled: info.editFlags.canCut },
    { role: 'copy' as const, label: strings.copy, enabled: info.editFlags.canCopy },
    { role: 'paste' as const, label: strings.paste, enabled: info.editFlags.canPaste },
    ...(isMac
      ? [{ role: 'pasteAndMatchStyle' as const, label: strings.pasteAndMatchStyle, enabled: info.editFlags.canPaste }]
      : []),
    { type: 'separator' as const },
    { role: 'selectAll' as const, label: strings.selectAll, enabled: info.editFlags.canSelectAll },
  ];
}

export function selectionMenuTemplate(
  selectionText: string,
  locale: TrayLocale,
  isMac: boolean,
  showDefinition: () => void,
): MenuItemConstructorOptions[] {
  const strings = CONTEXT_MENU_STRINGS[locale];
  return [
    { role: 'copy', label: strings.copy },
    ...(isMac
      ? [
          { type: 'separator' as const },
          { label: strings.lookUp.replace('{selection}', selectionPreview(selectionText)), click: showDefinition },
        ]
      : []),
  ];
}

export function showSelectionContextMenu(contents: WebContents, selectionText: unknown): void {
  if (typeof selectionText !== 'string' || selectionText.trim() === '' || contents.isDestroyed()) return;
  const template = selectionMenuTemplate(selectionText, effectiveContextMenuLocale(), process.platform === 'darwin', () => {
    if (!contents.isDestroyed()) contents.showDefinitionForSelection();
  });
  Menu.buildFromTemplate(template).popup();
}

export function installEditableContextMenu(contents: WebContents): void {
  contents.on('context-menu', (_event, params) => {
    if (!params.isEditable || contents.isDestroyed()) return;
    const template = editableMenuTemplate(
      params,
      effectiveContextMenuLocale(),
      process.platform === 'darwin',
      () => {
        if (!contents.isDestroyed()) contents.showDefinitionForSelection();
      },
      (command) => {
        if (!contents.isDestroyed()) contents.send(IPC.menuAction, command);
      },
    );
    Menu.buildFromTemplate(template).popup();
  });
}

export function installBrowserContextMenu(contents: WebContents, isVisible: () => boolean = () => true, prepareAnnotation?: () => Promise<(() => void) | null>, openLink?: (url: string, target: 'tab' | 'window') => void): void {
  let revision = 0;
  contents.on('context-menu', (_event, params) => {
    if (contents.isDestroyed() || !isVisible() || BaseWindow.getFocusedWindow() === null) return;
    const current = ++revision;
    const show = (annotate: (() => void) | null = null): void => {
      if (current !== revision || contents.isDestroyed() || !isVisible() || BaseWindow.getFocusedWindow() === null) return;
      const template = browserMenuTemplate(params, effectiveContextMenuLocale(), () => {
        if (!contents.isDestroyed()) contents.inspectElement(params.x, params.y);
      }, annotate ?? undefined, openLink);
      Menu.buildFromTemplate(template).popup();
    };
    if (prepareAnnotation === undefined) show();
    else void prepareAnnotation().then(show, () => show());
  });
}
