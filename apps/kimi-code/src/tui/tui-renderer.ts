import {
  isViewportTUI,
  TuiAltScreen,
  TuiMainScreen,
  type Component,
  type OverlayBounds,
  type OverlayHandle,
  type OverlayOptions,
  type OverlayUnfocusOptions,
  type Terminal,
  type TerminalColorScheme,
  type TUI,
  type TuiInputListener,
  type TuiMainScreenRenderState,
  type TuiMode,
  type WheelScrollLines,
} from '@moonshot-ai/pi-tui';

import { clipboard } from '#/utils/clipboard/clipboard-native';
import { copyTextToClipboard } from '#/utils/clipboard/clipboard-text';
import { openUrl } from '#/utils/open-url';

import { CLICK_GUARD_MS } from './constant/terminal';
import { currentTheme } from './theme';
import { formatErrorMessage } from './utils/event-payload';

export type ActiveTuiRenderer = TuiMainScreen | TuiAltScreen;

export type TuiModeSwitchBlockReason =
  | 'shutting-down'
  | 'switching'
  | 'external-editor'
  | 'screen-takeover'
  | 'editor-replacement'
  | 'active-overlay';

export type TuiModeSwitchResult =
  | { readonly status: 'unchanged'; readonly mode: TuiMode }
  | { readonly status: 'switched'; readonly from: TuiMode; readonly to: TuiMode }
  | { readonly status: 'blocked'; readonly reason: TuiModeSwitchBlockReason };

export interface InteractiveTuiOptions {
  readonly mode: TuiMode;
  readonly terminal: Terminal;
  readonly copyOnSelect: boolean;
  readonly wheelScrollLines?: WheelScrollLines;
  readonly getUi: () => TUI;
}

export function createInteractiveTui(options: InteractiveTuiOptions): ActiveTuiRenderer {
  if (options.mode === 'fullscreen') {
    return new TuiAltScreen(options.terminal, undefined, undefined, {
      openUrl,
      refocusMouseGuardMs: CLICK_GUARD_MS,
      copyOnSelect: options.copyOnSelect,
      wheelScrollLines: options.wheelScrollLines,
      onRightClickPaste: () => {
        const ui = options.getUi();
        if (!(ui instanceof TuiAltScreen)) return;
        const target = ui.getFocusedComponent();
        if (!target?.handleInput || clipboard?.getText === undefined) return;
        void clipboard
          .getText()
          .then((text) => {
            const currentUi = options.getUi();
            if (!(currentUi instanceof TuiAltScreen)) return;
            if (!text || currentUi.getFocusedComponent() !== target) return;
            target.handleInput?.(`\u001B[200~${text}\u001B[201~`);
            currentUi.requestRender();
          })
          .catch(() => {});
      },
      scrollToEndIndicator: () => currentTheme.fg('primary', ' ↓ Jump to bottom '),
      copySelection: async (text) => {
        try {
          const method = await copyTextToClipboard(text);
          return method === 'native' ? true : 'Copied via terminal';
        } catch (error) {
          return formatErrorMessage(error);
        }
      },
    });
  }
  return new TuiMainScreen(options.terminal);
}

export type TuiRendererFactory = (options: InteractiveTuiOptions) => ActiveTuiRenderer;

export interface TuiRendererSessionOptions {
  readonly terminal: Terminal;
  readonly initialMode: TuiMode;
  readonly copyOnSelect: boolean;
  readonly wheelScrollLines?: WheelScrollLines;
  readonly animationFrameRate?: number;
  readonly createRenderer?: TuiRendererFactory;
}

export interface SwitchModeHooks {
  readonly copyOnSelect: boolean;
  readonly wheelScrollLines?: WheelScrollLines;
  readonly onBeforeStart: (nextMode: TuiMode) => void;
}

export class TuiRendererSession {
  readonly ui: TUI;

  private readonly createRenderer: TuiRendererFactory;
  private activeRenderer: ActiveTuiRenderer;
  private mainScreenRenderState: TuiMainScreenRenderState | undefined;
  private preForceRenderMainState: TuiMainScreenRenderState | undefined;
  private switching = false;

  private readonly animationBridge = new AnimationFrameBridge();
  private readonly listeners = new RendererListenerRegistry();
  private readonly persistentOverlays = new PersistentOverlayRegistry();

  constructor(options: TuiRendererSessionOptions) {
    this.createRenderer = options.createRenderer ?? createInteractiveTui;
    this.ui = createInteractiveTuiReference(
      () => this.activeRenderer,
      this.createInterceptedMethods(),
    );
    this.activeRenderer = this.createBoundRenderer({
      mode: options.initialMode,
      terminal: options.terminal,
      copyOnSelect: options.copyOnSelect,
      wheelScrollLines: options.wheelScrollLines,
      getUi: () => this.ui,
    });
    if (options.animationFrameRate !== undefined) {
      this.animationBridge.setFrameRate(this.activeRenderer, options.animationFrameRate);
    }
  }

  get mode(): TuiMode {
    return this.activeRenderer.mode;
  }

  get isSwitching(): boolean {
    return this.switching;
  }

  switchMode(targetMode: TuiMode, hooks: SwitchModeHooks): TuiModeSwitchResult {
    if (this.switching) {
      return { status: 'blocked', reason: 'switching' };
    }
    const previous = this.activeRenderer;
    if (targetMode === previous.mode) {
      return { status: 'unchanged', mode: targetMode };
    }
    this.switching = true;
    try {
      if (this.persistentOverlays.hasOtherOverlaysOn(previous)) {
        return { status: 'blocked', reason: 'active-overlay' };
      }
      const terminal = previous.terminal;
      const next = this.createBoundRenderer({
        mode: targetMode,
        terminal,
        copyOnSelect: hooks.copyOnSelect,
        wheelScrollLines: hooks.wheelScrollLines,
        getUi: () => this.ui,
      });
      const showHardwareCursor = previous.getShowHardwareCursor();
      const clearOnShrink = previous.getClearOnShrink();
      const onDebug = previous.onDebug;
      const capturedMain = this.captureMainScreenState(previous);

      const focusedPersistentOverlay = this.persistentOverlays.detachFromCurrent();
      previous.stop({ preserveScreen: true });
      const previousFocus = previous.getFocusedComponent();
      previous.setFocus(null);
      previous.clear();
      if (isViewportTUI(previous)) {
        previous.setLayoutRoot(undefined);
      }

      next.setShowHardwareCursor(showHardwareCursor);
      next.setClearOnShrink(clearOnShrink);
      next.onDebug = onDebug;
      if (capturedMain !== undefined) {
        this.mainScreenRenderState = capturedMain;
      }
      if (next instanceof TuiMainScreen && this.mainScreenRenderState !== undefined) {
        next.restoreRenderState(this.mainScreenRenderState);
        this.mainScreenRenderState = undefined;
      }

      this.listeners.migrateTo(next);
      this.animationBridge.migrateTo(previous, next);
      this.activeRenderer = next;
      hooks.onBeforeStart(targetMode);
      next.invalidate();
      next.setFocus(previousFocus);
      this.persistentOverlays.attachTo(next, focusedPersistentOverlay);
      next.start();
      return { status: 'switched', from: previous.mode, to: targetMode };
    } finally {
      this.switching = false;
    }
  }

  exitToMainScreen(mountRegularLayout: () => void): void {
    const previous = this.activeRenderer;
    if (!(previous instanceof TuiAltScreen)) {
      this.ui.stop();
      return;
    }
    const terminal = previous.terminal;
    this.persistentOverlays.detachFromCurrent();
    while (previous.hasOverlayEntries) {
      previous.hideOverlay();
    }
    previous.stop({ preserveScreen: true });
    previous.setFocus(null);
    previous.clear();
    previous.setLayoutRoot(undefined);
    const main = this.createBoundRenderer({
      mode: 'regular',
      terminal,
      copyOnSelect: false,
      getUi: () => this.ui,
    });
    if (main instanceof TuiMainScreen && this.mainScreenRenderState !== undefined) {
      main.restoreRenderState(this.mainScreenRenderState);
      this.mainScreenRenderState = undefined;
    }
    this.activeRenderer = main;
    mountRegularLayout();
    main.invalidate();
    main.renderNow();
    main.stop();
  }

  private createBoundRenderer(options: InteractiveTuiOptions): ActiveTuiRenderer {
    const renderer = this.createRenderer(options);
    this.persistentOverlays.bindRenderer(renderer);
    return renderer;
  }

  private captureMainScreenState(
    renderer: ActiveTuiRenderer,
  ): TuiMainScreenRenderState | undefined {
    if (!(renderer instanceof TuiMainScreen)) {
      return undefined;
    }
    const current = renderer.captureRenderState();
    const fallback = this.preForceRenderMainState;
    this.preForceRenderMainState = undefined;
    if (current.previousWidth > 0) {
      return current;
    }
    if (current.previousWidth < 0) {
      return fallback;
    }
    return undefined;
  }

  private createInterceptedMethods(): Readonly<Record<string, (...args: never[]) => unknown>> {
    return {
      requestRender: (force?: boolean) => {
        if (force === true && this.activeRenderer instanceof TuiMainScreen) {
          const snapshot = this.activeRenderer.captureRenderState();
          if (snapshot.previousWidth > 0) {
            this.preForceRenderMainState = snapshot;
          }
        }
        this.activeRenderer.requestRender(force);
      },
      requestAnimationFrame: (callback: (time: number) => void) =>
        this.animationBridge.request(this.activeRenderer, callback),
      cancelAnimationFrame: (handle: number) => {
        this.animationBridge.cancel(this.activeRenderer, handle);
      },
      setAnimationFrameRate: (fps: number) => {
        this.animationBridge.setFrameRate(this.activeRenderer, fps);
      },
      addInputListener: (listener: TuiInputListener) =>
        this.listeners.addInputListener(() => this.activeRenderer, listener),
      removeInputListener: (listener: TuiInputListener) => {
        this.listeners.removeInputListener(this.activeRenderer, listener);
      },
      onTerminalColorSchemeChange: (listener: (scheme: TerminalColorScheme) => void) =>
        this.listeners.onTerminalColorSchemeChange(() => this.activeRenderer, listener),
      setTerminalColorSchemeNotifications: (enabled: boolean) => {
        this.listeners.setTerminalColorSchemeNotifications(this.activeRenderer, enabled);
      },
      setSuspendSignalHandler: (handler: (() => void) | undefined) => {
        this.listeners.setSuspendSignalHandler(this.activeRenderer, handler);
      },
      showOverlay: (component: Component, options?: OverlayOptions) =>
        this.persistentOverlays.showOverlay(this.activeRenderer, component, options),
      hideOverlay: () => {
        this.persistentOverlays.hideOverlay(this.activeRenderer);
      },
    };
  }
}

interface PendingAnimationFrame {
  readonly callback: (time: number) => void;
  rendererHandle: number;
  generation: number;
}

class AnimationFrameBridge {
  private nextHandle = 1;
  private rendererGeneration = 0;
  private frameRate: number | undefined;
  private readonly pending = new Map<number, PendingAnimationFrame>();

  request(renderer: ActiveTuiRenderer, callback: (time: number) => void): number {
    const bridgeHandle = this.nextHandle++;
    const generation = this.rendererGeneration;
    const entry: PendingAnimationFrame = { callback, rendererHandle: 0, generation };
    this.pending.set(bridgeHandle, entry);
    entry.rendererHandle = this.scheduleOnRenderer(renderer, bridgeHandle, entry);
    return bridgeHandle;
  }

  cancel(renderer: ActiveTuiRenderer, handle: number): void {
    const entry = this.pending.get(handle);
    if (entry === undefined) return;
    this.pending.delete(handle);
    if (entry.generation === this.rendererGeneration) {
      renderer.cancelAnimationFrame(entry.rendererHandle);
    }
  }

  setFrameRate(renderer: ActiveTuiRenderer, fps: number): void {
    renderer.setAnimationFrameRate(fps);
    this.frameRate = fps;
  }

  migrateTo(previous: ActiveTuiRenderer, next: ActiveTuiRenderer): void {
    if (this.frameRate !== undefined) {
      next.setAnimationFrameRate(this.frameRate);
    }
    const snapshot = [...this.pending.entries()];
    this.pending.clear();
    this.rendererGeneration += 1;
    for (const [, entry] of snapshot) {
      previous.cancelAnimationFrame(entry.rendererHandle);
    }
    for (const [bridgeHandle, entry] of snapshot) {
      const migrated: PendingAnimationFrame = {
        callback: entry.callback,
        rendererHandle: 0,
        generation: this.rendererGeneration,
      };
      this.pending.set(bridgeHandle, migrated);
      migrated.rendererHandle = this.scheduleOnRenderer(next, bridgeHandle, migrated);
    }
  }

  private scheduleOnRenderer(
    renderer: ActiveTuiRenderer,
    bridgeHandle: number,
    entry: PendingAnimationFrame,
  ): number {
    const expectedGeneration = entry.generation;
    return renderer.requestAnimationFrame((time) => {
      const current = this.pending.get(bridgeHandle);
      if (
        current === undefined ||
        current !== entry ||
        current.generation !== expectedGeneration ||
        this.rendererGeneration !== expectedGeneration
      ) {
        return;
      }
      this.pending.delete(bridgeHandle);
      entry.callback(time);
    });
  }
}

class RendererListenerRegistry {
  private readonly inputListeners = new Map<TuiInputListener, () => void>();
  private readonly colorSchemeListeners = new Map<
    (scheme: TerminalColorScheme) => void,
    () => void
  >();
  private colorSchemeNotificationsEnabled = false;
  private suspendSignalHandler: (() => void) | undefined;

  addInputListener(getRenderer: () => ActiveTuiRenderer, listener: TuiInputListener): () => void {
    if (!this.inputListeners.has(listener)) {
      this.inputListeners.set(listener, getRenderer().addInputListener(listener));
    }
    return () => {
      this.removeInputListener(getRenderer(), listener);
    };
  }

  removeInputListener(renderer: ActiveTuiRenderer, listener: TuiInputListener): void {
    const dispose = this.inputListeners.get(listener);
    if (dispose !== undefined) {
      this.inputListeners.delete(listener);
      dispose();
    }
    renderer.removeInputListener(listener);
  }

  onTerminalColorSchemeChange(
    getRenderer: () => ActiveTuiRenderer,
    listener: (scheme: TerminalColorScheme) => void,
  ): () => void {
    if (!this.colorSchemeListeners.has(listener)) {
      this.colorSchemeListeners.set(listener, getRenderer().onTerminalColorSchemeChange(listener));
    }
    return () => {
      const dispose = this.colorSchemeListeners.get(listener);
      if (dispose === undefined) return;
      this.colorSchemeListeners.delete(listener);
      dispose();
    };
  }

  setTerminalColorSchemeNotifications(renderer: ActiveTuiRenderer, enabled: boolean): void {
    this.colorSchemeNotificationsEnabled = enabled;
    renderer.setTerminalColorSchemeNotifications(enabled);
  }

  setSuspendSignalHandler(renderer: ActiveTuiRenderer, handler: (() => void) | undefined): void {
    this.suspendSignalHandler = handler;
    renderer.setSuspendSignalHandler(handler);
  }

  migrateTo(next: ActiveTuiRenderer): void {
    for (const [listener, disposePrevious] of this.inputListeners.entries()) {
      disposePrevious();
      this.inputListeners.set(listener, next.addInputListener(listener));
    }
    if (this.colorSchemeNotificationsEnabled) {
      next.setTerminalColorSchemeNotifications(true);
    }
    for (const [listener, disposePrevious] of this.colorSchemeListeners.entries()) {
      disposePrevious();
      this.colorSchemeListeners.set(listener, next.onTerminalColorSchemeChange(listener));
    }
    if (this.suspendSignalHandler !== undefined) {
      next.setSuspendSignalHandler(this.suspendSignalHandler);
    }
  }
}

interface BoundOverlayOps {
  readonly rawShowOverlay: (component: Component, options?: OverlayOptions) => OverlayHandle;
  readonly rawHideOverlay: () => void;
}

interface TrackedOverlayEntry {
  readonly persistent: boolean;
  readonly record?: PersistentOverlayRecord;
}

interface PersistentOverlayRecord {
  readonly component: Component;
  readonly options: OverlayOptions;
  liveHandle: OverlayHandle;
  stackEntry?: TrackedOverlayEntry;
  attachedRenderer?: ActiveTuiRenderer;
  hidden: boolean;
  disposed: boolean;
}

class PersistentOverlayRegistry {
  private readonly entries = new Set<PersistentOverlayRecord>();
  private readonly boundOps = new WeakMap<ActiveTuiRenderer, BoundOverlayOps>();
  private readonly stacks = new WeakMap<ActiveTuiRenderer, TrackedOverlayEntry[]>();

  bindRenderer(renderer: ActiveTuiRenderer): void {
    void this.ensureBoundOps(renderer);
  }

  showOverlay(
    renderer: ActiveTuiRenderer,
    component: Component,
    options?: OverlayOptions,
  ): OverlayHandle {
    return this.showOverlayOn(renderer, component, options);
  }

  hideOverlay(renderer: ActiveTuiRenderer): void {
    this.hideOverlayOn(renderer);
  }

  hasOtherOverlaysOn(renderer: ActiveTuiRenderer): boolean {
    const stack = this.stacks.get(renderer);
    return stack === undefined
      ? renderer.hasOverlayEntries
      : stack.some((entry) => !entry.persistent);
  }

  detachFromCurrent(): PersistentOverlayRecord | undefined {
    let focusedRecord: PersistentOverlayRecord | undefined;
    for (const record of this.entries) {
      if (!record.disposed && !record.hidden && record.liveHandle.isFocused()) {
        focusedRecord = record;
      }
    }
    for (const record of this.entries) {
      if (record.attachedRenderer !== undefined && record.stackEntry !== undefined) {
        this.removeStackEntry(record.attachedRenderer, record.stackEntry);
      }
      record.attachedRenderer = undefined;
      record.stackEntry = undefined;
      record.liveHandle.hide();
    }
    return focusedRecord;
  }

  attachTo(next: ActiveTuiRenderer, focusedRecord?: PersistentOverlayRecord): void {
    const ops = this.ensureBoundOps(next);
    const stack = this.getStack(next);
    for (const record of this.entries) {
      if (record.disposed) continue;
      record.liveHandle = ops.rawShowOverlay(record.component, record.options);
      const entry: TrackedOverlayEntry = { persistent: true, record };
      stack.push(entry);
      record.stackEntry = entry;
      record.attachedRenderer = next;
      if (record.hidden) {
        record.liveHandle.setHidden(true);
      } else if (record === focusedRecord) {
        record.liveHandle.focus();
      }
    }
  }

  private showOverlayOn(
    renderer: ActiveTuiRenderer,
    component: Component,
    options?: OverlayOptions,
  ): OverlayHandle {
    const ops = this.ensureBoundOps(renderer);
    const stack = this.getStack(renderer);
    const liveHandle = ops.rawShowOverlay(component, options);
    if (options?.nonCapturing !== true) {
      const entry: TrackedOverlayEntry = { persistent: false };
      stack.push(entry);
      return {
        hide: () => {
          this.removeStackEntry(renderer, entry);
          liveHandle.hide();
        },
        setHidden: (hidden: boolean) => {
          liveHandle.setHidden(hidden);
        },
        isHidden: () => liveHandle.isHidden(),
        focus: () => {
          liveHandle.focus();
        },
        unfocus: (unfocusOptions?: OverlayUnfocusOptions) => {
          liveHandle.unfocus(unfocusOptions);
        },
        isFocused: () => liveHandle.isFocused(),
        getBounds: () => liveHandle.getBounds(),
      };
    }
    const record: PersistentOverlayRecord = {
      component,
      options,
      liveHandle,
      hidden: false,
      disposed: false,
    };
    const entry: TrackedOverlayEntry = { persistent: true, record };
    record.stackEntry = entry;
    record.attachedRenderer = renderer;
    stack.push(entry);
    this.entries.add(record);
    return {
      hide: () => {
        if (record.disposed) return;
        record.disposed = true;
        this.entries.delete(record);
        if (record.attachedRenderer !== undefined && record.stackEntry !== undefined) {
          this.removeStackEntry(record.attachedRenderer, record.stackEntry);
        }
        record.attachedRenderer = undefined;
        record.stackEntry = undefined;
        record.liveHandle.hide();
      },
      setHidden: (hidden: boolean) => {
        if (record.disposed) return;
        record.hidden = hidden;
        record.liveHandle.setHidden(hidden);
      },
      isHidden: () => record.hidden,
      focus: () => {
        if (record.disposed) return;
        record.liveHandle.focus();
      },
      unfocus: (unfocusOptions?: OverlayUnfocusOptions) => {
        if (record.disposed) return;
        record.liveHandle.unfocus(unfocusOptions);
      },
      isFocused: () => !record.disposed && record.liveHandle.isFocused(),
      getBounds: (): OverlayBounds | undefined =>
        record.disposed ? undefined : record.liveHandle.getBounds(),
    };
  }

  private hideOverlayOn(renderer: ActiveTuiRenderer): void {
    const ops = this.ensureBoundOps(renderer);
    const top = this.stacks.get(renderer)?.pop();
    if (top?.record !== undefined) {
      top.record.disposed = true;
      top.record.attachedRenderer = undefined;
      top.record.stackEntry = undefined;
      this.entries.delete(top.record);
    }
    ops.rawHideOverlay();
  }

  private ensureBoundOps(renderer: ActiveTuiRenderer): BoundOverlayOps {
    const existing = this.boundOps.get(renderer);
    if (existing !== undefined) return existing;
    const ops: BoundOverlayOps = {
      rawShowOverlay: renderer.showOverlay.bind(renderer),
      rawHideOverlay: renderer.hideOverlay.bind(renderer),
    };
    this.boundOps.set(renderer, ops);
    this.stacks.set(renderer, []);
    renderer.showOverlay = (component: Component, options?: OverlayOptions) =>
      this.showOverlayOn(renderer, component, options);
    renderer.hideOverlay = () => {
      this.hideOverlayOn(renderer);
    };
    return ops;
  }

  private getStack(renderer: ActiveTuiRenderer): TrackedOverlayEntry[] {
    const existing = this.stacks.get(renderer);
    if (existing !== undefined) return existing;
    const stack: TrackedOverlayEntry[] = [];
    this.stacks.set(renderer, stack);
    return stack;
  }

  private removeStackEntry(renderer: ActiveTuiRenderer, entry: TrackedOverlayEntry): void {
    const stack = this.stacks.get(renderer);
    if (stack === undefined) return;
    const index = stack.indexOf(entry);
    if (index !== -1) {
      stack.splice(index, 1);
    }
  }
}

type RendererMethod = (this: ActiveTuiRenderer, ...args: unknown[]) => unknown;

function createInteractiveTuiReference(
  getRenderer: () => ActiveTuiRenderer,
  intercepted: Readonly<Record<string, (...args: never[]) => unknown>>,
): TUI {
  const target = {} as TUI;
  for (const [key, value] of Object.entries(intercepted)) {
    Object.defineProperty(target, key, {
      value,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
  return new Proxy(target, {
    get(proxyTarget, property, receiver): unknown {
      if (Object.prototype.hasOwnProperty.call(proxyTarget, property)) {
        const own: unknown = Reflect.get(proxyTarget, property, receiver);
        return own;
      }
      const methodRenderer = getRenderer();
      const value: unknown = Reflect.get(methodRenderer, property, methodRenderer);
      if (
        typeof value !== 'function' ||
        Object.prototype.hasOwnProperty.call(methodRenderer, property)
      ) {
        return value;
      }
      let boundMethod = value as RendererMethod;
      let boundRenderer = methodRenderer;
      return (...args: unknown[]): unknown => {
        const current = getRenderer();
        if (current !== boundRenderer) {
          const nextValue: unknown = Reflect.get(current, property, current);
          if (typeof nextValue !== 'function') {
            throw new TypeError(
              `Property ${String(property)} is not a function on active TUI renderer`,
            );
          }
          boundMethod = nextValue as RendererMethod;
          boundRenderer = current;
        }
        return Reflect.apply(boundMethod, boundRenderer, args);
      };
    },
    set(proxyTarget, property, value, receiver): boolean {
      if (Object.prototype.hasOwnProperty.call(proxyTarget, property)) {
        return Reflect.set(proxyTarget, property, value, receiver);
      }
      const current = getRenderer();
      return Reflect.set(current, property, value, current);
    },
    has(proxyTarget, property): boolean {
      return (
        Object.prototype.hasOwnProperty.call(proxyTarget, property) ||
        Reflect.has(getRenderer(), property)
      );
    },
    getPrototypeOf(): object | null {
      return Reflect.getPrototypeOf(getRenderer());
    },
  });
}
