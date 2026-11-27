import { ipcRenderer } from 'electron';
import { asQuitConfirmDetails, type QuitBlockReason, type QuitConfirmDetails } from '../../../shared/quit-confirm';
import { asGlobalShortcutResult, type GlobalShortcutResult } from '../../../shared/global-shortcut';

export type LinuxNativeTitleBarResult = { status: 'relaunching' | 'cancelled' | 'unavailable' | 'error' };

const LINUX_NATIVE_TITLEBAR_STATUSES = new Set(['relaunching', 'cancelled', 'unavailable', 'error']);

function asLinuxNativeTitleBarResult(value: unknown): LinuxNativeTitleBarResult | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = value as { status?: unknown };
  if (typeof candidate.status !== 'string' || !LINUX_NATIVE_TITLEBAR_STATUSES.has(candidate.status)) {
    return null;
  }
  return { status: candidate.status as LinuxNativeTitleBarResult['status'] };
}

export type TrayAttentionItem = {
  sessionId: string;
  title: string;
  unread: boolean;
  approvals: number;
  questions: number;
};
export type TrayAttention = {
  unread: number;
  approvals: number;
  questions: number;
  items: TrayAttentionItem[];
};

function asCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function asTrayAttentionItem(value: unknown): value is TrayAttentionItem {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as {
    sessionId?: unknown;
    title?: unknown;
    unread?: unknown;
    approvals?: unknown;
    questions?: unknown;
  };
  return (
    typeof candidate.sessionId === 'string' &&
    candidate.sessionId !== '' &&
    typeof candidate.title === 'string' &&
    typeof candidate.unread === 'boolean' &&
    asCount(candidate.approvals) &&
    asCount(candidate.questions)
  );
}

function asTrayAttention(value: unknown): value is TrayAttention {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as {
    unread?: unknown;
    approvals?: unknown;
    questions?: unknown;
    items?: unknown;
  };
  return (
    asCount(candidate.unread) &&
    asCount(candidate.approvals) &&
    asCount(candidate.questions) &&
    Array.isArray(candidate.items) &&
    candidate.items.every(asTrayAttentionItem)
  );
}

export type JumpListWorkspace = { name: string; root: string };

function asJumpListWorkspaces(value: unknown): value is JumpListWorkspace[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as { name?: unknown }).name === 'string' &&
        typeof (item as { root?: unknown }).root === 'string' &&
        (item as { root: string }).root !== '',
    )
  );
}

export type LaunchActionPayload =
  | { action: 'new-chat' }
  | { action: 'open-workspace'; root: string; newChat?: boolean }
  | { action: 'open-session'; sessionId: string };

function asLaunchActionPayload(value: unknown): LaunchActionPayload | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = value as { action?: unknown; root?: unknown; newChat?: unknown; sessionId?: unknown };
  if (candidate.action === 'new-chat') {
    return { action: 'new-chat' };
  }
  if (candidate.action === 'open-session' && typeof candidate.sessionId === 'string' && candidate.sessionId !== '') {
    return { action: 'open-session', sessionId: candidate.sessionId };
  }
  if (candidate.action === 'open-workspace' && typeof candidate.root === 'string' && candidate.root !== '') {
    if (candidate.newChat !== undefined && typeof candidate.newChat !== 'boolean') return null;
    return { action: 'open-workspace', root: candidate.root, newChat: candidate.newChat };
  }
  return null;
}

export type WindowBridge = {
  sessionLinksSupported: boolean;
  setTheme: (scheme: 'light' | 'dark' | 'system') => void;
  popupWindowsMenu: (request: {
    id: 'file' | 'edit' | 'view' | 'help';
    x: number;
    y: number;
  }) => Promise<{ opened: boolean }>;
  setDockIconChoice: (choice: 'light' | 'dark') => void;
  onMenuAction: (cb: (id: string) => void) => () => void;
  onShortcut: (cb: (accel: string) => void) => () => void;
  setOnboarded: () => void;
  isFullscreen: () => Promise<boolean>;
  onFullscreenChanged: (cb: (fullscreen: boolean) => void) => () => void;
  setTrayAttention: (attention: TrayAttention) => void;
  onTraySelectSession: (cb: (sessionId: string) => void) => () => void;
  setLocale: (locale: 'en' | 'zh') => void;
  setMenuShortcuts: (bindings: Record<string, string | null>) => void;
  setMenuSuspended: (suspended: boolean) => void;
  setTerminalMenuFocus: (focused: boolean) => void;
  setGlobalShortcut: (action: string, binding: string | null) => Promise<GlobalShortcutResult>;
  setGlobalShortcutSuspended: (suspended: boolean) => Promise<boolean>;
  showWindow: () => void;
  hideWindow: () => void;
  showSelectionContextMenu: (selectionText: string) => void;
  setJumpList: (workspaces: JumpListWorkspace[]) => void;
  onLaunchAction: (cb: (payload: LaunchActionPayload) => void) => () => void;
  onQuitConfirm: (
    cb: (requestId: number, reasons: QuitBlockReason[], details: QuitConfirmDetails) => void,
  ) => () => void;
  onQuitConfirmCancel: (cb: (requestId: number) => void) => () => void;
  respondQuitConfirm: (
    choice: 'quit' | 'cancel' | 'unavailable',
    requestId: number,
    continueSessions?: boolean,
  ) => Promise<void>;
  onDeepLinkAuth: (cb: () => void) => () => void;
  setVibrancy: (enabled: boolean) => void;
  getVibrancy: () => Promise<boolean>;
  setLinuxNativeTitleBar: (enabled: boolean) => Promise<LinuxNativeTitleBarResult>;
};

export const windowBridge: WindowBridge = {
  sessionLinksSupported: process.argv.includes('--kimi-session-links'),
  setTheme: (scheme) => {
    if (scheme === 'light' || scheme === 'dark' || scheme === 'system') {
      ipcRenderer.send('kimi:theme', scheme);
    }
  },
  popupWindowsMenu: (request) => ipcRenderer.invoke('kimi:menu-popup', request),
  setDockIconChoice: (choice) => {
    if (choice === 'light' || choice === 'dark') {
      ipcRenderer.send('kimi:dock-icon-choice', choice);
    }
  },
  onMenuAction: (cb) => {
    const listener = (_event: unknown, id: string) => cb(id);
    ipcRenderer.on('kimi:menu-action', listener);
    return () => ipcRenderer.removeListener('kimi:menu-action', listener);
  },
  onShortcut: (cb) => {
    const listener = (_event: unknown, accel: string) => cb(accel);
    ipcRenderer.on('kimi:shortcut', listener);
    return () => ipcRenderer.removeListener('kimi:shortcut', listener);
  },
  setOnboarded: () => ipcRenderer.send('kimi:set-onboarded'),
  isFullscreen: () => ipcRenderer.invoke('kimi:is-fullscreen'),
  onFullscreenChanged: (cb) => {
    const listener = (_event: unknown, flag: unknown) => cb(flag === true);
    ipcRenderer.on('kimi:fullscreen-changed', listener);
    return () => ipcRenderer.removeListener('kimi:fullscreen-changed', listener);
  },
  setTrayAttention: (attention) => {
    if (asTrayAttention(attention)) {
      ipcRenderer.send('kimi:tray-attention', attention);
    }
  },
  onTraySelectSession: (cb) => {
    const listener = (_event: unknown, sessionId: unknown) => {
      if (typeof sessionId === 'string' && sessionId !== '') {
        cb(sessionId);
      }
    };
    ipcRenderer.on('kimi:tray-select-session', listener);
    return () => ipcRenderer.removeListener('kimi:tray-select-session', listener);
  },
  setLocale: (locale) => {
    if (locale === 'en' || locale === 'zh') {
      ipcRenderer.send('kimi:locale', locale);
    }
  },
  setMenuShortcuts: (bindings) => {
    if (bindings !== null && typeof bindings === 'object' && !Array.isArray(bindings)) {
      ipcRenderer.send('kimi:menu-shortcut', bindings);
    }
  },
  setMenuSuspended: (suspended) => {
    if (typeof suspended === 'boolean') {
      ipcRenderer.send('kimi:menu-suspend', suspended);
    }
  },
  setTerminalMenuFocus: (focused) => {
    if (typeof focused === 'boolean') {
      ipcRenderer.send('kimi:menu-terminal-focus', focused);
    }
  },
  setGlobalShortcut: async (action, binding) => {
    if (typeof action !== 'string' || (binding !== null && typeof binding !== 'string')) {
      return { ok: false, reason: 'invalid' };
    }
    const result: unknown = await ipcRenderer.invoke('kimi:global-shortcut', { action, binding });
    return asGlobalShortcutResult(result) ?? { ok: false, reason: 'conflicted' };
  },
  setGlobalShortcutSuspended: async (suspended) => {
    if (typeof suspended !== 'boolean') {
      return false;
    }
    const result: unknown = await ipcRenderer.invoke('kimi:global-shortcut-suspend', suspended);
    return result === true;
  },
  showWindow: () => {
    ipcRenderer.send('kimi:show-window');
  },
  hideWindow: () => {
    ipcRenderer.send('kimi:hide-window');
  },
  showSelectionContextMenu: (selectionText) => {
    ipcRenderer.send('kimi:selection-context-menu', selectionText);
  },
  setJumpList: (workspaces) => {
    if (asJumpListWorkspaces(workspaces)) {
      ipcRenderer.send('kimi:jump-list', workspaces);
    }
  },
  onLaunchAction: (cb) => {
    const listener = (_event: unknown, payload: unknown) => {
      const action = asLaunchActionPayload(payload);
      if (action !== null) {
        cb(action);
      }
    };
    ipcRenderer.on('kimi:launch-action', listener);
    return () => ipcRenderer.removeListener('kimi:launch-action', listener);
  },
  onQuitConfirm: (cb) => {
    const listener = (_event: unknown, requestId: unknown, reasons: unknown, details: unknown) => {
      if (typeof requestId !== 'number' || !Number.isInteger(requestId)) return;
      const list = Array.isArray(reasons)
        ? reasons.filter((r): r is QuitBlockReason => r === 'busy' || r === 'remote-control')
        : [];
      cb(requestId, list, asQuitConfirmDetails(details));
    };
    ipcRenderer.on('kimi:quit-confirm', listener);
    return () => ipcRenderer.removeListener('kimi:quit-confirm', listener);
  },
  onQuitConfirmCancel: (cb) => {
    const listener = (_event: unknown, requestId: unknown) => {
      if (typeof requestId === 'number' && Number.isInteger(requestId)) {
        cb(requestId);
      }
    };
    ipcRenderer.on('kimi:quit-confirm-cancel', listener);
    return () => ipcRenderer.removeListener('kimi:quit-confirm-cancel', listener);
  },
  respondQuitConfirm: (choice, requestId, continueSessions) => {
    if (choice !== 'quit' && choice !== 'cancel' && choice !== 'unavailable') return Promise.resolve();
    if (typeof requestId !== 'number' || !Number.isInteger(requestId)) return Promise.resolve();
    return ipcRenderer.invoke('kimi:quit-confirm-response', {
      choice,
      requestId,
      continueSessions: continueSessions === true,
    });
  },
  onDeepLinkAuth: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('kimi:deep-link-auth', listener);
    return () => ipcRenderer.removeListener('kimi:deep-link-auth', listener);
  },
  setVibrancy: (enabled) => {
    if (typeof enabled === 'boolean') {
      ipcRenderer.send('kimi:vibrancy', enabled);
    }
  },
  getVibrancy: async () => (await ipcRenderer.invoke('kimi:get-vibrancy')) !== false,
  setLinuxNativeTitleBar: (enabled) => {
    if (typeof enabled !== 'boolean') return Promise.resolve({ status: 'unavailable' as const });
    return ipcRenderer
      .invoke('kimi:linux-native-titlebar', enabled)
      .then((result) => asLinuxNativeTitleBarResult(result) ?? { status: 'unavailable' as const });
  },
};
