import {
  isViewportTUI,
  Text,
  TuiAltScreen,
  TuiMainScreen,
  type AnimationClock,
  type Component,
  type Focusable,
  type TerminalColorScheme,
} from '@moonshot-ai/pi-tui';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import {
  TuiRendererSession,
  type ActiveTuiRenderer,
  type TuiRendererFactory,
} from '#/tui/tui-renderer';

import { VirtualTerminal } from '../../../../packages/pi-tui/test/virtual-terminal';

function createManualClock(): {
  readonly clock: AnimationClock;
  readonly timers: Map<number, { readonly callback: () => void; readonly delayMs: number }>;
  advance(ms: number): void;
} {
  let nowMs = 0;
  let nextId = 1;
  const timers = new Map<number, { readonly callback: () => void; readonly delayMs: number }>();
  const clock: AnimationClock = {
    now: () => nowMs,
    setTimeout: (callback, delayMs) => {
      const id = nextId++;
      timers.set(id, { callback, delayMs });
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
  };
  return {
    clock,
    timers,
    advance(ms: number) {
      nowMs += ms;
      const due = [...timers.entries()];
      timers.clear();
      for (const [, timer] of due) {
        timer.callback();
      }
    },
  };
}

class FocusableLine extends Text implements Focusable {
  focused = false;
}

describe('TuiRendererSession', () => {
  it('keeps proxy identity stable while dynamically updating instanceof and bound methods (Pi #7731)', async () => {
    const vt = new VirtualTerminal(80, 24);
    const session = new TuiRendererSession({
      terminal: vt,
      initialMode: 'regular',
      copyOnSelect: true,
    });
    const stableUi = session.ui;
    onTestFinished(() => {
      stableUi.stop();
    });

    const detachedRequestRender = stableUi.requestRender;
    const detachedSetFocus = stableUi.setFocus;

    expect(stableUi).toBeInstanceOf(TuiMainScreen);
    expect(stableUi).not.toBeInstanceOf(TuiAltScreen);
    expect(isViewportTUI(stableUi)).toBe(false);
    expect(stableUi.mode).toBe('regular');

    const line = new FocusableLine('hello', 0, 0);
    stableUi.addChild(line);
    detachedSetFocus(line);
    stableUi.start();
    await vt.waitForRender();

    const switched = session.switchMode('fullscreen', {
      copyOnSelect: false,
      onBeforeStart: () => {
        stableUi.addChild(line);
      },
    });
    expect(switched).toEqual({ status: 'switched', from: 'regular', to: 'fullscreen' });
    expect(session.ui).toBe(stableUi);
    expect(stableUi).toBeInstanceOf(TuiAltScreen);
    expect(stableUi).not.toBeInstanceOf(TuiMainScreen);
    expect(isViewportTUI(stableUi)).toBe(true);
    expect(stableUi.mode).toBe('fullscreen');
    expect((stableUi as TuiAltScreen).getCopyOnSelect()).toBe(false);

    const nextFocus = new FocusableLine('focused-after-switch', 0, 0);
    detachedSetFocus(nextFocus);
    expect(nextFocus.focused).toBe(true);
    expect(line.focused).toBe(false);
    expect((stableUi as TuiAltScreen).getFocusedComponent()).toBe(nextFocus);

    detachedRequestRender();
    await vt.waitForRender();
    expect(vt.getViewport().join('\n')).toContain('hello');
  });

  it('migrates pending animation frames in order, prevents handle collisions, ignores stale generations, and preserves fps', () => {
    const vt = new VirtualTerminal(80, 24);
    const created: Array<{
      readonly mode: 'regular' | 'fullscreen';
      readonly renderer: ActiveTuiRenderer;
      readonly scheduled: Map<number, (time: number) => void>;
      readonly cancelled: number[];
      readonly frameRates: number[];
    }> = [];

    const createRenderer: TuiRendererFactory = ({ mode, terminal }) => {
      const manual = createManualClock();
      const renderer =
        mode === 'fullscreen'
          ? new TuiAltScreen(terminal)
          : new TuiMainScreen(terminal, undefined, undefined, manual.clock);
      let localHandle = 1;
      const scheduled = new Map<number, (time: number) => void>();
      const cancelled: number[] = [];
      const frameRates: number[] = [];
      renderer.requestAnimationFrame = (cb) => {
        const id = localHandle++;
        scheduled.set(id, cb);
        return id;
      };
      renderer.cancelAnimationFrame = (id) => {
        cancelled.push(id);
        scheduled.delete(id);
      };
      renderer.setAnimationFrameRate = (fps) => {
        frameRates.push(fps);
      };
      created.push({ mode, renderer, scheduled, cancelled, frameRates });
      return renderer;
    };

    const session = new TuiRendererSession({
      terminal: vt,
      initialMode: 'regular',
      copyOnSelect: true,
      animationFrameRate: 30,
      createRenderer,
    });
    onTestFinished(() => {
      session.ui.stop();
    });

    expect(created[0]!.frameRates).toEqual([30]);

    const order: string[] = [];
    const h1 = session.ui.requestAnimationFrame((time) => order.push(`first:${String(time)}`));
    const h2 = session.ui.requestAnimationFrame((time) => order.push(`second:${String(time)}`));
    const h3 = session.ui.requestAnimationFrame((time) => order.push(`third:${String(time)}`));
    expect(h1).toBeLessThan(h2);
    expect(h2).toBeLessThan(h3);

    const staleOldCallback = created[0]!.scheduled.get(1)!;
    session.ui.cancelAnimationFrame(h2);
    expect(created[0]!.cancelled).toEqual([2]);

    const switched = session.switchMode('fullscreen', {
      copyOnSelect: true,
      onBeforeStart: () => {},
    });
    expect(switched).toEqual({ status: 'switched', from: 'regular', to: 'fullscreen' });
    expect(created).toHaveLength(2);
    expect(created[1]!.frameRates).toEqual([30]);
    expect(created[0]!.cancelled).toEqual([2, 1, 3]);
    expect([...created[1]!.scheduled.keys()]).toEqual([1, 2]);

    staleOldCallback(999);
    expect(order).toEqual([]);

    const h4 = session.ui.requestAnimationFrame((time) => order.push(`fourth:${String(time)}`));
    expect(h4).toBeGreaterThan(h3);

    session.ui.cancelAnimationFrame(h3);
    expect(created[1]!.cancelled).toEqual([2]);

    for (const cb of [...created[1]!.scheduled.values()]) {
      cb(42);
    }
    expect(order).toEqual(['first:42', 'fourth:42']);
  });

  it('migrates input and color-scheme listeners in insertion order with cross-switch disposers', async () => {
    const vt = new VirtualTerminal(80, 24);
    const session = new TuiRendererSession({
      terminal: vt,
      initialMode: 'regular',
      copyOnSelect: true,
    });
    onTestFinished(() => {
      session.ui.stop();
    });

    const events: string[] = [];
    const disposeFirst = session.ui.addInputListener((data) => {
      events.push(`first:${data}`);
      return undefined;
    });
    const secondListener = (data: string) => {
      events.push(`second:${data}`);
      return undefined;
    };
    session.ui.addInputListener(secondListener);

    const schemes: TerminalColorScheme[] = [];
    session.ui.setTerminalColorSchemeNotifications(true);
    const disposeScheme = session.ui.onTerminalColorSchemeChange((scheme) => {
      schemes.push(scheme);
    });

    session.ui.start();
    await vt.waitForRender();

    vt.sendInput('a');
    expect(events).toEqual(['first:a', 'second:a']);
    vt.sendInput('\u001B[?997;1n');
    expect(schemes).toEqual(['dark']);

    events.length = 0;
    schemes.length = 0;
    expect(
      session.switchMode('fullscreen', {
        copyOnSelect: true,
        onBeforeStart: () => {},
      }),
    ).toEqual({ status: 'switched', from: 'regular', to: 'fullscreen' });
    await vt.waitForRender();

    vt.sendInput('b');
    expect(events).toEqual(['first:b', 'second:b']);
    vt.sendInput('\u001B[?997;2n');
    expect(schemes).toEqual(['light']);

    events.length = 0;
    schemes.length = 0;
    disposeFirst();
    disposeScheme();
    vt.sendInput('c');
    vt.sendInput('\u001B[?997;1n');
    expect(events).toEqual(['second:c']);
    expect(schemes).toEqual([]);

    events.length = 0;
    session.ui.removeInputListener(secondListener);
    vt.sendInput('d');
    expect(events).toEqual([]);
  });

  it('migrates nonCapturing overlays without blocking and blocks on capturing or search overlays', async () => {
    const vt = new VirtualTerminal(80, 24);
    const session = new TuiRendererSession({
      terminal: vt,
      initialMode: 'regular',
      copyOnSelect: true,
    });
    onTestFinished(() => {
      session.ui.stop();
    });

    const hud = new Text('LATENCY HUD', 0, 0);
    const hudHandle = session.ui.showOverlay(hud, {
      nonCapturing: true,
      anchor: 'top-right',
      margin: 0,
    });
    session.ui.addChild(new Text('base body', 0, 0));
    session.ui.start();
    await vt.waitForRender();
    expect(hudHandle.getBounds()).toBeDefined();

    expect(
      session.switchMode('fullscreen', {
        copyOnSelect: true,
        onBeforeStart: () => {
          session.ui.addChild(new Text('base body', 0, 0));
        },
      }),
    ).toEqual({ status: 'switched', from: 'regular', to: 'fullscreen' });
    await vt.waitForRender();
    expect(vt.getViewport().join('\n')).toContain('LATENCY HUD');
    expect(hudHandle.getBounds()).toBeDefined();

    hudHandle.setHidden(true);
    expect(hudHandle.isHidden()).toBe(true);
    expect(
      session.switchMode('regular', {
        copyOnSelect: true,
        onBeforeStart: () => {
          session.ui.addChild(new Text('base body', 0, 0));
        },
      }),
    ).toEqual({ status: 'switched', from: 'fullscreen', to: 'regular' });
    await vt.waitForRender();
    expect(hudHandle.isHidden()).toBe(true);
    expect(vt.getViewport().join('\n')).not.toContain('LATENCY HUD');

    const modalHandle = session.ui.showOverlay(new Text('MODAL', 0, 0));
    expect(
      session.switchMode('fullscreen', {
        copyOnSelect: true,
        onBeforeStart: () => {},
      }),
    ).toEqual({ status: 'blocked', reason: 'active-overlay' });
    expect(session.mode).toBe('regular');
    expect(hudHandle.isHidden()).toBe(true);

    modalHandle.hide();
    expect(
      session.switchMode('fullscreen', {
        copyOnSelect: true,
        onBeforeStart: () => {
          session.ui.addChild(new Text('searchable alpha', 0, 0));
        },
      }),
    ).toEqual({ status: 'switched', from: 'regular', to: 'fullscreen' });
    await vt.waitForRender();

    vt.sendInput('\u001B[102;6u');
    await vt.waitForRender();
    expect(session.ui.hasOverlay()).toBe(true);
    expect(
      session.switchMode('regular', {
        copyOnSelect: true,
        onBeforeStart: () => {},
      }),
    ).toEqual({ status: 'blocked', reason: 'active-overlay' });
    expect(session.mode).toBe('fullscreen');

    hudHandle.hide();
    expect(hudHandle.getBounds()).toBeUndefined();
  });

  it('preserves main-screen render state, focus, and renderer flags across round-trip and avoids duplicate scrollback', async () => {
    const vt = new VirtualTerminal(60, 12);
    const session = new TuiRendererSession({
      terminal: vt,
      initialMode: 'regular',
      copyOnSelect: true,
    });
    onTestFinished(() => {
      session.ui.stop();
    });

    const lines = Array.from({ length: 18 }, (_, i) => new Text(`HISTORY_ROW_${String(i + 1)}`, 0, 0));
    const input = new FocusableLine('PROMPT_LINE', 0, 0);
    const mountAll = (): void => {
      for (const line of lines) session.ui.addChild(line);
      session.ui.addChild(input);
    };
    mountAll();

    const onDebug = vi.fn();
    session.ui.setShowHardwareCursor(true);
    session.ui.setClearOnShrink(true);
    session.ui.onDebug = onDebug;
    session.ui.setFocus(input);
    session.ui.start();
    await vt.waitForRender();

    const beforeRows = vt
      .getScrollBuffer()
      .filter((row) => row.trim() === 'HISTORY_ROW_1');
    expect(beforeRows).toHaveLength(1);

    let reentrantResult: unknown;
    expect(
      session.switchMode('fullscreen', {
        copyOnSelect: true,
        onBeforeStart: () => {
          reentrantResult = session.switchMode('regular', {
            copyOnSelect: true,
            onBeforeStart: () => {},
          });
          mountAll();
        },
      }),
    ).toEqual({ status: 'switched', from: 'regular', to: 'fullscreen' });
    expect(reentrantResult).toEqual({ status: 'blocked', reason: 'switching' });
    expect(
      session.switchMode('fullscreen', {
        copyOnSelect: true,
        onBeforeStart: () => {},
      }),
    ).toEqual({ status: 'unchanged', mode: 'fullscreen' });
    expect(session.ui.getShowHardwareCursor()).toBe(true);
    expect(session.ui.getClearOnShrink()).toBe(true);
    expect(session.ui.onDebug).toBe(onDebug);
    expect(input.focused).toBe(true);
    await vt.waitForRender();

    vt.sendInput('\u001B[100;6u');
    expect(onDebug).toHaveBeenCalledOnce();

    expect(
      session.switchMode('regular', {
        copyOnSelect: true,
        onBeforeStart: () => {
          mountAll();
        },
      }),
    ).toEqual({ status: 'switched', from: 'fullscreen', to: 'regular' });
    expect(input.focused).toBe(true);
    await vt.waitForRender();

    const afterRows = vt
      .getScrollBuffer()
      .filter((row) => row.trim() === 'HISTORY_ROW_1');
    expect(afterRows).toHaveLength(1);
    expect(vt.getViewport().join('\n')).toContain('PROMPT_LINE');
  });

  it('exitToMainScreen restores main-screen render state without duplicating scrollback', async () => {
    const vt = new VirtualTerminal(60, 12);
    const session = new TuiRendererSession({
      terminal: vt,
      initialMode: 'regular',
      copyOnSelect: true,
    });

    const lines = Array.from({ length: 16 }, (_, i) => new Text(`EXIT_ROW_${String(i + 1)}`, 0, 0));
    const mountAll = (): void => {
      for (const line of lines) session.ui.addChild(line);
    };
    mountAll();
    session.ui.start();
    await vt.waitForRender();

    expect(
      session.switchMode('fullscreen', {
        copyOnSelect: true,
        onBeforeStart: mountAll,
      }),
    ).toEqual({ status: 'switched', from: 'regular', to: 'fullscreen' });
    await vt.waitForRender();

    lines.push(new Text('ADDED_IN_FULLSCREEN', 0, 0));
    session.exitToMainScreen(mountAll);
    await vt.flush();

    expect(session.mode).toBe('regular');
    const buffer = vt.getScrollBuffer();
    expect(buffer.filter((row) => row.trim() === 'EXIT_ROW_1')).toHaveLength(1);
    expect(buffer.some((row) => row.includes('ADDED_IN_FULLSCREEN'))).toBe(true);
  });

  it('leaves the previous renderer intact if createRenderer throws during switchMode', async () => {
    const vt = new VirtualTerminal(60, 10);
    let failNext = false;
    const createRenderer: TuiRendererFactory = ({ mode, terminal }) => {
      if (failNext) {
        throw new Error('factory boom');
      }
      return mode === 'fullscreen' ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);
    };
    const session = new TuiRendererSession({
      terminal: vt,
      initialMode: 'regular',
      copyOnSelect: true,
      createRenderer,
    });
    onTestFinished(() => {
      session.ui.stop();
    });

    const hud = new Text('STILL_HERE', 0, 0);
    const hudHandle = session.ui.showOverlay(hud, {
      nonCapturing: true,
      anchor: 'top-right',
      width: 16,
    });
    session.ui.addChild(new Text('PRIMARY_CONTENT', 0, 0));
    session.ui.start();
    await vt.waitForRender();

    failNext = true;
    expect(() =>
      session.switchMode('fullscreen', {
        copyOnSelect: true,
        onBeforeStart: () => {},
      }),
    ).toThrow('factory boom');

    expect(session.mode).toBe('regular');
    expect(session.isSwitching).toBe(false);
    expect(session.ui).toBeInstanceOf(TuiMainScreen);
    expect(hudHandle.isHidden()).toBe(false);
    session.ui.requestRender();
    await vt.waitForRender();
    const screen = vt.getViewport().join('\n');
    expect(screen).toContain('PRIMARY_CONTENT');
    expect(screen).toContain('STILL_HERE');
  });

  it('stops the active regular renderer through the proxy on exitToMainScreen', () => {
    const vt = new VirtualTerminal(60, 10);
    const session = new TuiRendererSession({
      terminal: vt,
      initialMode: 'regular',
      copyOnSelect: true,
    });
    const stopSpy = vi.spyOn(session.ui, 'stop');
    const mountRegularLayout = vi.fn();

    session.exitToMainScreen(mountRegularLayout);

    expect(stopSpy).toHaveBeenCalledOnce();
    expect(mountRegularLayout).not.toHaveBeenCalled();
  });

  it('preserves main-screen scrollback without emitting CSI 3J when switching immediately after requestRender(true)', async () => {
    const vt = new VirtualTerminal(60, 12);
    const session = new TuiRendererSession({
      terminal: vt,
      initialMode: 'regular',
      copyOnSelect: true,
    });
    onTestFinished(() => {
      session.ui.stop();
    });

    const lines = Array.from(
      { length: 18 },
      (_, index) => new Text(`FORCE_ROW_${String(index + 1)}`, 0, 0),
    );
    const mountAll = (): void => {
      for (const line of lines) session.ui.addChild(line);
    };
    mountAll();
    session.ui.start();
    await vt.waitForRender();
    expect(vt.getScrollBuffer().filter((row) => row.trim() === 'FORCE_ROW_1')).toHaveLength(1);

    const writeSpy = vi.spyOn(vt, 'write');
    session.ui.requestRender(true);
    expect(
      session.switchMode('fullscreen', {
        copyOnSelect: true,
        onBeforeStart: mountAll,
      }),
    ).toEqual({ status: 'switched', from: 'regular', to: 'fullscreen' });
    await vt.waitForRender();

    expect(
      session.switchMode('regular', {
        copyOnSelect: true,
        onBeforeStart: mountAll,
      }),
    ).toEqual({ status: 'switched', from: 'fullscreen', to: 'regular' });
    await vt.waitForRender();

    expect(writeSpy.mock.calls.every(([chunk]) => !chunk.includes('\u001B[3J'))).toBe(true);
    expect(vt.getScrollBuffer().filter((row) => row.trim() === 'FORCE_ROW_1')).toHaveLength(1);
    expect(vt.getScrollBuffer().some((row) => row.trim() === 'FORCE_ROW_18')).toBe(true);

    session.ui.requestRender(true);
    expect(
      session.switchMode('fullscreen', {
        copyOnSelect: true,
        onBeforeStart: mountAll,
      }),
    ).toEqual({ status: 'switched', from: 'regular', to: 'fullscreen' });
    await vt.waitForRender();

    lines.push(new Text('FORCE_EXIT_ROW', 0, 0));
    session.exitToMainScreen(mountAll);
    await vt.flush();

    expect(writeSpy.mock.calls.every(([chunk]) => !chunk.includes('\u001B[3J'))).toBe(true);
    const finalBuffer = vt.getScrollBuffer();
    expect(finalBuffer.filter((row) => row.trim() === 'FORCE_ROW_1')).toHaveLength(1);
    expect(finalBuffer.some((row) => row.trim() === 'FORCE_EXIT_ROW')).toBe(true);
  });

  it('keeps search overlay above a same-anchor nonCapturing HUD when switchMode is blocked', async () => {
    const vt = new VirtualTerminal(80, 24);
    const session = new TuiRendererSession({
      terminal: vt,
      initialMode: 'fullscreen',
      copyOnSelect: true,
    });
    onTestFinished(() => {
      session.ui.stop();
    });

    session.ui.addChild(
      new Text(`searchable alpha\nsearchable beta\n${'body line\n'.repeat(30)}`, 0, 0),
    );
    const hudMouse = vi.fn(() => ({ handled: true }));
    const hud: Component = {
      render: (width) => {
        const line = 'HUD_BACKGROUND_TEXT'.padEnd(width, ' ').slice(0, width);
        return [line, line, line];
      },
      invalidate() {},
      handleMouse: hudMouse,
    };
    const hudHandle = session.ui.showOverlay(hud, {
      nonCapturing: true,
      anchor: 'top-right',
      width: '40%',
      minWidth: 32,
      margin: 1,
    });
    session.ui.start();
    await vt.waitForRender();
    expect(vt.getViewport().join('\n')).toContain('HUD_BACKGROUND_TEXT');

    vt.sendInput('\u001B[102;6u');
    vt.sendInput('searchable');
    await vt.waitForRender();
    expect(vt.getViewport().join('\n')).toContain('searchable');
    expect(vt.getViewport().join('\n')).not.toContain('HUD_BACKGROUND_TEXT');

    expect(
      session.switchMode('regular', {
        copyOnSelect: true,
        onBeforeStart: () => {},
      }),
    ).toEqual({ status: 'blocked', reason: 'active-overlay' });

    session.ui.requestRender();
    await vt.waitForRender();
    const afterBlockViewport = vt.getViewport().join('\n');
    expect(afterBlockViewport).toContain('searchable');
    expect(afterBlockViewport).not.toContain('HUD_BACKGROUND_TEXT');
    expect(hudHandle.isFocused()).toBe(false);

    const hudBounds = hudHandle.getBounds();
    expect(hudBounds).toBeDefined();
    const clickCol = hudBounds!.col + 15;
    const clickRow = hudBounds!.row + 2;
    vt.sendInput(`\u001B[<0;${String(clickCol)};${String(clickRow)}M`);
    vt.sendInput(`\u001B[<0;${String(clickCol)};${String(clickRow)}m`);
    await vt.waitForRender();
    expect(hudMouse).not.toHaveBeenCalled();

    vt.sendInput(' alpha');
    await vt.waitForRender();
    expect(vt.getViewport().join('\n')).toContain('1/1');
  });

  it('does not resurrect a nonCapturing overlay closed via hideOverlay() across switchMode', async () => {
    const vt = new VirtualTerminal(60, 12);
    const session = new TuiRendererSession({
      terminal: vt,
      initialMode: 'regular',
      copyOnSelect: true,
    });
    onTestFinished(() => {
      session.ui.stop();
    });

    session.ui.addChild(new Text('BASE_VIEW', 0, 0));
    const hudHandle = session.ui.showOverlay(new Text('EPHEMERAL_HUD', 0, 0), {
      nonCapturing: true,
      anchor: 'top-right',
      width: 16,
    });
    session.ui.start();
    await vt.waitForRender();
    expect(vt.getViewport().join('\n')).toContain('EPHEMERAL_HUD');

    session.ui.hideOverlay();
    await vt.waitForRender();
    expect(session.ui.hasOverlay()).toBe(false);
    expect(hudHandle.getBounds()).toBeUndefined();

    expect(
      session.switchMode('fullscreen', {
        copyOnSelect: true,
        onBeforeStart: () => {
          session.ui.addChild(new Text('BASE_VIEW', 0, 0));
        },
      }),
    ).toEqual({ status: 'switched', from: 'regular', to: 'fullscreen' });
    await vt.waitForRender();

    expect(session.ui.hasOverlay()).toBe(false);
    expect(hudHandle.getBounds()).toBeUndefined();
    expect(vt.getViewport().join('\n')).not.toContain('EPHEMERAL_HUD');
  });

  it('preserves focus on a focused nonCapturing overlay across switchMode and restores preFocus on unfocus', async () => {
    const vt = new VirtualTerminal(60, 10);
    const session = new TuiRendererSession({
      terminal: vt,
      initialMode: 'regular',
      copyOnSelect: true,
    });
    onTestFinished(() => {
      session.ui.stop();
    });

    const editor = new FocusableLine('editor', 0, 0);
    const statusOverlay = new FocusableLine('status', 0, 0);
    session.ui.addChild(editor);
    session.ui.setFocus(editor);
    session.ui.start();
    await vt.waitForRender();

    const handle = session.ui.showOverlay(statusOverlay, { nonCapturing: true });
    expect(handle.isFocused()).toBe(false);
    expect(editor.focused).toBe(true);

    handle.focus();
    expect(handle.isFocused()).toBe(true);
    expect(statusOverlay.focused).toBe(true);
    expect(editor.focused).toBe(false);

    expect(
      session.switchMode('fullscreen', {
        copyOnSelect: true,
        onBeforeStart: () => {
          session.ui.addChild(editor);
        },
      }),
    ).toEqual({ status: 'switched', from: 'regular', to: 'fullscreen' });
    await vt.waitForRender();

    expect(handle.isFocused()).toBe(true);
    expect(statusOverlay.focused).toBe(true);
    expect(editor.focused).toBe(false);

    handle.unfocus();
    expect(handle.isFocused()).toBe(false);
    expect(statusOverlay.focused).toBe(false);
    expect(editor.focused).toBe(true);
    expect((session.ui as TuiAltScreen).getFocusedComponent()).toBe(editor);
  });

  it('applies wheelScrollLines when switching to fullscreen and migrates suspend signal handlers', async () => {
    const vt = new VirtualTerminal(60, 12);
    const session = new TuiRendererSession({
      terminal: vt,
      initialMode: 'regular',
      copyOnSelect: true,
    });
    onTestFinished(() => {
      session.ui.setSuspendSignalHandler(undefined);
      session.ui.stop();
    });

    const onSuspend = vi.fn();
    session.ui.setSuspendSignalHandler(onSuspend);
    const body = new Text(
      Array.from({ length: 60 }, (_, index) => `line ${String(index + 1)}`).join('\n'),
      0,
      0,
    );
    session.ui.addChild(body);
    session.ui.start();
    await vt.waitForRender();

    expect(
      session.switchMode('fullscreen', {
        copyOnSelect: true,
        wheelScrollLines: 4,
        onBeforeStart: () => {
          session.ui.addChild(body);
        },
      }),
    ).toEqual({ status: 'switched', from: 'regular', to: 'fullscreen' });
    await vt.waitForRender();

    const alt = session.ui as TuiAltScreen;
    const beforeTop = alt.viewportTop;
    vt.sendInput('\u001B[<64;1;1M');
    await vt.waitForRender();
    expect(beforeTop - alt.viewportTop).toBe(4);

    process.emit('SIGTSTP', 'SIGTSTP');
    expect(onSuspend).toHaveBeenCalledTimes(1);

    session.ui.setSuspendSignalHandler(undefined);
    expect(
      session.switchMode('regular', {
        copyOnSelect: true,
        onBeforeStart: () => {
          session.ui.addChild(body);
        },
      }),
    ).toEqual({ status: 'switched', from: 'fullscreen', to: 'regular' });
    await vt.waitForRender();
    process.emit('SIGTSTP', 'SIGTSTP');
    expect(onSuspend).toHaveBeenCalledTimes(1);
  });
});
