import { join } from 'node:path';

import { app, Menu, nativeImage, Tray } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';

import { trackDesktopEvent } from './track';
import { setRuntimeLocale } from './runtime-context';
import { setTaskbarAttention } from './taskbar';

// System tray (macOS menu-bar / Windows notification area). Desktop-only — the
// web client has no equivalent surface. Click behaviour: on macOS a plain
// click on a status item with a context menu opens the menu; on Windows the
// menu opens on right-click by default once set, so left-click (and
// double-click) is wired to surface the main window below.
//
// The tray also renders the pending-attention badge: the renderer pushes
// {unread, approvals, questions, items} over `IPC.trayAttention` whenever they
// change (see renderer composables/useTrayAttention.ts), and `setTrayAttention`
// shows the bare total next to the macOS menu-bar icon (Tray.setTitle is
// macOS-only — the Windows counterpart is the taskbar overlay + flash in
// taskbar.ts), the per-kind breakdown in the tooltip, and the attention
// sessions as clickable entries at the top of the dropdown menu (click → show
// the window and jump to that session). On macOS and Windows the window hides
// instead of closing (window.ts shouldHideOnClose), so the renderer keeps
// reporting while hidden and the badge stays live; the last-known state only
// has to survive real quits/reloads — unread flags persist in localStorage
// and pending items live server-side, so entries stay meaningful (and
// clickable, via the window.ts queue while booting/reloading) until the next
// push.

export interface TrayIconEnv {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  /** <resources> in packaged builds (extraResources carries build/tray*). */
  resourcesPath: string;
  /** Repo dir in dev (Electron launched with cwd = apps/desktop). */
  appPath: string;
}

/** Tray icon file. macOS uses a monochrome template image — the `Template` in
    the filename makes nativeImage mark it automatically, and the OS re-colors
    the silhouette to match light/dark menu bars. Windows wants .ico; Linux
    uses the color png (retina tray@2x.png is picked up automatically). */
export function trayIconPath(env: TrayIconEnv): string {
  const name =
    env.platform === 'darwin'
      ? 'trayTemplate.png'
      : env.platform === 'win32'
        ? 'tray.ico'
        : 'tray.png';
  return join(env.isPackaged ? env.resourcesPath : env.appPath, 'build', name);
}

export interface TrayActions {
  /** Show (recreating if closed) and focus the main window. */
  showMainWindow(): void;
  /** Show the main window and jump to this session (tray menu item click). */
  openSession(sessionId: string): void;
  /** Quit via app.quit() so before-quit cleanup (server handle) still runs. */
  quit(): void;
}

/** One session needing attention, listed as a clickable tray menu entry. */
export interface TrayAttentionItem {
  sessionId: string;
  title: string;
  /** Unseen finished turn (the sidebar's unread dot). */
  unread: boolean;
  /** Tool calls in this session waiting for the user's approval. */
  approvals: number;
  /** Agent questions in this session waiting for an answer. */
  questions: number;
}

/** Pending-attention totals pushed by the renderer. */
export interface TrayAttention {
  /** Sessions with an unseen finished turn (the sidebar's unread dots). */
  unread: number;
  /** Tool calls waiting for the user's approval. */
  approvals: number;
  /** Agent questions waiting for an answer. */
  questions: number;
  /** Every session needing attention, most recently active first; the menu
      shows the first few (MAX_MENU_ITEMS) plus an overflow entry. */
  items: TrayAttentionItem[];
}

const ZERO_ATTENTION: TrayAttention = { unread: 0, approvals: 0, questions: 0, items: [] };

/** Menu entries listed before collapsing into the "还有 N 条…" overflow. */
const MAX_MENU_ITEMS = 8;
/** Defensive cap on the pushed items array (a stockpiled session list must not
    make the IPC payload / menu rebuild unbounded). */
const MAX_ITEMS = 50;

function asCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.min(Math.floor(value), 999);
}

function asTrayAttentionItem(value: unknown): TrayAttentionItem | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = value as {
    sessionId?: unknown;
    title?: unknown;
    unread?: unknown;
    approvals?: unknown;
    questions?: unknown;
  };
  if (
    typeof candidate.sessionId !== 'string' ||
    candidate.sessionId === '' ||
    typeof candidate.title !== 'string' ||
    typeof candidate.unread !== 'boolean'
  ) {
    return null;
  }
  const approvals = asCount(candidate.approvals);
  const questions = asCount(candidate.questions);
  if (approvals === null || questions === null) {
    return null;
  }
  return {
    sessionId: candidate.sessionId,
    title: candidate.title,
    unread: candidate.unread,
    approvals,
    questions,
  };
}

/** Structural validation + clamping for the `IPC.trayAttention` payload.
    Anything malformed is dropped; honest numbers are floored to non-negative
    integers and capped so a runaway count can't flood the menu bar. */
export function asTrayAttention(value: unknown): TrayAttention | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = value as {
    unread?: unknown;
    approvals?: unknown;
    questions?: unknown;
    items?: unknown;
  };
  const unread = asCount(candidate.unread);
  const approvals = asCount(candidate.approvals);
  const questions = asCount(candidate.questions);
  if (unread === null || approvals === null || questions === null || !Array.isArray(candidate.items)) {
    return null;
  }
  const items: TrayAttentionItem[] = [];
  for (const raw of candidate.items.slice(0, MAX_ITEMS)) {
    const item = asTrayAttentionItem(raw);
    if (item === null) {
      return null;
    }
    items.push(item);
  }
  return { unread, approvals, questions, items };
}

/** Menu-bar text: just the grand total ("6"), empty when nothing pends. Long
    text in the status item is crowded and gets hidden behind the notch on
    notched MacBooks, so the per-kind breakdown lives in the tooltip/menu. */
export function trayAttentionTitle(attention: TrayAttention): string {
  const total = attention.unread + attention.approvals + attention.questions;
  return total > 0 ? String(total) : '';
}

/** Dock badge text: the total pending count as a string while anything needs
 *  attention, empty string otherwise. Electron's Dock badge on macOS shows
 *  numeric strings as a count and non-numeric strings as a dot; we use the
 *  count so the user can see how much activity is waiting. */
export function dockBadgeText(attention: TrayAttention): string {
  const total = attention.unread + attention.approvals + attention.questions;
  return total > 0 ? String(total) : '';
}

// --- localization -------------------------------------------------------------
//
// The renderer's vue-i18n owns en/zh; the main process has no i18n runtime, so
// the tray keeps its own tiny string table. The renderer pushes its effective
// locale over `IPC.locale` (useTrayAttention.ts); until then the OS language
// is the fallback. Count-agnostic phrasings keep the table free of plural
// rules.

export type TrayLocale = 'en' | 'zh';

interface TrayStrings {
  /** Section header above the attention session entries. */
  pending: string;
  openApp: string;
  quit: string;
  /** Fallback for an empty session title. */
  unnamedSession: string;
  /** Overflow entry after MAX_MENU_ITEMS entries. */
  moreOverflow: (rest: number) => string;
  /** Tooltip/summary parts, joined with " · ". */
  unreadPart: (n: number) => string;
  approvalsPart: (n: number) => string;
  questionsPart: (n: number) => string;
  /** Per-entry suffixes ("title · 2 待审批 · 1 待回答"). */
  itemApprovalsSuffix: (n: number) => string;
  itemQuestionsSuffix: (n: number) => string;
}

const TRAY_STRINGS: Record<TrayLocale, TrayStrings> = {
  zh: {
    pending: '待处理',
    openApp: '打开 Kimi Code',
    quit: '退出',
    unnamedSession: '未命名会话',
    moreOverflow: (rest) => `还有 ${rest} 条待处理…`,
    unreadPart: (n) => `${n} 条未读`,
    approvalsPart: (n) => `${n} 个待审批`,
    questionsPart: (n) => `${n} 个待回答`,
    itemApprovalsSuffix: (n) => `${n} 待审批`,
    itemQuestionsSuffix: (n) => `${n} 待回答`,
  },
  en: {
    pending: 'Pending',
    openApp: 'Open Kimi Code',
    quit: 'Quit',
    unnamedSession: 'Untitled session',
    moreOverflow: (rest) => `${rest} more…`,
    unreadPart: (n) => `${n} unread`,
    approvalsPart: (n) => `${n} to approve`,
    questionsPart: (n) => `${n} to answer`,
    itemApprovalsSuffix: (n) => `${n} to approve`,
    itemQuestionsSuffix: (n) => `${n} to answer`,
  },
};

function osTrayLocale(): TrayLocale {
  try {
    return app.getLocale().toLowerCase().startsWith('zh') ? 'zh' : 'en';
  } catch {
    return 'en';
  }
}

/** Renderer-pushed locale; null = follow the OS language until a push lands. */
let trayLocale: TrayLocale | null = null;

function effectiveTrayLocale(): TrayLocale {
  return trayLocale ?? osTrayLocale();
}

export function trayOpenLabel(locale: TrayLocale): string {
  return TRAY_STRINGS[locale].openApp;
}

/** Per-kind breakdown line ("3 条未读 · 2 个待审批 · 1 个待回答") for the
    tooltip and the dropdown menu's header item; empty when nothing pends. */
export function trayAttentionSummary(attention: TrayAttention, locale: TrayLocale): string {
  const strings = TRAY_STRINGS[locale];
  const parts: string[] = [];
  if (attention.unread > 0) parts.push(strings.unreadPart(attention.unread));
  if (attention.approvals > 0) parts.push(strings.approvalsPart(attention.approvals));
  if (attention.questions > 0) parts.push(strings.questionsPart(attention.questions));
  return parts.join(' · ');
}

/** Label for one attention session's menu entry: the session title (whitespace
    collapsed, truncated so a long title can't stretch the menu), with the
    actionable kinds appended ("标题 · 2 待审批 · 1 待回答"). Unread-only
    sessions carry no suffix — the bare title reads as "new output", matching
    the established menu-bar apps' unread rows. */
export function trayAttentionItemLabel(item: TrayAttentionItem, locale: TrayLocale): string {
  const strings = TRAY_STRINGS[locale];
  const title = item.title.replace(/\s+/g, ' ').trim();
  const clipped =
    title === '' ? strings.unnamedSession : title.length > 32 ? `${title.slice(0, 32)}…` : title;
  const parts: string[] = [];
  if (item.approvals > 0) parts.push(strings.itemApprovalsSuffix(item.approvals));
  if (item.questions > 0) parts.push(strings.itemQuestionsSuffix(item.questions));
  return parts.length > 0 ? `${clipped} · ${parts.join(' · ')}` : clipped;
}

function buildTrayMenu(actions: TrayActions, attention: TrayAttention, locale: TrayLocale): Menu {
  const strings = TRAY_STRINGS[locale];
  // Pending total as of menu build time, reported with every tray click.
  const pendingCount = attention.unread + attention.approvals + attention.questions;
  const template: MenuItemConstructorOptions[] = [];
  if (attention.items.length > 0) {
    // The attention sessions themselves, clickable.
    template.push({ label: strings.pending, enabled: false });
    for (const item of attention.items.slice(0, MAX_MENU_ITEMS)) {
      template.push({
        label: trayAttentionItemLabel(item, locale),
        click: () => {
          trackDesktopEvent('tray_action', { action: 'open-session', pending_count: pendingCount });
          actions.openSession(item.sessionId);
        },
      });
    }
    const rest = attention.items.length - MAX_MENU_ITEMS;
    if (rest > 0) {
      template.push({
        label: strings.moreOverflow(rest),
        click: () => {
          trackDesktopEvent('tray_action', { action: 'show-window', pending_count: pendingCount });
          actions.showMainWindow();
        },
      });
    }
    template.push({ type: 'separator' });
  } else {
    // Fallback for counts without items (shouldn't happen with the current
    // renderer): keep the one-line aggregate.
    const summary = trayAttentionSummary(attention, locale);
    if (summary !== '') {
      template.push({ label: summary, enabled: false }, { type: 'separator' });
    }
  }
  template.push(
    {
      label: strings.openApp,
      click: () => {
        trackDesktopEvent('tray_action', { action: 'show-window', pending_count: pendingCount });
        actions.showMainWindow();
      },
    },
    { type: 'separator' },
    {
      label: strings.quit,
      click: () => {
        trackDesktopEvent('tray_action', { action: 'quit', pending_count: pendingCount });
        actions.quit();
      },
    },
  );
  return Menu.buildFromTemplate(template);
}

// Module-scoped live instances (same pattern as window.ts's mainWindow): a
// Tray with no live JS reference gets garbage-collected and its OS icon
// silently disappears, so the tray + its actions live here for the app's
// lifetime. destroyTray() runs from app.ts's before-quit.
let tray: Tray | null = null;
let trayActions: TrayActions | null = null;
let lastAttention: TrayAttention = ZERO_ATTENTION;

export function createTray(actions: TrayActions): Tray | null {
  const iconPath = trayIconPath({
    platform: process.platform,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });
  const image = nativeImage.createFromPath(iconPath);
  // A missing asset yields an empty image, and `new Tray()` on it would throw
  // inside the whenReady chain — silently killing the tray AND every
  // statement after it. Degrade loudly instead. (2026-07: a broken
  // extraResources glob did exactly this — assets never shipped, no tray.)
  if (image.isEmpty()) {
    console.warn('[tray] icon not found, tray disabled:', iconPath);
    return null;
  }
  // The macOS asset is an all-white silhouette: hand it to the system as a
  // template image so the menu bar recolors it (black on light themes, white
  // on dark). Windows/Linux keep their colored icon as-is.
  if (process.platform === 'darwin') {
    image.setTemplateImage(true);
  }
  tray = new Tray(image);
  trayActions = actions;
  lastAttention = ZERO_ATTENTION;
  // Telemetry locale baseline until the renderer pushes its own (IPC.locale).
  setRuntimeLocale(effectiveTrayLocale());
  renderTray();
  if (process.platform === 'win32') {
    // Windows convention: left-click / double-click surfaces the window; the
    // context menu opens on right-click without any handler. This is the
    // dominant tray recall path on Windows, so it reports tray_action too —
    // click only: a double-click also fires click, tracking both would
    // double-count a single gesture.
    const showFromTray = (): void => {
      trackDesktopEvent('tray_action', {
        action: 'show-window',
        pending_count: lastAttention.unread + lastAttention.approvals + lastAttention.questions,
      });
      actions.showMainWindow();
    };
    tray.on('click', showFromTray);
    tray.on('double-click', () => actions.showMainWindow());
  }
  return tray;
}

function renderTray(): void {
  if (tray === null || trayActions === null) {
    return;
  }
  const locale = effectiveTrayLocale();
  if (process.platform === 'darwin') {
    // monospacedDigit keeps the status item's width stable as the count ticks.
    // Unpackaged (dev) runs prefix the title with "dev" so this tray can't be
    // confused with a simultaneously running packaged app's (same icon).
    const title = trayAttentionTitle(lastAttention);
    tray.setTitle(app.isPackaged ? title : `dev${title}`, { fontType: 'monospacedDigit' });
  }
  // Dock badge (macOS only — app.dock is undefined on Windows/Linux). A red
  // dot appears while any attention is pending and is cleared when caught up.
  app.dock?.setBadge(dockBadgeText(lastAttention));
  const summary = trayAttentionSummary(lastAttention, locale);
  tray.setToolTip(summary === '' ? 'Kimi Code' : `Kimi Code — ${summary}`);
  tray.setContextMenu(buildTrayMenu(trayActions, lastAttention, locale));
}

/** Render new pending-attention totals: menu-bar count (macOS), tooltip, and
    the dropdown menu's session entries. No-op before the tray exists. */
export function setTrayAttention(attention: TrayAttention): void {
  lastAttention = attention;
  renderTray();
  syncTaskbarAttention();
}

/** Follow the renderer's in-app language (IPC.locale): re-render the tooltip
    and menu with the same attention state in the new language. */
export function setTrayLocale(locale: TrayLocale): void {
  if (locale === trayLocale) {
    return;
  }
  trayLocale = locale;
  setRuntimeLocale(locale);
  renderTray();
  syncTaskbarAttention();
}

function syncTaskbarAttention(): void {
  const total = lastAttention.unread + lastAttention.approvals + lastAttention.questions;
  setTaskbarAttention(total, trayAttentionSummary(lastAttention, effectiveTrayLocale()));
}

/** Tear the tray down on quit and drop the module references. */
export function destroyTray(): void {
  tray?.destroy();
  tray = null;
  trayActions = null;
}
