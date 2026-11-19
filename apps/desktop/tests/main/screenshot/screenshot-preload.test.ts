import { beforeEach, describe, expect, it, vi } from 'vitest';

const expose = vi.fn();
const invoke = vi.fn();
const send = vi.fn();
const on = vi.fn();
const removeListener = vi.fn();

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: expose },
  ipcRenderer: { invoke, send, on, removeListener },
}));

beforeEach(() => {
  vi.resetModules();
  expose.mockClear();
  invoke.mockReset();
  send.mockClear();
  on.mockClear();
  removeListener.mockClear();
});

describe('screenshot overlay preload', () => {
  it('exposes only the validated screenshot bridge', async () => {
    await import('../../../src/main/screenshot/screenshot-overlay-preload');
    const [name, bridge] = expose.mock.calls[0]!;
    expect(name).toBe('shotBridge');
    expect(Object.keys(bridge).sort()).toEqual(['bandEnd', 'bandStart', 'cancel', 'copyColor', 'editText', 'failed', 'loaded', 'onClearSelection', 'onContext', 'onPointerLeave', 'onPreviewEnabled', 'onWindowCandidates', 'perform', 'platform', 'pointerEnter', 'ready']);
    expect(bridge.platform).toBe(process.platform);

    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    invoke.mockResolvedValueOnce({ status: 'ok' });
    await expect(bridge.perform({ captureId: 'capture-1', action: 'add', displayId: '1', pngBytes: bytes, width: 1, height: 1, comment: '' })).resolves.toEqual({ status: 'ok' });
    expect(invoke).toHaveBeenLastCalledWith('kimi:shot-action', expect.objectContaining({ pngBytes: bytes }));

    await expect(bridge.perform({ action: 'add', displayId: '', pngBytes: bytes, width: 1, height: 1, comment: '' })).resolves.toEqual({ status: 'error', reason: 'invalid-payload' });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('forwards only validated hex and rgba colors with a capture identity', async () => {
    await import('../../../src/main/screenshot/screenshot-overlay-preload');
    const [, bridge] = expose.mock.calls[0]!;
    invoke.mockResolvedValue(true);
    for (const color of ['#17A2B8', 'rgba(23,162,184,0.5)']) {
      await expect(bridge.copyColor('capture-1', color)).resolves.toBe(true);
      expect(invoke).toHaveBeenLastCalledWith('kimi:shot-copy-color', 'capture-1', color);
    }
    for (const color of ['#17a2b8', 'rgba(256,162,184,1)', 'rgba(23, 162, 184, 1)', 'javascript:alert(1)']) {
      await expect(bridge.copyColor('capture-1', color)).resolves.toBe(false);
    }
    await expect(bridge.copyColor('', '#17A2B8')).resolves.toBe(false);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('removes the exact cross-screen selection listener', async () => {
    await import('../../../src/main/screenshot/screenshot-overlay-preload');
    const [, bridge] = expose.mock.calls[0]!;
    const callback = vi.fn();
    const off = bridge.onClearSelection(callback);
    expect(on).toHaveBeenCalledWith('kimi:shot-clear-selection', expect.any(Function));
    const listener = on.mock.calls[0]![1];
    listener({}, 'capture-1');
    expect(callback).toHaveBeenCalledWith('capture-1');
    off();
    expect(removeListener).toHaveBeenCalledWith('kimi:shot-clear-selection', listener);
  });

  it('only exposes the supported text commands with a capture identity', async () => {
    await import('../../../src/main/screenshot/screenshot-overlay-preload');
    const [, bridge] = expose.mock.calls[0]!;
    for (const command of ['selectAll', 'cut', 'copy', 'paste', 'undo', 'redo']) bridge.editText('capture-1', command);
    bridge.editText('capture-1', 'executeJavaScript');
    bridge.editText('capture-1', null);
    expect(send.mock.calls).toEqual(['selectAll', 'cut', 'copy', 'paste', 'undo', 'redo'].map((command) => ['kimi:shot-edit-text', 'capture-1', command]));
  });

  it('forwards selection release and unregisters preview notifications', async () => {
    await import('../../../src/main/screenshot/screenshot-overlay-preload');
    const [, bridge] = expose.mock.calls[0]!;
    bridge.bandEnd('capture-1');
    expect(send).toHaveBeenCalledWith('kimi:shot-band-end', 'capture-1');
    const callback = vi.fn();
    const off = bridge.onPreviewEnabled(callback);
    const listener = on.mock.calls[0]![1];
    listener({}, 'capture-1');
    expect(callback).toHaveBeenCalledWith('capture-1');
    off();
    expect(removeListener).toHaveBeenCalledWith('kimi:shot-preview-enabled', listener);
  });

  it('keeps the capture identity on cancel, readiness and failure messages', async () => {
    await import('../../../src/main/screenshot/screenshot-overlay-preload');
    const [, bridge] = expose.mock.calls[0]!;
    bridge.loaded();
    bridge.ready('capture-1');
    bridge.cancel('capture-1');
    bridge.failed('capture-2', 'frame-decode');
    bridge.pointerEnter('capture-2');
    expect(send.mock.calls).toEqual([
      ['kimi:shot-loaded'],
      ['kimi:shot-ready', 'capture-1'],
      ['kimi:shot-cancel', 'capture-1'],
      ['kimi:shot-failed', 'capture-2', 'frame-decode'],
      ['kimi:shot-pointer-enter', 'capture-2'],
    ]);
  });
});

describe('pinned screenshot preload', () => {
  it('validates resize values before sending them to the main process', async () => {
    await import('../../../src/main/screenshot/screenshot-pin-preload');
    const [name, bridge] = expose.mock.calls[0]!;
    expect(name).toBe('pinBridge');
    expect(Object.keys(bridge).sort()).toEqual(['close', 'failed', 'move', 'platform', 'ready', 'resize', 'resizeFromEdge']);
    bridge.resize(0.1);
    bridge.resize(Number.NaN);
    bridge.close();
    bridge.move(20, -10);
    bridge.move(Number.NaN, 1);
    bridge.move(1, Infinity);
    expect(send.mock.calls).toEqual([
      ['kimi:shot-pin-resize', 0.1],
      ['kimi:shot-pin-close'],
      ['kimi:shot-pin-move', 20, -10],
    ]);
  });
});
