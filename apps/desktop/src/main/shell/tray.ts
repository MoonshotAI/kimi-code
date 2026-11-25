import { join } from 'node:path';

import { app, Menu, nativeImage, Tray } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';

import { setRuntimeLocale, trackDesktopEvent } from '../diagnostics/track';
import { setTaskbarAttention } from './taskbar';

export interface TrayIconEnv {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
}

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
  showMainWindow(): void;
  openSession(sessionId: string): void;
  exportDiagnostics(locale: TrayLocale): void;
  openLogsFolder(): void;
  quit(): void;
}

export interface TrayAttentionItem {
  sessionId: string;
  title: string;
  unread: boolean;
  approvals: number;
  questions: number;
}

export interface TrayAttention {
  unread: number;
  approvals: number;
  questions: number;
  items: TrayAttentionItem[];
}

const ZERO_ATTENTION: TrayAttention = { unread: 0, approvals: 0, questions: 0, items: [] };

const MAX_MENU_ITEMS = 8;
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

export function trayAttentionTitle(attention: TrayAttention): string {
  const total = attention.unread + attention.approvals + attention.questions;
  return total > 0 ? String(total) : '';
}

export function dockBadgeText(attention: TrayAttention): string {
  const total = attention.unread + attention.approvals + attention.questions;
  return total > 0 ? String(total) : '';
}

export type TrayLocale = 'en' | 'zh';

interface TrayStrings {
  pending: string;
  openApp: string;
  exportDiagnostics: string;
  openLogsFolder: string;
  quit: string;
  unnamedSession: string;
  moreOverflow: (rest: number) => string;
  unreadPart: (n: number) => string;
  approvalsPart: (n: number) => string;
  questionsPart: (n: number) => string;
  itemApprovalsSuffix: (n: number) => string;
  itemQuestionsSuffix: (n: number) => string;
}

const TRAY_STRINGS: Record<TrayLocale, TrayStrings> = {
  zh: {
    pending: '待处理',
    openApp: '打开 Kimi Code',
    exportDiagnostics: '导出诊断信息',
    openLogsFolder: '打开日志文件夹',
    quit: '退出',
    unnamedSession: '未命名会话',
    moreOverflow: (rest) => `还有 ${rest} 条待处理…`,
    unreadPart: (n) => `${n} 条未读`,
    approvalsPart: (n) => `${n} 个待批准`,
    questionsPart: (n) => `${n} 个待回答`,
    itemApprovalsSuffix: (n) => `${n} 待批准`,
    itemQuestionsSuffix: (n) => `${n} 待回答`,
  },
  en: {
    pending: 'Pending',
    openApp: 'Open Kimi Code',
    exportDiagnostics: 'Export Diagnostics',
    openLogsFolder: 'Open Logs Folder',
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

let trayLocale: TrayLocale | null = null;

function effectiveTrayLocale(): TrayLocale {
  return trayLocale ?? osTrayLocale();
}

export function trayOpenLabel(locale: TrayLocale): string {
  return TRAY_STRINGS[locale].openApp;
}

export function trayAttentionSummary(attention: TrayAttention, locale: TrayLocale): string {
  const strings = TRAY_STRINGS[locale];
  const parts: string[] = [];
  if (attention.unread > 0) parts.push(strings.unreadPart(attention.unread));
  if (attention.approvals > 0) parts.push(strings.approvalsPart(attention.approvals));
  if (attention.questions > 0) parts.push(strings.questionsPart(attention.questions));
  return parts.join(' · ');
}

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
  const pendingCount = attention.unread + attention.approvals + attention.questions;
  const template: MenuItemConstructorOptions[] = [];
  if (attention.items.length > 0) {
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
      label: strings.exportDiagnostics,
      click: () => {
        trackDesktopEvent('tray_action', { action: 'export-diagnostics', pending_count: pendingCount });
        actions.exportDiagnostics(locale);
      },
    },
    {
      label: strings.openLogsFolder,
      click: () => {
        trackDesktopEvent('tray_action', { action: 'open-logs-folder', pending_count: pendingCount });
        actions.openLogsFolder();
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
  if (image.isEmpty()) {
    console.warn('[tray] icon not found, tray disabled:', iconPath);
    return null;
  }
  if (process.platform === 'darwin') {
    image.setTemplateImage(true);
  }
  tray = new Tray(image);
  trayActions = actions;
  lastAttention = ZERO_ATTENTION;
  setRuntimeLocale(effectiveTrayLocale());
  renderTray();
  if (process.platform === 'win32') {
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
    const title = trayAttentionTitle(lastAttention);
    tray.setTitle(app.isPackaged ? title : `dev${title}`, { fontType: 'monospacedDigit' });
  }
  app.dock?.setBadge(dockBadgeText(lastAttention));
  const summary = trayAttentionSummary(lastAttention, locale);
  tray.setToolTip(summary === '' ? 'Kimi Code' : `Kimi Code — ${summary}`);
  tray.setContextMenu(buildTrayMenu(trayActions, lastAttention, locale));
}

export function setTrayAttention(attention: TrayAttention): void {
  lastAttention = attention;
  renderTray();
  syncTaskbarAttention();
}

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

export function destroyTray(): void {
  tray?.destroy();
  tray = null;
  trayActions = null;
}
