
import { app, nativeTheme } from 'electron';

export function dataUrl(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

export type ScreenLocale = 'en' | 'zh';
export type ScreenAction = 'retry-connection' | 'export-diagnostics' | 'open-logs-folder' | 'restart-app';
export type StartupStage = 'preparing' | 'server' | 'loading';

export const SCREEN_ACTION_PREFIX = 'kimi-screen-action:';
const SCREEN_ACTIONS: readonly ScreenAction[] = ['retry-connection', 'export-diagnostics', 'open-logs-folder', 'restart-app'];
const FAILURE_ACTIONS: readonly ScreenAction[] = SCREEN_ACTIONS;
const SLOW_STARTUP_ACTIONS: readonly ScreenAction[] = ['export-diagnostics', 'open-logs-folder', 'restart-app'];

export const SCREEN_BACKGROUND = { light: '#ffffff', dark: '#121212' } as const;

const SCREEN_PALETTE = {
  light: {
    text: 'rgba(0, 0, 0, 0.9)',
    muted: 'rgba(0, 0, 0, 0.6)',
    line: 'rgba(0, 0, 0, 0.13)',
    fill: 'rgba(0, 0, 0, 0.05)',
    fillHover: 'rgba(0, 0, 0, 0.1)',
  },
  dark: {
    text: 'rgba(255, 255, 255, 0.84)',
    muted: 'rgba(255, 255, 255, 0.56)',
    line: 'rgba(255, 255, 255, 0.12)',
    fill: 'rgba(255, 255, 255, 0.05)',
    fillHover: 'rgba(255, 255, 255, 0.1)',
  },
} as const;

const SCREEN_STRINGS: Record<ScreenLocale, { title: string; logLabel: string }> = {
  zh: {
    title: '无法启动本地服务',
    logLabel: '日志目录：',
  },
  en: {
    title: 'Failed to start the local server',
    logLabel: 'Logs folder: ',
  },
};

const WAITING_STRINGS: Record<ScreenLocale, { title: string; body: string }> = {
  zh: {
    title: '正在完成更新…',
    body: '正在安装新版本，通常需要几分钟。完成后将自动打开，请勿关闭窗口。',
  },
  en: {
    title: 'Finishing the update…',
    body: 'Kimi Code is installing the new version. This usually takes a few minutes — the app will start automatically when it is done.',
  },
};

const UPDATE_TIMEOUT_STRINGS: Record<ScreenLocale, { title: string; body: string; logLabel: string }> = {
  zh: {
    title: '更新耗时超出预期',
    body: '新版本尚未安装完成，请稍后重试；若多次失败，请重启应用。',
    logLabel: '日志目录：',
  },
  en: {
    title: 'The update is taking longer than expected',
    body: 'The new version has not finished installing yet. Wait a moment and retry; if it keeps failing, restart the app.',
    logLabel: 'Logs folder: ',
  },
};

const STARTUP_STRINGS: Record<
  ScreenLocale,
  { title: string; stages: Record<StartupStage, string>; slowTitle: string; slowBody: string }
> = {
  zh: {
    title: '正在启动 Kimi Code…',
    stages: {
      preparing: '正在准备运行环境',
      server: '正在启动本地服务',
      loading: '正在加载界面',
    },
    slowTitle: '启动时间比平时长',
    slowBody: '可以继续等待，或导出诊断信息发给我们',
  },
  en: {
    title: 'Starting Kimi Code…',
    stages: {
      preparing: 'Preparing the environment',
      server: 'Starting the local server',
      loading: 'Loading the interface',
    },
    slowTitle: 'Startup is taking longer than usual',
    slowBody: 'You can keep waiting, or export diagnostics and send them to us',
  },
};

const ACTION_STRINGS: Record<ScreenLocale, Record<ScreenAction, string>> = {
  zh: {
    'retry-connection': '重试连接',
    'export-diagnostics': '导出诊断信息',
    'open-logs-folder': '打开日志文件夹',
    'restart-app': '重启应用',
  },
  en: {
    'retry-connection': 'Retry connection',
    'export-diagnostics': 'Export diagnostics',
    'open-logs-folder': 'Open logs folder',
    'restart-app': 'Restart app',
  },
};

export function screenLocale(): ScreenLocale {
  try {
    return app.getLocale().toLowerCase().startsWith('zh') ? 'zh' : 'en';
  } catch {
    return 'en';
  }
}

function prefersDark(): boolean {
  try {
    return nativeTheme.shouldUseDarkColors;
  } catch {
    return true;
  }
}

export function screenBackgroundColor(): string {
  return prefersDark() ? SCREEN_BACKGROUND.dark : SCREEN_BACKGROUND.light;
}

export function screenActionFromUrl(url: string): ScreenAction | null {
  if (!url.startsWith(SCREEN_ACTION_PREFIX)) return null;
  const action = url.slice(SCREEN_ACTION_PREFIX.length);
  return SCREEN_ACTIONS.find((candidate) => candidate === action) ?? null;
}

export function startupStageForStep(step: string): StartupStage | null {
  switch (step) {
    case 'window-created':
    case 'shell-env-ready':
      return 'preparing';
    case 'server-start':
      return 'server';
    case 'server-ready':
    case 'load-url':
      return 'loading';
    default:
      return null;
  }
}

export function startupStageText(stage: StartupStage): string {
  return STARTUP_STRINGS[screenLocale()].stages[stage];
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function folderList(folders: readonly string[]): string {
  return folders.map((folder) => `<code>${escapeHtml(folder)}</code>`).join('<br>');
}

function actionLinks(locale: ScreenLocale, actions: readonly ScreenAction[]): string {
  const strings = ACTION_STRINGS[locale];
  const links = actions.map((action) => `<a class="action" href="${SCREEN_ACTION_PREFIX}${action}">${strings[action]}</a>`);
  return `<nav class="actions">${links.join('')}</nav>`;
}

function screenStyle(): string {
  const dark = prefersDark();
  const palette = dark ? SCREEN_PALETTE.dark : SCREEN_PALETTE.light;
  return `
  <style>
    :root { color-scheme: ${dark ? 'dark' : 'light'}; }
    html, body { height: 100%; margin: 0; }
    body {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 16px; background: ${dark ? SCREEN_BACKGROUND.dark : SCREEN_BACKGROUND.light}; color: ${palette.text};
      font: 14px/1.5 system-ui, sans-serif;
      -webkit-user-select: none; user-select: none; text-align: center; padding: 0 32px;
      -webkit-app-region: drag;
    }
    h1 { font-size: 15px; font-weight: 600; margin: 0; }
    h2 { font-size: 14px; font-weight: 600; margin: 0; }
    p { margin: 0; color: ${palette.muted}; max-width: 560px; }
    code { color: ${palette.text}; word-break: break-all; }
    .icon { width: 64px; height: 64px; -webkit-user-drag: none; }
    .spinner {
      width: 24px; height: 24px; border-radius: 50%;
      border: 2px solid ${palette.line}; border-top-color: ${palette.muted};
      animation: kimi-screen-spin 0.9s linear infinite;
    }
    .actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }
    .action {
      -webkit-app-region: no-drag; padding: 6px 14px; border-radius: 8px;
      border: 1px solid ${palette.line}; background: ${palette.fill}; color: ${palette.text};
      font-size: 13px; text-decoration: none; cursor: default;
    }
    .action:hover { background: ${palette.fillHover}; }
    .slow { display: none; flex-direction: column; align-items: center; gap: 12px; margin-top: 8px; }
    body.is-slow .slow { display: flex; }
    @keyframes kimi-screen-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) {
      .spinner { animation: none; }
    }
  </style>
`;
}

export function startupHtml(options: { icon: string | null; stage: StartupStage; slowAfterMs: number }): string {
  const locale = screenLocale();
  const strings = STARTUP_STRINGS[locale];
  const icon = options.icon === null ? '' : `<img class="icon" src="${options.icon}" alt="">`;
  return `<!doctype html><meta charset="utf-8">${screenStyle()}
    ${icon}
    <h1>${strings.title}</h1>
    <div class="spinner" role="status" aria-label="${strings.title}"></div>
    <p id="stage">${strings.stages[options.stage]}</p>
    <div class="slow">
      <h2>${strings.slowTitle}</h2>
      <p>${strings.slowBody}</p>
      ${actionLinks(locale, SLOW_STARTUP_ACTIONS)}
    </div>
    <script>
      window.__kimiStartupStage = (text) => { document.getElementById('stage').textContent = text; };
      setTimeout(() => document.body.classList.add('is-slow'), ${Math.max(0, Math.round(options.slowAfterMs))});
    </script>`;
}

export function errorHtml(message: string, logFolders: readonly string[]): string {
  const locale = screenLocale();
  const strings = SCREEN_STRINGS[locale];
  return `<!doctype html><meta charset="utf-8">${screenStyle()}
    <h1>${strings.title}</h1>
    <p>${escapeHtml(message)}</p>
    <p>${strings.logLabel}${folderList(logFolders)}</p>
    ${actionLinks(locale, FAILURE_ACTIONS)}`;
}

export function waitingHtml(): string {
  const strings = WAITING_STRINGS[screenLocale()];
  return `<!doctype html><meta charset="utf-8">${screenStyle()}
    <div class="spinner" role="status" aria-label="${strings.title}"></div>
    <h1>${strings.title}</h1>
    <p>${strings.body}</p>`;
}

export function updateTimeoutHtml(logFolders: readonly string[]): string {
  const locale = screenLocale();
  const strings = UPDATE_TIMEOUT_STRINGS[locale];
  return `<!doctype html><meta charset="utf-8">${screenStyle()}
    <h1>${strings.title}</h1>
    <p>${strings.body}</p>
    <p>${strings.logLabel}${folderList(logFolders)}</p>
    ${actionLinks(locale, FAILURE_ACTIONS)}`;
}
