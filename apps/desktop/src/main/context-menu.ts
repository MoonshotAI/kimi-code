// Native context menu for editable text fields (the transcript find bar,
// composer, inline rename inputs…) — Electron ships no default one.
// Follows external-links.ts's installer pattern; the template builder stays
// pure for tests. Only the editable case is handled.
import { app, Menu } from 'electron';
import type { MenuItemConstructorOptions, WebContents } from 'electron';

import type { TrayLocale } from './tray';

// --- localization -------------------------------------------------------------
//
// Same pattern as tray.ts / menu.ts: own string table, renderer pushes its
// locale over `IPC.locale`, OS language as fallback. Every item gets an
// explicit label — role-default labels follow the OS locale only, not the
// in-app language (roles are kept for the native editing behavior).
interface ContextMenuStrings {
  lookUp: string;
  undo: string;
  redo: string;
  cut: string;
  copy: string;
  paste: string;
  pasteAndMatchStyle: string;
  selectAll: string;
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
  },
};

let contextMenuLocale: TrayLocale | null = null;

function effectiveContextMenuLocale(): TrayLocale {
  if (contextMenuLocale !== null) {
    return contextMenuLocale;
  }
  try {
    return app.getLocale().toLowerCase().startsWith('zh') ? 'zh' : 'en';
  } catch {
    return 'en';
  }
}

/** Follow the renderer's in-app language (IPC.locale); the menu is rebuilt
 *  on every right-click, so no re-render is needed here. */
export function setContextMenuLocale(locale: TrayLocale): void {
  contextMenuLocale = locale;
}

const SELECTION_PREVIEW_MAX = 48;

/** Single-line, length-capped selection for the Look Up label: grapheme
 *  clusters (no unpaired surrogates), lazy iteration capped at the 49th. */
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

// The subset of Electron's ContextMenuParams the template reads — structural,
// so the pure builder is testable without constructing Electron params.
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

/** Right-click menu for an editable field: Look Up (macOS only, selection
 *  required; Electron has no lookUp role, hence showDefinition) plus the
 *  standard editing verbs as roles, gated by editFlags. */
export function editableMenuTemplate(
  info: EditableContextInfo,
  locale: TrayLocale,
  isMac: boolean,
  showDefinition: () => void,
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
    { role: 'undo' as const, label: strings.undo, enabled: info.editFlags.canUndo },
    { role: 'redo' as const, label: strings.redo, enabled: info.editFlags.canRedo },
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

/** Show the native editing menu whenever a text field in this window is
 *  right-clicked; non-editable targets keep the app default (no menu). */
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
    );
    Menu.buildFromTemplate(template).popup();
  });
}
