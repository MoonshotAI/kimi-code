/**
 * Desktop host identity — the single source of truth for how the app
 * identifies itself:
 *
 *  - main process → upstream model API (User-Agent + X-Msh-* headers,
 *    see src/main/server.ts)
 *  - renderer → local server (clientName / clientVersion / clientUiMode,
 *    see src/renderer/api/config.ts)
 *  - main process → agent system prompt (productName / replyStyleGuide,
 *    see src/main/server.ts)
 */

/** Product token: User-Agent product (main process) and client name (renderer). */
export const DESKTOP_PRODUCT_NAME = 'kimi-code-desktop';

/** X-Msh-Platform header value sent to the upstream model API. */
export const DESKTOP_MSH_PLATFORM = 'kimi_code_desktop';

/** UI mode the renderer reports to the local server. */
export const DESKTOP_UI_MODE = 'desktop';

/** Windows taskbar / notification identity; matches electron-builder `appId`. */
export const DESKTOP_WINDOWS_APP_ID = 'com.kimi.code.desktop';

/** Keeps unpackaged Electron launches from claiming the installed app's shell identity. */
export const DESKTOP_WINDOWS_DEV_APP_ID = `${DESKTOP_WINDOWS_APP_ID}.dev`;

/**
 * Display name rendered into the base system prompt's ${product_name} slot
 * (the CLI default is "Kimi Code CLI"). Matches the electron-builder
 * productName / window title.
 */
export const DESKTOP_DISPLAY_NAME = 'Kimi Code';

/** Replaces the base system prompt's ${reply_style_guide} block (the CLI default describes a terminal). */
export const DESKTOP_REPLY_STYLE_GUIDE =
  "Your text replies render as Markdown in the Kimi Code desktop app's chat interface — full Markdown is supported, including headings, tables, and math. Use Markdown that reads well there: short paragraphs, `-` bullets for lists, backticks for code, commands, paths, and identifiers, and fenced blocks for multi-line code; a table is fine when the content is genuinely tabular. Do not use emoji unless the user does first or asks for it. Default to prose; reach for a list only when the content is genuinely a set of items or steps. File paths render as clickable links that open a preview at the given line — when you point to a specific code location, cite it as a full workspace-relative path with a line number, like `path/to/file.ts:42`.";
