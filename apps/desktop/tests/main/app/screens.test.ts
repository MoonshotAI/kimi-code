import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ locale: 'zh-CN', dark: false }));

vi.mock('electron', () => ({
  app: { getLocale: () => mocks.locale },
  nativeTheme: {
    get shouldUseDarkColors() {
      return mocks.dark;
    },
  },
}));

import {
  SCREEN_BACKGROUND,
  errorHtml,
  screenActionFromUrl,
  startupHtml,
  startupStageForStep,
  updateTimeoutHtml,
  waitingHtml,
} from '../../../src/main/app/screens';

beforeEach(() => {
  mocks.locale = 'zh-CN';
  mocks.dark = false;
});

describe('startup failure screens', () => {
  it('lists every logs folder, escaped, below the error', () => {
    const html = errorHtml('listen <EADDRINUSE>', ['/home/example/.kimi-code/logs', '/tmp/a&b/logs']);
    expect(html).toContain('<p>listen &lt;EADDRINUSE&gt;</p>');
    expect(html).toContain('<p>日志目录：<code>/home/example/.kimi-code/logs</code><br><code>/tmp/a&amp;b/logs</code></p>');
  });

  it('offers retry, export, logs folder and restart as buttons instead of menu paths', () => {
    for (const html of [errorHtml('boom', ['/logs']), updateTimeoutHtml(['/logs'])]) {
      expect(html).toContain('<a class="action" href="kimi-screen-action:retry-connection">重试连接</a>');
      expect(html).toContain('<a class="action" href="kimi-screen-action:export-diagnostics">导出诊断信息</a>');
      expect(html).toContain('<a class="action" href="kimi-screen-action:open-logs-folder">打开日志文件夹</a>');
      expect(html).toContain('<a class="action" href="kimi-screen-action:restart-app">重启应用</a>');
      expect(html).not.toContain('→');
      expect(html).toMatch(/\.action \{[^}]*-webkit-app-region: no-drag/);
    }
  });
});

describe('startup screen', () => {
  it('shows the current step and reveals the slow-start actions after the stall threshold', () => {
    const html = startupHtml({ icon: null, stage: 'server', slowAfterMs: 10_000 });
    expect(html).toContain('<h1>正在启动 Kimi Code…</h1>');
    expect(html).toContain('<p id="stage">正在启动本地服务</p>');
    expect(html).toContain('<h2>启动时间比平时长</h2>');
    expect(html).toContain('kimi-screen-action:export-diagnostics');
    expect(html).toContain('kimi-screen-action:restart-app');
    expect(html).not.toContain('kimi-screen-action:retry-connection');
    expect(html).toContain("setTimeout(() => document.body.classList.add('is-slow'), 10000)");
    expect(html).toContain('body.is-slow .slow { display: flex; }');
    expect(html).not.toContain('<img');
  });

  it('shows the app icon when one is available and follows an English locale', () => {
    mocks.locale = 'en-US';
    const html = startupHtml({ icon: 'data:image/png;base64,AAAA', stage: 'preparing', slowAfterMs: 10_000 });
    expect(html).toContain('<img class="icon" src="data:image/png;base64,AAAA" alt="">');
    expect(html).toContain('<h1>Starting Kimi Code…</h1>');
    expect(html).toContain('<p id="stage">Preparing the environment</p>');
    expect(html).toContain('>Export diagnostics</a>');
    expect(errorHtml('x', ['/logs'])).toContain('<p>Logs folder: <code>/logs</code></p>');
  });

  it('maps startup steps to the stage shown on screen', () => {
    expect(
      ['window-created', 'shell-env-ready', 'server-start', 'server-ready', 'load-url', 'ui-mounted'].map(startupStageForStep),
    ).toEqual(['preparing', 'preparing', 'server', 'loading', 'loading', null]);
  });
});

describe('screen theme', () => {
  it('paints every screen with the app background of the current theme', () => {
    expect(waitingHtml()).toContain(`background: ${SCREEN_BACKGROUND.light};`);
    expect(waitingHtml()).toContain('color-scheme: light');
    mocks.dark = true;
    expect(waitingHtml()).toContain(`background: ${SCREEN_BACKGROUND.dark};`);
    expect(startupHtml({ icon: null, stage: 'loading', slowAfterMs: 1 })).toContain('color-scheme: dark');
    expect(errorHtml('x', [])).toContain(`background: ${SCREEN_BACKGROUND.dark};`);
  });
});

describe('screenActionFromUrl', () => {
  it('accepts only the known actions behind the screen action prefix', () => {
    expect(screenActionFromUrl('kimi-screen-action:restart-app')).toBe('restart-app');
    expect(screenActionFromUrl('kimi-screen-action:export-diagnostics')).toBe('export-diagnostics');
    expect(screenActionFromUrl('kimi-screen-action:rm-rf')).toBeNull();
    expect(screenActionFromUrl('https://example.com/kimi-screen-action:restart-app')).toBeNull();
  });
});
