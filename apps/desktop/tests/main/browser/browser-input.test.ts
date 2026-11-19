import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { browserFocusEmulationEnabled, setBrowserFocusEmulation, withBrowserDebugger, ensureBrowserDebugger, releaseBrowserDebugger, setBrowserMouseTouchEmulation } from '../../../src/main/browser/browser-debugger';
import { dispatchBrowserKeys, runBrowserInput } from '../../../src/main/browser/browser-input';

function contents(attached = false) {
  const events = new EventEmitter();
  const debuggerApi = {
    on: events.on.bind(events),
    isAttached: vi.fn(() => attached),
    attach: vi.fn(() => { attached = true; }),
    detach: vi.fn(() => { attached = false; events.emit('detach'); }),
    sendCommand: vi.fn(async (_method: string, _params?: Record<string, unknown>) => undefined),
  };
  return {
    debuggerApi,
    value: { debugger: debuggerApi, isDestroyed: () => false } as unknown as WebContents,
  };
}

describe('browser debugger ownership', () => {
  it('keeps the connection when device mode ends while automation still uses it', () => {
    const { value, debuggerApi } = contents();
    ensureBrowserDebugger(value, 'device');
    ensureBrowserDebugger(value, 'automation');
    releaseBrowserDebugger(value, 'device');
    expect(debuggerApi.attach).toHaveBeenCalledOnce();
    expect(debuggerApi.detach).not.toHaveBeenCalled();
    releaseBrowserDebugger(value, 'automation');
    expect(debuggerApi.detach).toHaveBeenCalledOnce();
  });

  it('does not detach a connection it did not create', () => {
    const { value, debuggerApi } = contents(true);
    ensureBrowserDebugger(value, 'device');
    releaseBrowserDebugger(value, 'device');
    expect(debuggerApi.attach).not.toHaveBeenCalled();
    expect(debuggerApi.detach).not.toHaveBeenCalled();
  });

  it('reattaches automation after disconnection without retaining invalid device ownership', () => {
    const { value, debuggerApi } = contents();
    ensureBrowserDebugger(value, 'device');
    ensureBrowserDebugger(value, 'automation');
    debuggerApi.detach();
    ensureBrowserDebugger(value, 'automation');
    releaseBrowserDebugger(value, 'automation');
    expect(debuggerApi.attach).toHaveBeenCalledTimes(2);
    expect(debuggerApi.isAttached()).toBe(false);
    releaseBrowserDebugger(value, 'device');
    expect(debuggerApi.isAttached()).toBe(false);
  });
});

describe('browser CDP input', () => {
  it('restores focus and mouse-to-touch emulation after a failed gesture', async () => {
    const { value, debuggerApi } = contents();
    ensureBrowserDebugger(value, 'device');
    await setBrowserMouseTouchEmulation(value, true);
    debuggerApi.sendCommand.mockClear();
    await expect(runBrowserInput(value, async () => { throw new Error('failed gesture'); })).rejects.toThrow('failed gesture');
    expect(debuggerApi.sendCommand.mock.calls).toEqual([
      ['Emulation.setEmitTouchEventsForMouse', { enabled: false, configuration: 'mobile' }],
      ['Emulation.setFocusEmulationEnabled', { enabled: true }],
      ['Emulation.setFocusEmulationEnabled', { enabled: false }],
      ['Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' }],
    ]);
  });

  it('does not restore touch emulation if device mode was disabled during input', async () => {
    const { value, debuggerApi } = contents();
    ensureBrowserDebugger(value, 'device');
    await setBrowserMouseTouchEmulation(value, true);
    await runBrowserInput(value, async () => {
      await setBrowserMouseTouchEmulation(value, false);
      debuggerApi.sendCommand.mockClear();
      releaseBrowserDebugger(value, 'device');
    });
    expect(debuggerApi.sendCommand.mock.calls).toEqual([
      ['Emulation.setFocusEmulationEnabled', { enabled: false }],
    ]);
    expect(debuggerApi.isAttached()).toBe(false);
  });
  it('serializes gestures for a page and continues after a failed gesture', async () => {
    const { value } = contents();
    const order: string[] = [];
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    const first = runBrowserInput(value, async () => {
      order.push('down');
      await gate;
      order.push('up');
      throw new Error('failed');
    });
    const rejected = expect(first).rejects.toThrow('failed');
    const second = runBrowserInput(value, async () => { order.push('next'); });
    await vi.waitFor(() => expect(order).toEqual(['down']));
    unblock();
    await rejected;
    await second;
    expect(order).toEqual(['down', 'up', 'next']);
  });

  it('sends printable characters, navigation keys and platform selection shortcuts', async () => {
    const send = vi.fn(async () => undefined);
    await dispatchBrowserKeys(send, ['Shift', 'a']);
    expect(send).toHaveBeenNthCalledWith(1, 'Input.dispatchKeyEvent', expect.objectContaining({
      type: 'keyDown', key: 'A', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'A', modifiers: 8,
    }));
    expect(send).toHaveBeenNthCalledWith(2, 'Input.dispatchKeyEvent', expect.objectContaining({ type: 'keyUp', key: 'A' }));
    send.mockClear();
    await dispatchBrowserKeys(send, ['ControlOrMeta', 'A']);
    expect(send).toHaveBeenNthCalledWith(1, 'Input.dispatchKeyEvent', expect.objectContaining({
      type: 'rawKeyDown', key: 'A', modifiers: process.platform === 'darwin' ? 4 : 2,
      ...(process.platform === 'darwin' ? { commands: ['selectAll'] } : {}),
    }));
    send.mockClear();
    await dispatchBrowserKeys(send, ['Enter']);
    expect(send).toHaveBeenNthCalledWith(1, 'Input.dispatchKeyEvent', expect.objectContaining({ key: 'Enter', text: '\r' }));
    send.mockClear();
    await dispatchBrowserKeys(send, ['Left']);
    expect(send).toHaveBeenNthCalledWith(1, 'Input.dispatchKeyEvent', expect.objectContaining({ key: 'ArrowLeft', windowsVirtualKeyCode: 37 }));
  });

  it('carries macOS editing commands for clipboard, undo and redo chords and none elsewhere', async () => {
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const chords: [readonly string[], string][] = [
      [['ControlOrMeta', 'a'], 'selectAll'], [['ControlOrMeta', 'c'], 'copy'],
      [['ControlOrMeta', 'x'], 'cut'], [['ControlOrMeta', 'v'], 'paste'],
      [['ControlOrMeta', 'z'], 'undo'], [['ControlOrMeta', 'Shift', 'z'], 'redo'],
    ];
    const plain: readonly string[][] = [
      ['ControlOrMeta', 'b'], ['ControlOrMeta', 'Enter'], ['z'], ['Shift', 'z'],
      ['ControlOrMeta', 'Shift', 'v'], ['ControlOrMeta', 'Shift', 'x'], ['ControlOrMeta', 'Shift', 'c'],
      ['ControlOrMeta', 'Shift', 'a'], ['ControlOrMeta', 'Alt', 'c'], ['ControlOrMeta', 'Control', 'a'],
      ['ControlOrMeta', 'Alt', 'Shift', 'z'],
    ];
    const send = vi.fn(async (_method: string, _params?: Record<string, unknown>) => undefined);
    try {
      Object.defineProperty(process, 'platform', { value: 'darwin', enumerable: true, configurable: true });
      for (const [keys, command] of chords) {
        send.mockClear();
        await dispatchBrowserKeys(send, keys);
        expect(send).toHaveBeenNthCalledWith(1, 'Input.dispatchKeyEvent', expect.objectContaining({
          type: 'rawKeyDown', commands: [command],
        }));
        expect(send.mock.calls[1]?.[1]).not.toHaveProperty('commands');
      }
      for (const keys of plain) {
        send.mockClear();
        await dispatchBrowserKeys(send, keys);
        for (const [, params] of send.mock.calls) expect(params).not.toHaveProperty('commands');
      }
      Object.defineProperty(process, 'platform', { value: 'win32', enumerable: true, configurable: true });
      for (const [keys] of chords) {
        send.mockClear();
        await dispatchBrowserKeys(send, keys);
        for (const [, params] of send.mock.calls) expect(params).not.toHaveProperty('commands');
      }
    } finally {
      Object.defineProperty(process, 'platform', realPlatform);
    }
  });

  it('presses all chord keys and releases them in reverse order', async () => {
    const events: Record<string, unknown>[] = [];
    await dispatchBrowserKeys(async (_method, params) => { events.push(params!); }, ['e', 'l']);
    expect(events.map(({ type, key }) => [type, key])).toEqual([
      ['keyDown', 'e'], ['keyDown', 'l'], ['keyUp', 'l'], ['keyUp', 'e'],
    ]);
  });

  it('releases a key if its down command fails and rejects invalid named keys before input', async () => {
    const send = vi.fn(async () => undefined).mockRejectedValueOnce(new Error('connection lost'));
    await expect(dispatchBrowserKeys(send, ['Enter'])).rejects.toThrow('connection lost');
    expect(send).toHaveBeenLastCalledWith('Input.dispatchKeyEvent', expect.objectContaining({ type: 'keyUp' }));
    send.mockClear();
    await expect(dispatchBrowserKeys(send, ['Shift', 'UnknownKey'])).rejects.toThrow('Unsupported browser key');
    expect(send).not.toHaveBeenCalled();
  });
});

it('preserves user focus emulation when automation finishes', async () => {
  const { value, debuggerApi } = contents();
  await setBrowserFocusEmulation(value, true);
  await runBrowserInput(value, async () => {});
  const focusCommands = debuggerApi.sendCommand.mock.calls.filter(([method]) => method === 'Emulation.setFocusEmulationEnabled');
  expect(focusCommands.at(-1)).toEqual(['Emulation.setFocusEmulationEnabled', { enabled: true }]);
  releaseBrowserDebugger(value, 'automation');
  expect(debuggerApi.detach).not.toHaveBeenCalled();
  await setBrowserFocusEmulation(value, false);
  expect(debuggerApi.detach).toHaveBeenCalledOnce();
});
it('keeps in-flight automation focused when the user disables persistent focus', async () => {
  const { value, debuggerApi } = contents();
  await setBrowserFocusEmulation(value, true);
  await runBrowserInput(value, async () => {
    await setBrowserFocusEmulation(value, false);
    expect(debuggerApi.sendCommand).toHaveBeenLastCalledWith('Emulation.setFocusEmulationEnabled', { enabled: true });
  });
  expect(debuggerApi.sendCommand).toHaveBeenLastCalledWith('Emulation.setFocusEmulationEnabled', { enabled: false });
});

it('honors disabling persistent focus while an input gesture is restoring focus', async () => {
  const { value, debuggerApi } = contents();
  await setBrowserFocusEmulation(value, true);
  let restoreStarted!: () => void;
  let releaseRestore!: () => void;
  const restoring = new Promise<void>(resolve => { restoreStarted = resolve; });
  const restoreGate = new Promise<void>(resolve => { releaseRestore = resolve; });
  let focusCalls = 0;
  let actualFocus = true;
  await debuggerApi.sendCommand.withImplementation(async (method, params) => {
    if (method !== 'Emulation.setFocusEmulationEnabled') return;
    actualFocus = params?.['enabled'] === true;
    if (++focusCalls === 2) {
      restoreStarted();
      await restoreGate;
    }
  }, async () => {
    const gesture = runBrowserInput(value, async () => {});
    await restoring;
    await setBrowserFocusEmulation(value, false);
    releaseRestore();
    await gesture;
  });
  expect(actualFocus).toBe(false);
});


it('releases pressed keys but stops new input after cancellation', async () => {
  const { value, debuggerApi } = contents();
  const controller = new AbortController();
  await debuggerApi.sendCommand.withImplementation(async (method, params) => {
    if (method === 'Input.dispatchKeyEvent' && params?.['type'] === 'keyDown') controller.abort();
  }, async () => {
    await expect(runBrowserInput(value, send => dispatchBrowserKeys(send, ['a', 'b']), controller.signal))
      .rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
  });
  const keys = debuggerApi.sendCommand.mock.calls.filter(([method]) => method === 'Input.dispatchKeyEvent');
  expect(keys.filter(([, params]) => params?.['type'] === 'keyDown')).toHaveLength(1);
  expect(keys).toContainEqual(['Input.dispatchKeyEvent', expect.objectContaining({ type: 'keyUp', key: 'a' })]);
  expect(debuggerApi.sendCommand).toHaveBeenLastCalledWith('Emulation.setFocusEmulationEnabled', { enabled: false });
});

it('releases keys when the control guard rejects during input', async () => {
  const { value, debuggerApi } = contents();
  let controlled = true;
  await debuggerApi.sendCommand.withImplementation(async (method, params) => {
    if (method === 'Input.dispatchKeyEvent' && params?.['type'] === 'keyDown') controlled = false;
  }, async () => {
    await expect(runBrowserInput(value, send => dispatchBrowserKeys(send, ['a', 'b']), undefined, async () => {
      if (!controlled) throw new Error('control revoked');
    })).rejects.toThrow('control revoked');
  });
  const keys = debuggerApi.sendCommand.mock.calls.filter(([method]) => method === 'Input.dispatchKeyEvent');
  expect(keys.filter(([, params]) => params?.['type'] === 'keyDown')).toHaveLength(1);
  expect(keys).toContainEqual(['Input.dispatchKeyEvent', expect.objectContaining({ type: 'keyUp', key: 'a' })]);
  expect(debuggerApi.sendCommand).toHaveBeenLastCalledWith('Emulation.setFocusEmulationEnabled', { enabled: false });
});


it('does not revive persistent focus after detaching during an update', async () => {
  const { value, debuggerApi } = contents();
  await setBrowserFocusEmulation(value, true);
  await debuggerApi.sendCommand.withImplementation(async () => {
    debuggerApi.detach();
    throw new Error('detached');
  }, async () => {
    await expect(setBrowserFocusEmulation(value, false)).rejects.toThrow('detached');
  });
  expect(browserFocusEmulationEnabled(value)).toBe(false);
  expect(debuggerApi.attach).toHaveBeenCalledOnce();
});

it('does not let an older focus-disable request detach a newer enable request', async () => {
  const { value, debuggerApi } = contents();
  await setBrowserFocusEmulation(value, true);
  let releaseDisable!: () => void;
  const gate = new Promise<void>(resolve => { releaseDisable = resolve; });
  await debuggerApi.sendCommand.withImplementation(async (_method, params) => {
    if (params?.['enabled'] === false) await gate;
  }, async () => {
    const disable = setBrowserFocusEmulation(value, false);
    await setBrowserFocusEmulation(value, true);
    releaseDisable();
    await disable;
  });
  expect(browserFocusEmulationEnabled(value)).toBe(true);
  expect(debuggerApi.isAttached()).toBe(true);
});

it('releases independent overlapping automation leases only after the last operation ends', async () => {
  const { value, debuggerApi } = contents();
  let finishFirst!: () => void;
  let finishSecond!: () => void;
  const first = withBrowserDebugger(value, () => new Promise<void>(resolve => { finishFirst = resolve; }));
  const second = withBrowserDebugger(value, () => new Promise<void>(resolve => { finishSecond = resolve; }));
  finishFirst();
  await first;
  expect(debuggerApi.detach).not.toHaveBeenCalled();
  finishSecond();
  await second;
  expect(debuggerApi.detach).toHaveBeenCalledOnce();
});

it('releases an input lease when the operation fails', async () => {
  const { value, debuggerApi } = contents();
  await expect(runBrowserInput(value, async () => { throw new Error('failed'); })).rejects.toThrow('failed');
  expect(debuggerApi.isAttached()).toBe(false);
});
