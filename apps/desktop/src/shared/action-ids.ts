export const APP_ACTION_IDS = [
  'newSession',
  'closeSessionView',
  'searchSessions',
  'archiveSession',
  'toggleSideChat',
  'toggleSidebar',
  'toggleRightPanel',
  'openFolder',
  'openInDefaultApp',
  'openSettings',
  'toggleTerminal',
  'newTerminalTab',
  'openDiffTab',
  'toggleFilesPanel',
  'nextPanelTab',
  'previousPanelTab',
  'sidebarTabOpen',
  'sidebarTabDone',
  'sidebarTabWorkspaces',
  'selectPrevSibling',
  'selectNextSibling',
  'captureScreenshot',
] as const;

export type AppActionId = (typeof APP_ACTION_IDS)[number];

export const SHORTCUT_ACTION_IDS = [
  'summonApp',
  'newSession',
  'closeSessionView',
  'searchSessions',
  'archiveSession',
  'toggleSideChat',
  'toggleSidebar',
  'toggleRightPanel',
  'openFolder',
  'openInDefaultApp',
  'openSettings',
  'toggleTerminal',
  'openDiffTab',
  'toggleFilesPanel',
  'nextPanelTab',
  'previousPanelTab',
  'sidebarTabOpen',
  'sidebarTabDone',
  'sidebarTabWorkspaces',
  'selectPrevSibling',
  'selectNextSibling',
  'captureScreenshot',
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
