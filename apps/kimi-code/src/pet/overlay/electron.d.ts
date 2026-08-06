/**
 * Minimal type shim for the `electron` module.
 *
 * Electron is deliberately not an npm dependency of this package — the binary
 * is downloaded lazily on first `kimi pet` run (see `src/pet/electron.ts`).
 * The overlay bundle (`pet-overlay.mjs`) only uses the small API surface
 * declared here, so we keep local typings instead of pulling the full
 * `electron` package (and its ~100 MB binary download) into every install.
 */

declare module 'electron' {
  export interface Rectangle {
    x: number;
    y: number;
    width: number;
    height: number;
  }

  export interface BrowserWindowConstructorOptions {
    width?: number;
    height?: number;
    x?: number;
    y?: number;
    /** macOS-only: create the window as an NSPanel. Ignored on other platforms. */
    type?: 'panel';
    frame?: boolean;
    transparent?: boolean;
    resizable?: boolean;
    minimizable?: boolean;
    maximizable?: boolean;
    fullscreenable?: boolean;
    show?: boolean;
    alwaysOnTop?: boolean;
    skipTaskbar?: boolean;
    hasShadow?: boolean;
    title?: string;
    /** macOS-only: hide the title bar but keep the traffic lights. */
    titleBarStyle?: 'hiddenInset';
    webPreferences?: {
      nodeIntegration?: boolean;
      contextIsolation?: boolean;
    };
  }

  export interface WebContents {
    send(channel: string, ...args: unknown[]): void;
    on(event: 'did-finish-load', listener: () => void): void;
  }

  export class BrowserWindow {
    constructor(options: BrowserWindowConstructorOptions);
    readonly webContents: WebContents;
    loadFile(path: string): Promise<void>;
    getPosition(): [number, number];
    getSize(): [number, number];
    setPosition(x: number, y: number): void;
    setBounds(bounds: Rectangle): void;
    setAlwaysOnTop(flag: boolean, level?: string): void;
    setVisibleOnAllWorkspaces(visible: boolean, options?: { visibleOnFullScreen?: boolean }): void;
    setHiddenInMissionControl(hidden: boolean): void;
    isDestroyed(): boolean;
    show(): void;
    showInactive(): void;
    focus(): void;
    on(event: 'moved' | 'move' | 'closed', listener: () => void): void;
  }

  export const ipcMain: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(channel: string, listener: (event: unknown, ...args: any[]) => void): void;
  };

  export interface App {
    requestSingleInstanceLock(): boolean;
    whenReady(): Promise<void>;
    quit(): void;
    disableHardwareAcceleration(): void;
    /** macOS-only; undefined elsewhere. */
    readonly dock?: { hide(): void };
    readonly commandLine: {
      appendSwitch(name: string): void;
    };
    on(event: 'second-instance' | 'window-all-closed', listener: () => void): void;
  }

  export const app: App;

  export const screen: {
    getPrimaryDisplay(): { workAreaSize: { width: number; height: number } };
    getCursorScreenPoint(): { x: number; y: number };
  };
}
