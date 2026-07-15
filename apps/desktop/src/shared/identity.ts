/**
 * Desktop host identity — the single source of truth for how the app
 * identifies itself:
 *
 *  - main process → upstream model API (User-Agent + X-Msh-* headers,
 *    see src/main/server.ts)
 *  - renderer → local server (clientName / clientVersion / clientUiMode,
 *    see src/renderer/api/config.ts)
 */

/** Product token: User-Agent product (main process) and client name (renderer). */
export const DESKTOP_PRODUCT_NAME = 'kimi-code-desktop';

/** X-Msh-Platform header value sent to the upstream model API. */
export const DESKTOP_MSH_PLATFORM = 'kimi_code_desktop';

/** UI mode the renderer reports to the local server. */
export const DESKTOP_UI_MODE = 'desktop';
