import { beforeEach, describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import type { MenuItemConstructorOptions } from 'electron';
import {
  asTrayAttention,
  dockBadgeText,
  trayAttentionItemLabel,
  trayAttentionSummary,
  trayAttentionTitle,
  trayIconPath,
  trayOpenLabel,
  type TrayAttention,
} from '../../../src/main/shell/tray';

const mocks = vi.hoisted(() => ({
  trackDesktopEvent: vi.fn(),
  setRuntimeLocale: vi.fn(),
  buildFromTemplate: vi.fn((template: unknown) => template),
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getAppPath: () => '/app',
    getLocale: () => 'en-US',
  },
  Menu: { buildFromTemplate: mocks.buildFromTemplate },
  nativeImage: {
    createFromPath: () => ({ isEmpty: () => false, setTemplateImage: vi.fn() }),
  },
  Tray: class {
    setTitle = vi.fn();
    setToolTip = vi.fn();
    setContextMenu = vi.fn();
    on = vi.fn();
    destroy = vi.fn();
  },
}));

vi.mock('../../../src/main/diagnostics/track', () => ({
  trackDesktopEvent: mocks.trackDesktopEvent,
  setRuntimeLocale: mocks.setRuntimeLocale,
  trySendDesktopEvent: vi.fn(),
}));

Object.defineProperty(process, 'resourcesPath', { value: '/resources' });

function attention(partial: Partial<TrayAttention> = {}): TrayAttention {
  return { unread: 0, approvals: 0, questions: 0, items: [], ...partial };
}

describe('trayIconPath', () => {
  it('uses the .ico asset on Windows', () => {
    expect(
      trayIconPath({ platform: 'win32', isPackaged: false, resourcesPath: '/res', appPath: '/repo' }),
    ).toBe(join('/repo', 'build', 'tray.ico'));
  });

  it('uses the monochrome template image on macOS (OS re-colors for light/dark menu bar)', () => {
    expect(
      trayIconPath({ platform: 'darwin', isPackaged: false, resourcesPath: '/res', appPath: '/repo' }),
    ).toBe(join('/repo', 'build', 'trayTemplate.png'));
  });

  it('uses the color png on Linux (retina @2x resolved by nativeImage)', () => {
    expect(
      trayIconPath({ platform: 'linux', isPackaged: false, resourcesPath: '/res', appPath: '/repo' }),
    ).toBe(join('/repo', 'build', 'tray.png'));
  });

  it('resolves under resourcesPath (extraResources) when packaged', () => {
    expect(
      trayIconPath({ platform: 'darwin', isPackaged: true, resourcesPath: '/res', appPath: '/repo' }),
    ).toBe(join('/res', 'build', 'trayTemplate.png'));
  });
});

describe('trayOpenLabel', () => {
  it('names the app explicitly in both locales', () => {
    expect(trayOpenLabel('zh')).toBe('打开 Kimi Code');
    expect(trayOpenLabel('en')).toBe('Open Kimi Code');
  });
});

describe('asTrayAttention', () => {
  it('accepts a well-formed payload with attention items', () => {
    expect(
      asTrayAttention({
        unread: 3,
        approvals: 2,
        questions: 1,
        items: [
          { sessionId: 's1', title: '设计新的打包方案', unread: true, approvals: 0, questions: 0 },
          { sessionId: 's2', title: '修复测试', unread: false, approvals: 2, questions: 0 },
        ],
      }),
    ).toEqual({
      unread: 3,
      approvals: 2,
      questions: 1,
      items: [
        { sessionId: 's1', title: '设计新的打包方案', unread: true, approvals: 0, questions: 0 },
        { sessionId: 's2', title: '修复测试', unread: false, approvals: 2, questions: 0 },
      ],
    });
  });

  it('floors fractional counts and caps runaway values', () => {
    expect(
      asTrayAttention({
        unread: 2.9,
        approvals: 10000,
        questions: 0,
        items: [
          { sessionId: 's1', title: 't', unread: true, approvals: 1.9, questions: 0 },
        ],
      }),
    ).toEqual({
      unread: 2,
      approvals: 999,
      questions: 0,
      items: [{ sessionId: 's1', title: 't', unread: true, approvals: 1, questions: 0 }],
    });
  });

  it('drops malformed payloads (non-object, missing/wrong/negative fields)', () => {
    expect(asTrayAttention(null)).toBeNull();
    expect(asTrayAttention('3')).toBeNull();
    expect(asTrayAttention({ unread: 1, approvals: 0, questions: 0 })).toBeNull();
    expect(asTrayAttention({ unread: 1, approvals: 0, questions: 0, items: 'x' })).toBeNull();
    expect(asTrayAttention({ unread: 1, approvals: '2', questions: 0, items: [] })).toBeNull();
    expect(asTrayAttention({ unread: -1, approvals: 0, questions: 0, items: [] })).toBeNull();
    expect(asTrayAttention({ unread: Number.NaN, approvals: 0, questions: 0, items: [] })).toBeNull();
  });

  it('drops payloads with malformed items', () => {
    const base = { unread: 1, approvals: 0, questions: 0 };
    expect(asTrayAttention({ ...base, items: [{ title: 't', unread: true, approvals: 0, questions: 0 }] })).toBeNull();
    expect(
      asTrayAttention({ ...base, items: [{ sessionId: '', title: 't', unread: true, approvals: 0, questions: 0 }] }),
    ).toBeNull();
    expect(
      asTrayAttention({ ...base, items: [{ sessionId: 's1', title: 't', unread: 'yes', approvals: 0, questions: 0 }] }),
    ).toBeNull();
    expect(
      asTrayAttention({ ...base, items: [{ sessionId: 's1', title: 't', unread: true, approvals: -1, questions: 0 }] }),
    ).toBeNull();
    expect(asTrayAttention({ ...base, items: ['s1'] })).toBeNull();
  });
});

describe('trayAttentionTitle', () => {
  it('is the bare grand total', () => {
    expect(trayAttentionTitle(attention({ unread: 3, approvals: 2, questions: 1 }))).toBe('6');
    expect(trayAttentionTitle(attention({ questions: 1 }))).toBe('1');
  });

  it('is empty when nothing pends (icon-only menu bar)', () => {
    expect(trayAttentionTitle(attention())).toBe('');
  });
});

describe('dockBadgeText', () => {
  it('shows the total pending count', () => {
    expect(dockBadgeText(attention({ unread: 1 }))).toBe('1');
    expect(dockBadgeText(attention({ approvals: 2 }))).toBe('2');
    expect(dockBadgeText(attention({ questions: 1 }))).toBe('1');
    expect(dockBadgeText(attention({ unread: 3, approvals: 2, questions: 1 }))).toBe('6');
  });

  it('is empty when nothing needs attention', () => {
    expect(dockBadgeText(attention())).toBe('');
  });
});

describe('trayAttentionSummary', () => {
  it('joins the per-kind breakdown in a stable order (zh)', () => {
    expect(trayAttentionSummary(attention({ unread: 3, approvals: 2, questions: 1 }), 'zh')).toBe(
      '3 条未读 · 2 个待批准 · 1 个待回答',
    );
  });

  it('joins the per-kind breakdown in English', () => {
    expect(trayAttentionSummary(attention({ unread: 3, approvals: 2, questions: 1 }), 'en')).toBe(
      '3 unread · 2 to approve · 1 to answer',
    );
  });

  it('omits kinds with a zero count', () => {
    expect(trayAttentionSummary(attention({ approvals: 2 }), 'zh')).toBe('2 个待批准');
    expect(trayAttentionSummary(attention({ approvals: 2 }), 'en')).toBe('2 to approve');
  });

  it('is empty when nothing pends (no menu header, plain tooltip)', () => {
    expect(trayAttentionSummary(attention(), 'zh')).toBe('');
  });
});

describe('trayAttentionItemLabel', () => {
  it('is the bare title for unread-only sessions', () => {
    expect(
      trayAttentionItemLabel({ sessionId: 's1', title: '设计新的打包方案', unread: true, approvals: 0, questions: 0 }, 'zh'),
    ).toBe('设计新的打包方案');
  });

  it('appends the actionable kinds after the title (zh and en)', () => {
    const item = { sessionId: 's1', title: '评估计划', unread: true, approvals: 1, questions: 3 };
    expect(trayAttentionItemLabel(item, 'zh')).toBe('评估计划 · 1 待批准 · 3 待回答');
    expect(trayAttentionItemLabel(item, 'en')).toBe('评估计划 · 1 to approve · 3 to answer');
    expect(
      trayAttentionItemLabel({ sessionId: 's1', title: '评估计划', unread: false, approvals: 2, questions: 0 }, 'zh'),
    ).toBe('评估计划 · 2 待批准');
  });

  it('collapses whitespace/newlines and truncates long titles', () => {
    expect(
      trayAttentionItemLabel({ sessionId: 's1', title: '  多行\n标题\t整理 ', unread: true, approvals: 0, questions: 0 }, 'zh'),
    ).toBe('多行 标题 整理');
    const title = '这是一个非常长的会话标题'.repeat(4);
    const long = trayAttentionItemLabel({ sessionId: 's1', title, unread: true, approvals: 0, questions: 0 }, 'zh');
    expect(long).toBe(`${title.slice(0, 32)}…`);
    expect(long.length).toBe(33);
  });

  it('falls back to a localized unnamed-session placeholder for an empty title', () => {
    const item = { sessionId: 's1', title: '   ', unread: true, approvals: 0, questions: 0 };
    expect(trayAttentionItemLabel(item, 'zh')).toBe('未命名会话');
    expect(trayAttentionItemLabel(item, 'en')).toBe('Untitled session');
  });
});

describe('tray telemetry', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function importTray(): Promise<typeof import('../../../src/main/shell/tray')> {
    return import('../../../src/main/shell/tray');
  }

  function fakeActions(): {
    showMainWindow: ReturnType<typeof vi.fn<() => void>>;
    openSession: ReturnType<typeof vi.fn<(sessionId: string) => void>>;
    exportDiagnostics: ReturnType<typeof vi.fn<(locale: 'en' | 'zh') => void>>;
    openLogsFolder: ReturnType<typeof vi.fn<() => void>>;
    quit: ReturnType<typeof vi.fn<() => void>>;
  } {
    return {
      showMainWindow: vi.fn<() => void>(),
      openSession: vi.fn<(sessionId: string) => void>(),
      exportDiagnostics: vi.fn<(locale: 'en' | 'zh') => void>(),
      openLogsFolder: vi.fn<() => void>(),
      quit: vi.fn<() => void>(),
    };
  }

  function lastTemplate(): MenuItemConstructorOptions[] {
    const template = mocks.buildFromTemplate.mock.calls.at(-1)?.[0];
    expect(template, 'tray menu was (re)built').toBeDefined();
    return template as MenuItemConstructorOptions[];
  }

  function clickItem(item: MenuItemConstructorOptions | undefined): void {
    expect(item, 'menu item exists').toBeDefined();
    (item?.click as (() => void) | undefined)?.();
  }

  it('tracks open-session clicks from the attention entries, with the pending total', async () => {
    const { createTray, setTrayAttention } = await importTray();
    const actions = fakeActions();
    createTray(actions);
    setTrayAttention(
      attention({
        unread: 3,
        items: [{ sessionId: 's1', title: 'Fix tests', unread: true, approvals: 0, questions: 0 }],
      }),
    );
    clickItem(lastTemplate().find((item) => item.label === 'Fix tests'));
    expect(actions.openSession).toHaveBeenCalledWith('s1');
    expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('tray_action', {
      action: 'open-session',
      pending_count: 3,
    });
  });

  it('tracks show-window and quit with the pending total', async () => {
    const { createTray, setTrayAttention } = await importTray();
    const actions = fakeActions();
    createTray(actions);
    setTrayAttention(attention({ unread: 2, approvals: 1 }));
    const template = lastTemplate();
    clickItem(template.find((item) => item.label === trayOpenLabel('en')));
    expect(actions.showMainWindow).toHaveBeenCalledOnce();
    expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('tray_action', {
      action: 'show-window',
      pending_count: 3,
    });
    clickItem(template.find((item) => item.label === 'Quit'));
    expect(actions.quit).toHaveBeenCalledOnce();
    expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('tray_action', {
      action: 'quit',
      pending_count: 3,
    });
  });

  it('offers diagnostics export and the logs folder above Quit, in the tray locale', async () => {
    const { createTray, setTrayLocale } = await importTray();
    const actions = fakeActions();
    createTray(actions);
    setTrayLocale('zh');
    const template = lastTemplate();
    const labels = template.map((item) => item.label ?? item.type);
    expect(labels.slice(-5)).toEqual(['separator', '导出诊断信息…', '打开日志文件夹', 'separator', '退出']);
    clickItem(template.find((item) => item.label === '导出诊断信息…'));
    expect(actions.exportDiagnostics).toHaveBeenCalledWith('zh');
    expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('tray_action', {
      action: 'export-diagnostics',
      pending_count: 0,
    });
    clickItem(template.find((item) => item.label === '打开日志文件夹'));
    expect(actions.openLogsFolder).toHaveBeenCalledOnce();
    expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('tray_action', {
      action: 'open-logs-folder',
      pending_count: 0,
    });
  });

  it('reports a zero pending count when nothing needs attention', async () => {
    const { createTray } = await importTray();
    const actions = fakeActions();
    createTray(actions);
    clickItem(lastTemplate().find((item) => item.label === trayOpenLabel('en')));
    expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('tray_action', {
      action: 'show-window',
      pending_count: 0,
    });
  });
});
