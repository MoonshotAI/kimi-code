// IPC channel names used by the main-process modules. The preload bridge
// (preload.ts) keeps its own string literals by design; preload.test.ts pins
// the exposed mapping, so a rename here without a matching preload change
// fails tests.
export const IPC = {
  theme: 'kimi:theme',
  openExternal: 'kimi:open-external',
  dialogOpen: 'kimi:dialog-open',
  dialogSave: 'kimi:dialog-save',
  openInList: 'kimi:open-in-list',
  openInApp: 'kimi:open-in',
  getServerToken: 'kimi:get-server-token',
  isFullscreen: 'kimi:is-fullscreen',
  menuAction: 'kimi:menu-action',
  menuPopup: 'kimi:menu-popup',
  shortcut: 'kimi:shortcut',
  fullscreenChanged: 'kimi:fullscreen-changed',
  updateStatus: 'kimi:update-status',
  updateGetStatus: 'kimi:update-get-status',
  updateCheck: 'kimi:update-check',
  updateDownload: 'kimi:update-download',
  updateInstall: 'kimi:update-install',
  updateGetAutoDownload: 'kimi:update-get-auto-download',
  updateSetAutoDownload: 'kimi:update-set-auto-download',
  trayAttention: 'kimi:tray-attention',
  traySelectSession: 'kimi:tray-select-session',
  dockIconChoice: 'kimi:dock-icon-choice',
  osAppearance: 'kimi:os-appearance',
  osAppearanceChanged: 'kimi:os-appearance-changed',
  locale: 'kimi:locale',
  menuShortcut: 'kimi:menu-shortcut',
  menuSuspend: 'kimi:menu-suspend',
  globalShortcut: 'kimi:global-shortcut',
  globalShortcutSuspend: 'kimi:global-shortcut-suspend',
  setOnboarded: 'kimi:set-onboarded',
  vibrancy: 'kimi:vibrancy',
  getVibrancy: 'kimi:get-vibrancy',
  showWindow: 'kimi:show-window',
  rendererLog: 'kimi:renderer-log',
  jumpList: 'kimi:jump-list',
  launchAction: 'kimi:launch-action',
  track: 'kimi:track',
} as const;

export type ColorScheme = 'light' | 'dark' | 'system';

export type WindowsMenuId = 'file' | 'edit' | 'view' | 'help';

export interface WindowsMenuPopupRequest {
  id: WindowsMenuId;
  x: number;
  y: number;
}

/** Launch intent parsed from argv (--new-chat / --workspace=<root>) or a
    Jump List item click, forwarded to the renderer once it is ready. */
export type LaunchActionPayload = { action: 'new-chat' } | { action: 'open-workspace'; root: string };

// Channels that carry main → renderer events (see window.ts sendToRenderer).
export type RendererEventChannel =
  | typeof IPC.menuAction
  | typeof IPC.shortcut
  | typeof IPC.fullscreenChanged
  | typeof IPC.updateStatus
  | typeof IPC.traySelectSession
  | typeof IPC.launchAction
  | typeof IPC.osAppearanceChanged;
