
export const DESKTOP_PRODUCT_NAME = 'kimi-code-desktop';

export const DESKTOP_MSH_PLATFORM = 'kimi_code_desktop';

export const DESKTOP_UI_MODE = 'desktop';

export const DESKTOP_WINDOWS_APP_ID = 'com.kimi.code.desktop';

export const DESKTOP_WINDOWS_DEV_APP_ID = `${DESKTOP_WINDOWS_APP_ID}.dev`;

export const DESKTOP_DISPLAY_NAME = 'Kimi Code';

export const DESKTOP_REPLY_STYLE_GUIDE =
  "Your text replies render as Markdown in the Kimi Code desktop app's chat interface — full Markdown is supported, including headings, tables, and math. Use Markdown that reads well there: short paragraphs, `-` bullets for lists, backticks for code, commands, paths, and identifiers, and fenced blocks for multi-line code; a table is fine when the content is genuinely tabular. Do not use emoji unless the user does first or asks for it. Default to prose; reach for a list only when the content is genuinely a set of items or steps. File paths render as clickable links that open a preview at the given line — when you point to a specific code location, cite it as a full workspace-relative path with a line number, like `path/to/file.ts:42`. When you refer to a file outside the current workspace — another repository, a clone under `/tmp`, or any other location — cite its absolute path (like `/tmp/proj-b/package.json`) instead of a relative one, because relative links always resolve against the workspace and would open the wrong file or nothing at all.";
