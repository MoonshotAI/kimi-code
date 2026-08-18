export const APP_ACTION_IDS = [
  'newSession',
  'searchSessions',
  'archiveSession',
  'toggleSideChat',
  'toggleSidebar',
  'openFolder',
  'openInDefaultApp',
  'openSettings',
  'toggleTerminal',
  'sidebarTabOpen',
  'sidebarTabDone',
  'sidebarTabWorkspaces',
  'selectPrevSibling',
  'selectNextSibling',
] as const;

export type AppActionId = (typeof APP_ACTION_IDS)[number];

export const SHORTCUT_ACTION_IDS = [
  'summonApp',
  ...APP_ACTION_IDS,
  'composer.send',
  'composer.newline',
] as const;

export type ShortcutActionId = (typeof SHORTCUT_ACTION_IDS)[number];

export const ACTION_INVOKED_IDS = [
  ...APP_ACTION_IDS,
  'select-all',
  'retry-connection',
] as const;

export type ActionInvokedId = (typeof ACTION_INVOKED_IDS)[number];

const APP_ACTION_ID_SET: ReadonlySet<string> = new Set(APP_ACTION_IDS);

export function isAppActionId(value: string): value is AppActionId {
  return APP_ACTION_ID_SET.has(value);
}
