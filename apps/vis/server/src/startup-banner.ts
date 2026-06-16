import { hostForUrl } from './config';

export interface StartupBannerOptions {
  readonly authToken?: string;
  readonly host: string;
  readonly kimiCodeHome: string;
  readonly port: number;
}

export function formatStartupBanner(options: StartupBannerOptions): string {
  const authStatus = options.authToken === undefined ? 'auth=disabled' : 'auth=required';
  return (
    `[vis-server] listening on http://${hostForUrl(options.host)}:${String(options.port)} ` +
    `(${authStatus}, KIMI_CODE_HOME=${options.kimiCodeHome})\n`
  );
}
