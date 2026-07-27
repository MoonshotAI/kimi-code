// --- startup screens (no separate renderer files; inline data URLs) -----------

import { app } from 'electron';

export function dataUrl(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

// This page shows when the renderer never came up, so the renderer-pushed
// locale (kimi:locale) is unavailable — fall back to the OS language.
const SCREEN_STRINGS: Record<'en' | 'zh', { title: string; logLabel: string; hint: string }> = {
  zh: {
    title: '无法启动本地服务',
    logLabel: '查看日志：',
    hint: '菜单 → Kimi Code → 重试连接，或先检查日志。',
  },
  en: {
    title: 'Failed to start the local server',
    logLabel: 'See the log at:',
    hint: 'Menu → Kimi Code → Retry Connection, or check the log first.',
  },
};

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

const SCREEN_STYLE = `
  <style>
    html, body { height: 100%; margin: 0; }
    body {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 18px; background: #0b0b0c; color: #e7e7ea; font: 14px/1.5 system-ui, sans-serif;
      -webkit-user-select: none; user-select: none; text-align: center; padding: 0 32px;
    }
    h1 { font-size: 15px; font-weight: 600; margin: 0; }
    p { margin: 0; color: #9a9aa2; max-width: 560px; }
    code { color: #c8c8d0; word-break: break-all; }
  </style>
`;

export function errorHtml(message: string, logPath: string): string {
  let strings: (typeof SCREEN_STRINGS)['en'] = SCREEN_STRINGS.en;
  try {
    if (app.getLocale().toLowerCase().startsWith('zh')) strings = SCREEN_STRINGS.zh;
  } catch {
    // App not ready yet — keep the English default.
  }
  return `<!doctype html><meta charset="utf-8">${SCREEN_STYLE}
    <h1>${strings.title}</h1>
    <p>${escapeHtml(message)}</p>
    <p>${strings.logLabel}<code>${escapeHtml(logPath)}</code></p>
    <p>${strings.hint}</p>`;
}
