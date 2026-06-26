import { hostForUrl } from './config';

export interface StartupBannerOptions {
  readonly authToken?: string;
  readonly host: string;
  readonly kimiCodeHome: string;
  readonly port: number;
  readonly lanUrls?: string[];
}

export function formatStartupBanner(options: StartupBannerOptions): string {
  const authStatus = options.authToken === undefined ? 'auth=disabled' : 'auth=required';
  let banner =
    `[vis-server] listening on http://${hostForUrl(options.host)}:${String(options.port)} ` +
    `(${authStatus}, KIMI_CODE_HOME=${options.kimiCodeHome})\n`;
  if (options.lanUrls !== undefined && options.lanUrls.length > 0) {
    banner +=
      `[vis-server] LAN access:\n` +
      options.lanUrls.map((url) => `  - ${url}`).join('\n') +
      '\n';
  }
  return banner;
}
