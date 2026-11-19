import { createContext, Script } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const page = {
    bounds: { x: 0, y: 0, width: 400, height: 300 },
    generation: 1,
    visible: true,
    inputScale: 1,
    localFile: false,
    position: { scrollX: 0, scrollY: 0, deviceScaleFactor: 2, cssWidth: 400, cssHeight: 300 },
    elementResult: { ok: true, point: { x: 40, y: 50 } },
    webContents: {
      id: 1,
      capturePage: vi.fn(async () => ({
        isEmpty: () => false,
        getSize: () => ({ width: 800, height: 600 }),
        toPNG: () => Buffer.from('png'),
      })),
      executeJavaScriptInIsolatedWorld: vi.fn(async (_worldId: number, scripts: Array<{ code: string }>) => {
        const code = scripts[0]?.code ?? '';
        if (code.includes('scrollX: Number.isFinite')) return { ...mocks.page.position };
        if (code.includes('__kimiBrowserElementState =')) {
          const snapshotId = /const snapshotId = "([^"]+)"/.exec(code)?.[1] ?? '';
          return {
            snapshotId,
            elements: [{
              ref: 'e1',
              role: 'button',
              name: 'Run',
              inViewport: true,
              bounds: { x: 20, y: 30, width: 40, height: 20 },
            }],
          };
        }
        return { ...mocks.page.elementResult };
      }),
      debugger: { on: vi.fn(), isAttached: vi.fn(() => true), sendCommand: vi.fn(async (_method: string, _params?: Record<string, unknown>) => ({ data: 'cG5n' })) },
      sendInputEvent: vi.fn(),
      insertText: vi.fn(),
      focus: vi.fn(),
    },
  };
  return { page, imageSize: { width: 800, height: 600 } };
});

vi.mock('electron', () => {
  const image = (size: { width: number; height: number }): any => ({
    isEmpty: () => false, getSize: () => size, toPNG: () => Buffer.from('png'),
    resize: (next: { width: number; height: number }) => image(next),
  });
  return { nativeImage: { createFromBuffer: () => image(mocks.imageSize) } };
});

const rendering = vi.hoisted(() => ({ held: 0, holds: 0 }));
vi.mock('../../../src/main/browser/browser-view', () => ({
  getBrowserPage: (browserId: string) => (browserId === 'browser-1' ? mocks.page : null),
  keepBrowserPageRendering: (contents: unknown) => {
    if (contents !== mocks.page.webContents) throw new Error('unexpected page');
    rendering.held++;
    rendering.holds++;
    let released = false;
    return () => {
      if (!released) rendering.held--;
      released = true;
    };
  },
}));

const receipts = vi.hoisted(() => ({ wanted: false, codes: [] as string[], events: [] as string[], during: undefined as (() => void) | undefined }));
vi.mock('../../../src/main/browser/browser-receipts', () => ({
  browserReceiptWanted: () => receipts.wanted,
  captureBrowserReceipt: async (_contents: unknown, code: string) => {
    receipts.wanted = false;
    receipts.codes.push(code);
    receipts.events.push('capture');
    receipts.during?.();
  },
}));

import {
  BROWSER_PAGE_SCRIPT_TIMEOUT_MS,
  elementCommandCode,
  elementPresentationCode,
  receiptFrameCode,
  captureBrowserElements,
  captureBrowserVisual,
  clickBrowserVisual,
  clickBrowserVisualIfInteractive,
  hoverBrowserVisual,
  dragBrowserVisual,
  dragPathBrowserVisual,
  scrollBrowserVisual,
  runBrowserElementAction,
  shouldRedactBrowserElementValue,
  typeBrowserVisual,
  visualTargetProbeCode,
  isolated,
} from '../../../src/main/browser/browser-page';
import { runBrowserInput } from '../../../src/main/browser/browser-input';
import { BROWSER_AUTOMATION_PROTOCOL } from '../../../src/shared/browser-automation';

describe('browser page automation', () => {
  beforeEach(() => {
    mocks.imageSize = { width: 800, height: 600 };
    mocks.page.bounds = { x: 0, y: 0, width: 400, height: 300 };
    mocks.page.generation = 1;
    mocks.page.webContents.id = 1;
    mocks.page.visible = true;
    mocks.page.inputScale = 1;
    mocks.page.localFile = false;
    mocks.page.position = { scrollX: 0, scrollY: 0, deviceScaleFactor: 2, cssWidth: 400, cssHeight: 300 };
    mocks.page.elementResult = { ok: true, point: { x: 40, y: 50 } };
    rendering.held = 0;
    rendering.holds = 0;
    vi.clearAllMocks();
  });

  it('refuses to capture, read or drive a local file page', async () => {
    mocks.page.localFile = true;
    await expect(captureBrowserVisual('browser-1')).rejects.toMatchObject({ code: 'LOCAL_FILE_PAGE' });
    await expect(captureBrowserElements('browser-1')).rejects.toMatchObject({ code: 'LOCAL_FILE_PAGE' });
    expect(mocks.page.webContents.debugger.sendCommand).not.toHaveBeenCalled();
  });

  it('does not dispatch input or consume the visual snapshot when no target is found', async () => {
    const snapshot = await captureBrowserVisual('browser-1');
    const execute = mocks.page.webContents.executeJavaScriptInIsolatedWorld;
    const original = execute.getMockImplementation()!;
    await execute.withImplementation(async (world, scripts) => {
      if (scripts[0]!.code.includes('const evidence =')) return { outcome: 'no_target', nearby: [], elementsSnapshotId: 'elements-test', radius: 48, coordinateSpace: 'image', truncated: false, needsVisualConfirmation: true, message: '' } as any;
      return original(world, scripts);
    }, async () => {
      const request = { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.visual.click_if_interactive' as const, tabId: 'tab-1', snapshotId: snapshot.snapshotId, x: 100, y: 100 };
      expect(await clickBrowserVisualIfInteractive('browser-1', request)).toMatchObject({ outcome: 'no_target', needsVisualConfirmation: true });
      expect(mocks.page.webContents.debugger.sendCommand.mock.calls.some(([method]) => method.startsWith('Input.'))).toBe(false);
      await clickBrowserVisual('browser-1', { ...request, operation: 'page.visual.click' });
      expect(mocks.page.webContents.debugger.sendCommand).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mousePressed' }));
    });
  });

  it.each([true, false])('only clicks a detected target if its final hit test still passes (%s)', async valid => {
    const snapshot = await captureBrowserVisual('browser-1');
    const execute = mocks.page.webContents.executeJavaScriptInIsolatedWorld;
    const original = execute.getMockImplementation()!;
    await execute.withImplementation(async (world, scripts) => {
      const code = scripts[0]!.code;
      if (code.includes('const evidence =')) {
        if (code.includes('"guardRef":"e1"')) return valid as any;
        return { outcome: 'no_target', target: { ref: 'e1', name: 'Save' }, nearby: [], elementsSnapshotId: 'elements-test', radius: 48, coordinateSpace: 'image', truncated: false, needsVisualConfirmation: false, message: '' } as any;
      }
      return original(world, scripts);
    }, async () => {
      const operation = clickBrowserVisualIfInteractive('browser-1', { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.visual.click_if_interactive', tabId: 'tab-1', snapshotId: snapshot.snapshotId, x: 100, y: 100 });
      if (valid) {
        expect(await operation).toMatchObject({ outcome: 'clicked', target: { ref: 'e1', name: 'Save' } });
        expect(mocks.page.webContents.debugger.sendCommand).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mousePressed', x: 50, y: 50 }));
      } else {
        await expect(operation).rejects.toMatchObject({ code: 'ELEMENT_NOT_INTERACTABLE' });
        expect(mocks.page.webContents.debugger.sendCommand.mock.calls.some(([method, params]) => method === 'Input.dispatchMouseEvent' && params?.['type'] === 'mousePressed')).toBe(false);
      }
    });
  });

  it('binds input coordinates to the normalized image sent to the model', async () => {
    mocks.imageSize = { width: 4000, height: 3000 };
    const snapshot = await captureBrowserVisual('browser-1');
    expect(snapshot).toMatchObject({ width: 2000, height: 1500 });
    await clickBrowserVisual('browser-1', { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.visual.click', tabId: 'tab-1', snapshotId: snapshot.snapshotId, x: 1000, y: 750 });
    expect(mocks.page.webContents.debugger.sendCommand).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mousePressed', x: 200, y: 150 }));
  });

  it('captures a visual snapshot, converts image coordinates and reuses it after action', async () => {
    const snapshot = await captureBrowserVisual('browser-1');
    expect(snapshot).toMatchObject({
      mimeType: 'image/png',
      data: Buffer.from('png').toString('base64'),
      width: 800,
      height: 600,
      deviceScaleFactor: 2,
      viewport: { width: 400, height: 300 },
    });
    await clickBrowserVisual('browser-1', {
      protocol: BROWSER_AUTOMATION_PROTOCOL,
      operation: 'page.visual.click',
      tabId: 'tab-1',
      snapshotId: snapshot.snapshotId,
      x: 400,
      y: 300,
    });
    expect(mocks.page.webContents.debugger.sendCommand).toHaveBeenCalledWith('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: 200,
      y: 150,
      button: 'left',
      clickCount: 1,
    });
    await expect(clickBrowserVisual('browser-1', {
      protocol: BROWSER_AUTOMATION_PROTOCOL,
      operation: 'page.visual.click',
      tabId: 'tab-1',
      snapshotId: snapshot.snapshotId,
      x: 1,
      y: 1,
    })).resolves.toBeUndefined();
  });

  it('brackets screenshot capture with position reads and rejects movement during capture', async () => {
    const order: string[] = [];
    await mocks.page.webContents.executeJavaScriptInIsolatedWorld.withImplementation(async () => {
      order.push('position');
      return { ...mocks.page.position };
    }, async () => {
      await mocks.page.webContents.debugger.sendCommand.withImplementation(async (method) => {
        if (method === 'Page.captureScreenshot') { order.push('image'); mocks.page.position.scrollY = 300; }
        return { data: 'cG5n' };
      }, async () => {
        await expect(captureBrowserVisual('browser-1')).rejects.toMatchObject({ code: 'PAGE_NOT_READY' });
      });
    });
    expect(order).toEqual(['position', 'image', 'position']);
  });

  function stallScreenshots(stall: () => Promise<never>): () => void {
    const sendCommand = mocks.page.webContents.debugger.sendCommand;
    const original = sendCommand.getMockImplementation()!;
    sendCommand.mockImplementation((method, params) => method === 'Page.captureScreenshot' ? stall() : original(method, params));
    return () => { sendCommand.mockImplementation(original); };
  }

  it('keeps the page producing frames for the whole capture, even when it is hidden', async () => {
    mocks.page.visible = false;
    rendering.holds = 0;
    const seen: string[] = [];
    const execute = mocks.page.webContents.executeJavaScriptInIsolatedWorld;
    const sendCommand = mocks.page.webContents.debugger.sendCommand;
    const originalExecute = execute.getMockImplementation()!;
    const originalSend = sendCommand.getMockImplementation()!;
    execute.mockImplementation(async () => {
      seen.push(`position ${rendering.held}`);
      return { ...mocks.page.position };
    });
    sendCommand.mockImplementation(async (method) => {
      if (method === 'Page.captureScreenshot') seen.push(`image ${rendering.held}`);
      return { data: 'cG5n' };
    });
    const outcome = await captureBrowserVisual('browser-1').catch((error: unknown) => error).finally(() => {
      execute.mockImplementation(originalExecute);
      sendCommand.mockImplementation(originalSend);
    });
    expect(outcome).toMatchObject({ width: 800, height: 600 });
    expect(seen).toEqual(['position 1', 'image 1', 'position 1']);
    expect(rendering.holds).toBe(1);
    expect(rendering.held).toBe(0);
  });

  it('stops waiting for a screenshot that never renders and releases the page', async () => {
    vi.useFakeTimers();
    const restore = stallScreenshots(() => new Promise<never>((_resolve, reject) => { setTimeout(() => reject(new Error('target closed while handling command')), 60_000); }));
    try {
      const capture = captureBrowserVisual('browser-1').then(() => 'captured', (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(9_999);
      const heldBeforeLimit = rendering.held;
      await vi.advanceTimersByTimeAsync(1);
      const outcome = await Promise.race([capture, Promise.resolve('still waiting')]);
      const heldAfterLimit = rendering.held;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(heldBeforeLimit).toBe(1);
      expect(outcome).toMatchObject({ code: 'PAGE_NOT_READY', message: expect.stringContaining('capture again') });
      expect(heldAfterLimit).toBe(0);
    } finally {
      restore();
      vi.useRealTimers();
    }
  });

  it('stops waiting for a screenshot when the call is cancelled', async () => {
    const controller = new AbortController();
    const restore = stallScreenshots(() => new Promise<never>(() => undefined));
    try {
      const capture = captureBrowserVisual('browser-1', controller.signal).then(() => 'captured', (error: unknown) => error);
      await vi.waitFor(() => expect(mocks.page.webContents.debugger.sendCommand).toHaveBeenCalledWith('Page.captureScreenshot', expect.anything()));
      controller.abort();
      const outcome = await Promise.race([capture, new Promise(resolve => { setTimeout(() => resolve('still waiting'), 1000); })]);
      expect(outcome).toMatchObject({ code: 'OPERATION_ABORTED' });
      expect(rendering.held).toBe(0);
      await expect(captureBrowserVisual('browser-1', controller.signal)).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
      expect(rendering.held).toBe(0);
    } finally {
      restore();
    }
  });

  function stallPositionReads(stall: () => Promise<unknown>): () => void {
    const execute = mocks.page.webContents.executeJavaScriptInIsolatedWorld;
    const original = execute.getMockImplementation()!;
    execute.mockImplementation((worldId, scripts) => scripts[0]?.code.includes('scrollX: Number.isFinite') ? stall().then(() => original(worldId, scripts)) : original(worldId, scripts));
    return () => { execute.mockImplementation(original); };
  }

  it('gives up after 10 seconds when the page never reports its position and releases the page', async () => {
    vi.useFakeTimers();
    const restore = stallPositionReads(() => new Promise<never>(() => undefined));
    try {
      const capture = captureBrowserVisual('browser-1').then(() => 'captured', (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(9_999);
      const heldBeforeLimit = rendering.held;
      const beforeLimit = await Promise.race([capture, Promise.resolve('still waiting')]);
      await vi.advanceTimersByTimeAsync(1);
      const outcome = await Promise.race([capture, Promise.resolve('still waiting')]);
      expect(heldBeforeLimit).toBe(1);
      expect(beforeLimit).toBe('still waiting');
      expect(outcome).toMatchObject({ code: 'PAGE_NOT_READY', message: expect.stringContaining('capture again') });
      expect(rendering.held).toBe(0);
      expect(mocks.page.webContents.debugger.sendCommand).not.toHaveBeenCalledWith('Page.captureScreenshot', expect.anything());
    } finally {
      restore();
      vi.useRealTimers();
    }
  });

  it('stops at once when cancelled while the page position is being read', async () => {
    const controller = new AbortController();
    const restore = stallPositionReads(() => new Promise<never>(() => undefined));
    try {
      const capture = captureBrowserVisual('browser-1', controller.signal).then(() => 'captured', (error: unknown) => error);
      await vi.waitFor(() => expect(mocks.page.webContents.executeJavaScriptInIsolatedWorld).toHaveBeenCalled());
      controller.abort();
      const outcome = await Promise.race([capture, new Promise(resolve => { setTimeout(() => resolve('still waiting'), 1000); })]);
      expect(outcome).toMatchObject({ code: 'OPERATION_ABORTED' });
      expect(rendering.held).toBe(0);
    } finally {
      restore();
    }
  });

  it('counts the position reads and the screenshot against one 10 second limit', async () => {
    vi.useFakeTimers();
    const slow = () => new Promise<void>(resolve => { setTimeout(resolve, 4_000); });
    const restorePositions = stallPositionReads(slow);
    const restoreScreenshots = stallScreenshots(() => slow().then(() => ({ data: 'cG5n' }) as never));
    try {
      const capture = captureBrowserVisual('browser-1').then(() => 'captured', (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(9_999);
      const beforeLimit = await Promise.race([capture, Promise.resolve('still waiting')]);
      await vi.advanceTimersByTimeAsync(1);
      const outcome = await Promise.race([capture, Promise.resolve('still waiting')]);
      expect(beforeLimit).toBe('still waiting');
      expect(outcome).toMatchObject({ code: 'PAGE_NOT_READY' });
      expect(rendering.held).toBe(0);
    } finally {
      restoreScreenshots();
      restorePositions();
      vi.useRealTimers();
    }
  });

  it('refuses a visual snapshot until the pending navigation commits', async () => {
    Object.assign(mocks.page, { committed: false });
    try {
      await expect(captureBrowserVisual('browser-1')).rejects.toMatchObject({ code: 'PAGE_NOT_READY' });
      expect(mocks.page.webContents.debugger.sendCommand).not.toHaveBeenCalledWith('Page.captureScreenshot', expect.anything());
    } finally {
      Object.assign(mocks.page, { committed: true });
    }
    await expect(captureBrowserVisual('browser-1')).resolves.toMatchObject({ snapshotId: expect.any(String) });
  });

  it('rejects a capture whose image and position cross a navigation', async () => {
    let releasePosition!: () => void;
    let readStarted!: () => void;
    const gate = new Promise<void>(resolve => { releasePosition = resolve; });
    const started = new Promise<void>(resolve => { readStarted = resolve; });
    await mocks.page.webContents.executeJavaScriptInIsolatedWorld.withImplementation(async () => {
      readStarted();
      await gate;
      return { ...mocks.page.position };
    }, async () => {
      const capture = captureBrowserVisual('browser-1');
      const rejected = expect(capture).rejects.toMatchObject({ code: 'PAGE_NOT_READY' });
      await started;
      mocks.page.generation += 1;
      releasePosition();
      await rejected;
    });
  });

  it('keeps snapshot coordinates after resize and allows hidden pages', async () => {
    const snapshot = await captureBrowserVisual('browser-1');
    mocks.page.bounds = { ...mocks.page.bounds, width: 500 };
    await expect(hoverBrowserVisual('browser-1', {
      protocol: BROWSER_AUTOMATION_PROTOCOL,
      operation: 'page.visual.hover',
      tabId: 'tab-1',
      snapshotId: snapshot.snapshotId,
      x: 10,
      y: 10,
    })).resolves.toBeUndefined();

    expect(mocks.page.webContents.debugger.sendCommand).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ x: 5, y: 5 }));
    mocks.page.visible = false;
    await expect(captureBrowserVisual('browser-1')).resolves.toMatchObject({ width: 800, height: 600 });
    expect(mocks.page.webContents.debugger.sendCommand).toHaveBeenCalledWith('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  });

  it.each(['navigation', 'replacement'] as const)('rejects a snapshot after %s', async change => {
    const snapshot = await captureBrowserVisual('browser-1');
    if (change === 'navigation') mocks.page.generation++;
    else mocks.page.webContents.id = 2;
    await expect(clickBrowserVisual('browser-1', {
      protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.visual.click', tabId: 'tab-1',
      snapshotId: snapshot.snapshotId, x: 100, y: 100,
    })).rejects.toMatchObject({ code: 'STALE_SNAPSHOT' });
    expect(mocks.page.webContents.debugger.sendCommand).not.toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.anything());
  });

  it('maps visual coordinates through CSS viewport size and device display scale', async () => {
    mocks.page.position.cssWidth = 800;
    mocks.page.position.cssHeight = 600;
    mocks.page.inputScale = 0.5;
    const snapshot = await captureBrowserVisual('browser-1');
    await clickBrowserVisual('browser-1', {
      protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.visual.click', tabId: 'tab-1',
      snapshotId: snapshot.snapshotId, x: 200, y: 100,
    });
    expect(mocks.page.webContents.debugger.sendCommand).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({
      type: 'mousePressed', x: 100, y: 50,
    }));
    expect(mocks.page.webContents.focus).not.toHaveBeenCalled();
  });

  it('keeps CSS coordinates when page zoom changes without resizing the panel', async () => {
    const snapshot = await captureBrowserVisual('browser-1');
    mocks.page.position.cssWidth = 200;
    await expect(clickBrowserVisual('browser-1', {
      protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.visual.click', tabId: 'tab-1',
      snapshotId: snapshot.snapshotId, x: 200, y: 100,
    })).resolves.toBeUndefined();
    expect(mocks.page.webContents.debugger.sendCommand).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ x: 100, y: 50 }));
  });

  it.each(['click', 'drag'] as const)('allows %s if the page scrolls during the final control check before pressing', async (operation) => {
    const snapshot = await captureBrowserVisual('browser-1');
    let checks = 0;
    const validate = async () => { if (++checks === (operation === 'click' ? 3 : 4)) mocks.page.position.scrollY = 300; };
    const base = { protocol: BROWSER_AUTOMATION_PROTOCOL, tabId: 'tab-1', snapshotId: snapshot.snapshotId } as const;
    const action = operation === 'click'
      ? clickBrowserVisual('browser-1', { ...base, operation: 'page.visual.click', x: 100, y: 100 }, undefined, validate)
      : dragBrowserVisual('browser-1', { ...base, operation: 'page.visual.drag', from: { x: 100, y: 100 }, to: { x: 300, y: 300 } }, undefined, validate);
    await expect(action).resolves.toBeUndefined();
    expect(mocks.page.webContents.debugger.sendCommand).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mousePressed' }));
  });

  it('allows scrolling caused by a drag after its initial press', async () => {
    const snapshot = await captureBrowserVisual('browser-1');
    await mocks.page.webContents.debugger.sendCommand.withImplementation(async (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params?.['type'] === 'mouseMoved' && params?.['buttons'] === 1) mocks.page.position.scrollY += 20;
      return { data: 'cG5n' };
    }, async () => {
      await dragBrowserVisual('browser-1', {
        protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.visual.drag', tabId: 'tab-1', snapshotId: snapshot.snapshotId,
        from: { x: 0, y: 0 }, to: { x: 200, y: 200 },
      });
    });
    expect(mocks.page.webContents.debugger.sendCommand).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mouseReleased', x: 100, y: 100 }));
  });

  it('releases a cancelled drag at its last position instead of completing the drop', async () => {
    const snapshot = await captureBrowserVisual('browser-1');
    const controller = new AbortController();
    const commands = mocks.page.webContents.debugger.sendCommand;
    await commands.withImplementation(async (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params?.['type'] === 'mouseMoved' && params?.['buttons'] === 1) {
        controller.abort();
      }
      return { data: Buffer.from('png').toString('base64') };
    }, async () => {
      await expect(dragBrowserVisual('browser-1', {
        protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.visual.drag', tabId: 'tab-1',
        snapshotId: snapshot.snapshotId, from: { x: 0, y: 0 }, to: { x: 400, y: 400 },
      }, controller.signal)).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
    });
    const moves = commands.mock.calls.filter(([method, params]) => method === 'Input.dispatchMouseEvent' && params?.['type'] === 'mouseMoved');
    expect(moves).toHaveLength(2);
    expect(commands).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mouseReleased', x: moves.at(-1)![1]!['x'], y: moves.at(-1)![1]!['y'] }));
  });

  it('draws a closed path as one continuous stroke', async () => {
    const snapshot = await captureBrowserVisual('browser-1');
    const commands = mocks.page.webContents.debugger.sendCommand;
    commands.mockClear();
    const corners = [{ x: 100, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 300 }, { x: 100, y: 300 }, { x: 100, y: 100 }];
    await dragPathBrowserVisual('browser-1', {
      protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.visual.drag_path', tabId: 'tab-1',
      snapshotId: snapshot.snapshotId, points: corners, durationMs: 0,
    });
    const mouse = commands.mock.calls.filter(([method]) => method === 'Input.dispatchMouseEvent').map(([, params]) => params!);
    expect(mouse.filter(params => params['type'] === 'mousePressed')).toEqual([expect.objectContaining({ x: 50, y: 50, button: 'left', buttons: 1 })]);
    expect(mouse.filter(params => params['type'] === 'mouseReleased')).toEqual([expect.objectContaining({ x: 50, y: 50, button: 'left', buttons: 0 })]);
    const pressed = mouse.findIndex(params => params['type'] === 'mousePressed');
    const strokes = mouse.slice(pressed + 1, -1);
    expect(mouse.at(-1)!['type']).toBe('mouseReleased');
    expect(strokes.every(params => params['type'] === 'mouseMoved' && params['buttons'] === 1)).toBe(true);
    for (const corner of corners.slice(1)) expect(strokes).toContainEqual(expect.objectContaining({ x: corner.x / 2, y: corner.y / 2 }));
    let previous = { x: 50, y: 50 };
    for (const params of strokes) {
      expect(Math.hypot(Number(params['x']) - previous.x, Number(params['y']) - previous.y)).toBeLessThanOrEqual(6);
      previous = { x: Number(params['x']), y: Number(params['y']) };
    }
  });

  it('holds the requested button and modifiers along a drag path', async () => {
    const snapshot = await captureBrowserVisual('browser-1');
    const commands = mocks.page.webContents.debugger.sendCommand;
    commands.mockClear();
    await dragPathBrowserVisual('browser-1', {
      protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.visual.drag_path', tabId: 'tab-1',
      snapshotId: snapshot.snapshotId, points: [{ x: 0, y: 0 }, { x: 20, y: 0 }], button: 'right', modifiers: ['Shift', 'Alt'], durationMs: 0,
    });
    const mouse = commands.mock.calls.filter(([method]) => method === 'Input.dispatchMouseEvent').map(([, params]) => params!);
    expect(mouse.filter(params => params['type'] !== 'mouseReleased').slice(1).every(params => params['button'] === 'right' && params['buttons'] === 2 && params['modifiers'] === 9)).toBe(true);
    expect(mouse.at(-1)).toMatchObject({ type: 'mouseReleased', button: 'right', buttons: 0, x: 10, y: 0 });
  });

  it('keeps a drag path mixing long and short segments within the move cap', async () => {
    const snapshot = await captureBrowserVisual('browser-1');
    const commands = mocks.page.webContents.debugger.sendCommand;
    commands.mockClear();
    const zigzag = Array.from({ length: 48 }, (_, index) => index % 2 === 0 ? { x: 0, y: 0 } : { x: 798, y: 598 });
    const tail = Array.from({ length: 452 }, (_, index) => ({ x: 796 - index, y: 598 }));
    await dragPathBrowserVisual('browser-1', {
      protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.visual.drag_path', tabId: 'tab-1',
      snapshotId: snapshot.snapshotId, points: [...zigzag, ...tail], durationMs: 0,
    });
    const strokes = commands.mock.calls.filter(([method, params]) => method === 'Input.dispatchMouseEvent' && params?.['type'] === 'mouseMoved' && params?.['buttons'] === 1);
    expect(strokes.length).toBeGreaterThan(3900);
    expect(strokes.length).toBeLessThanOrEqual(4000);
  });

  it('reaches the end of a short drag path only when its duration has elapsed', async () => {
    const snapshot = await captureBrowserVisual('browser-1');
    const commands = mocks.page.webContents.debugger.sendCommand;
    commands.mockClear();
    const sentAt: Array<{ type: unknown; at: number }> = [];
    await commands.withImplementation(async (method, params) => {
      if (method === 'Input.dispatchMouseEvent') sentAt.push({ type: params?.['type'], at: Date.now() });
      return { data: Buffer.from('png').toString('base64') };
    }, async () => {
      await dragPathBrowserVisual('browser-1', {
        protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.visual.drag_path', tabId: 'tab-1',
        snapshotId: snapshot.snapshotId, points: [{ x: 0, y: 0 }, { x: 4, y: 0 }], durationMs: 300,
      });
    });
    const pressed = sentAt.find(entry => entry.type === 'mousePressed')!;
    const moved = sentAt.filter(entry => entry.type === 'mouseMoved').at(-1)!;
    expect(moved.at - pressed.at).toBeGreaterThanOrEqual(290);
  });

  it('releases an aborted drag path at its last position', async () => {
    const snapshot = await captureBrowserVisual('browser-1');
    const controller = new AbortController();
    const commands = mocks.page.webContents.debugger.sendCommand;
    commands.mockClear();
    let strokes = 0;
    await commands.withImplementation(async (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params?.['type'] === 'mouseMoved' && params?.['buttons'] === 1 && ++strokes === 3) controller.abort();
      return { data: Buffer.from('png').toString('base64') };
    }, async () => {
      await expect(dragPathBrowserVisual('browser-1', {
        protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.visual.drag_path', tabId: 'tab-1',
        snapshotId: snapshot.snapshotId, points: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 400 }],
      }, controller.signal)).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
    });
    const mouse = commands.mock.calls.filter(([method]) => method === 'Input.dispatchMouseEvent').map(([, params]) => params!);
    const moves = mouse.filter(params => params['type'] === 'mouseMoved' && params['buttons'] === 1);
    expect(moves).toHaveLength(3);
    expect(mouse.filter(params => params['type'] === 'mouseReleased')).toEqual([expect.objectContaining({ x: moves.at(-1)!['x'], y: moves.at(-1)!['y'], buttons: 0 })]);
  });

  it('rejects a drag path point outside the snapshot without pressing', async () => {
    const snapshot = await captureBrowserVisual('browser-1');
    const commands = mocks.page.webContents.debugger.sendCommand;
    commands.mockClear();
    await expect(dragPathBrowserVisual('browser-1', {
      protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.visual.drag_path', tabId: 'tab-1',
      snapshotId: snapshot.snapshotId, points: [{ x: 0, y: 0 }, { x: 100000, y: 0 }],
    })).rejects.toMatchObject({ code: 'COORDINATE_OUT_OF_BOUNDS' });
    expect(commands).not.toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.anything());
  });

  it('does not type a queued request after cancellation', async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const running = new Promise<void>(resolve => { started = resolve; });
    const first = runBrowserInput(mocks.page.webContents as never, async () => {
      started();
      await gate;
    });
    await running;
    const controller = new AbortController();
    const second = typeBrowserVisual('browser-1', {
      protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.visual.type_text', tabId: 'tab-1', text: 'must not type',
    }, controller.signal);
    const cancelled = expect(second).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
    controller.abort();
    release();
    await first;
    await cancelled;
    expect(mocks.page.webContents.debugger.sendCommand).not.toHaveBeenCalledWith('Input.insertText', expect.anything());
  });

  it('uses CDP text input for visual replacement without native focus', async () => {
    await typeBrowserVisual('browser-1', {
      protocol: BROWSER_AUTOMATION_PROTOCOL,
      operation: 'page.visual.type_text',
      tabId: 'tab-1',
      text: 'replacement',
      replace: true,
    });
    expect(mocks.page.webContents.debugger.sendCommand).toHaveBeenCalledWith(
      'Input.dispatchKeyEvent', expect.objectContaining({
        type: 'rawKeyDown', key: 'A',
        modifiers: process.platform === 'darwin' ? 4 : 2,
      }),
    );
    expect(mocks.page.webContents.debugger.sendCommand).toHaveBeenCalledWith('Input.insertText', { text: 'replacement' });
    expect(mocks.page.webContents.focus).not.toHaveBeenCalled();
    expect(mocks.page.webContents.sendInputEvent).not.toHaveBeenCalled();

  });

  it('captures semantic element refs and performs element actions through the isolated world', async () => {
    const snapshot = await captureBrowserElements('browser-1');
    expect(snapshot.elements).toEqual([
      {
        ref: 'e1',
        role: 'button',
        name: 'Run',
        inViewport: true,
        bounds: { x: 20, y: 30, width: 40, height: 20 },
      },
    ]);
    await runBrowserElementAction('browser-1', {
      protocol: BROWSER_AUTOMATION_PROTOCOL,
      operation: 'page.element.click',
      tabId: 'tab-1',
      snapshotId: snapshot.snapshotId,
      ref: 'e1',
    });
    expect(mocks.page.webContents.debugger.sendCommand).toHaveBeenCalledWith('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: 40,
      y: 50,
      button: 'left',
      clickCount: 1,
    });
  });

  function pageWithElement(covered: (x: number, y: number) => boolean) {
    const occluder = {
      tagName: 'DIV',
      attributes: { id: 'toast-host', class: 'modal-mask is-open fade extra', role: 'dialog' } as Record<string, string>,
      textContent: 'Loading',
      parentElement: null,
      getAttribute(name: string) { return this.attributes[name] ?? null; },
      getRootNode() { return null; },
    };
    class FakeInput {
      tagName = 'INPUT';
      type = 'text';
      readOnly = false;
      isConnected = true;
      parentElement = null;
      getAttribute() { return null; }
      getRootNode() { return null; }
      scrollIntoView() {}
      getBoundingClientRect() { return { left: 1800, right: 2000, top: 100, bottom: 140 }; }
      focus() { document.activeElement = this; }
    }
    const target = new FakeInput();
    const document = { activeElement: null as unknown, elementFromPoint: (x: number, y: number) => covered(x, y) ? occluder : target, getElementById: () => null };
    const world = createContext({ document, innerWidth: 1920, innerHeight: 1080, HTMLInputElement: FakeInput, HTMLTextAreaElement: class {}, Event, __kimiBrowserElementState: { snapshotId: 'snapshot', elements: new Map([['target', target]]) } });
    const run = mocks.page.webContents.executeJavaScriptInIsolatedWorld;
    const original = run.getMockImplementation()!;
    run.mockImplementation(async (worldId, scripts) => {
      const code = scripts[0]?.code ?? '';
      return code.includes('const interactionPoint') ? new Script(code).runInContext(world) : original(worldId, scripts);
    });
    return { target, restore: () => run.mockImplementation(original) };
  }

  const pressed = () => mocks.page.webContents.debugger.sendCommand.mock.calls.filter(([method, params]) => method === 'Input.dispatchMouseEvent' && params?.['type'] === 'mousePressed').map(([, params]) => params!);

  it('clicks the visible-area center of an uncovered element under fit scaling', async () => {
    mocks.page.inputScale = 0.23;
    const page = pageWithElement(() => false);
    try {
      await runBrowserElementAction('browser-1', { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.element.click', tabId: 'tab', snapshotId: 'snapshot', ref: 'target' });
    } finally { page.restore(); }
    expect(pressed()).toHaveLength(1);
    expect(pressed()[0]!['x']).toBeCloseTo(1860 * 0.23);
    expect(pressed()[0]!['y']).toBeCloseTo(120 * 0.23);
  });

  it.each([['click', 'mousePressed'], ['hover', 'mouseMoved']] as const)('falls back to a reachable part of the element for %s when its center is covered', async (operation, type) => {
    mocks.page.inputScale = 0.23;
    const page = pageWithElement((_x, y) => y < 125);
    try {
      await runBrowserElementAction('browser-1', { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: `page.element.${operation}`, tabId: 'tab', snapshotId: 'snapshot', ref: 'target' });
    } finally { page.restore(); }
    const moves = mocks.page.webContents.debugger.sendCommand.mock.calls.filter(([method, params]) => method === 'Input.dispatchMouseEvent' && params?.['type'] === type).map(([, params]) => params!);
    expect(moves.length).toBeGreaterThan(0);
    expect(moves[0]!['x']).toBeCloseTo(1860 * 0.23);
    expect(moves[0]!['y']).toBeCloseTo(134 * 0.23);
  });

  it('names the covering element when no part of the element is reachable', async () => {
    const page = pageWithElement(() => true);
    try {
      const error = await runBrowserElementAction('browser-1', { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.element.click', tabId: 'tab', snapshotId: 'snapshot', ref: 'target' }).catch((reason: unknown) => reason);
      expect(error).toMatchObject({ code: 'ELEMENT_NOT_INTERACTABLE' });
      expect((error as Error).message).toBe('The element is covered by <div id="toast-host" class="modal-mask is-open fade" role="dialog"> "Loading" at its visible bounds.');
    } finally { page.restore(); }
    expect(pressed()).toEqual([]);
  });

  it('applies the same reachability gate to text input', async () => {
    const partly = pageWithElement((_x, y) => y < 125);
    try {
      await runBrowserElementAction('browser-1', { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.element.fill', tabId: 'tab', snapshotId: 'snapshot', ref: 'target', text: 'hello' });
    } finally { partly.restore(); }
    expect(mocks.page.webContents.debugger.sendCommand).toHaveBeenCalledWith('Input.insertText', { text: 'hello' });
    mocks.page.webContents.debugger.sendCommand.mockClear();
    const covered = pageWithElement(() => true);
    try {
      const error = await runBrowserElementAction('browser-1', { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.element.fill', tabId: 'tab', snapshotId: 'snapshot', ref: 'target', text: 'hello' }).catch((reason: unknown) => reason);
      expect(error).toMatchObject({ code: 'ELEMENT_NOT_INTERACTABLE' });
      expect((error as Error).message).toContain('covered by <div id="toast-host"');
    } finally { covered.restore(); }
    expect(mocks.page.webContents.debugger.sendCommand).not.toHaveBeenCalledWith('Input.insertText', expect.anything());
  });

  it('keeps element targeting and text input in the same transaction', async () => {
    const events: string[] = [];
    const contents = mocks.page.webContents;
    await contents.executeJavaScriptInIsolatedWorld.withImplementation(async (_world, scripts) => {
      const payload = /const request = (.*);/.exec(scripts[0]!.code)?.[1];
      const request = JSON.parse(payload!) as { ref: string };
      if (!scripts[0]!.code.includes('"guard" ===')) events.push(`focus:${request.ref}`);
      return { ok: true } as never;
    }, async () => {
      await contents.debugger.sendCommand.withImplementation(async (...args: unknown[]) => {
        if (args[0] === 'Input.insertText') events.push(`input:${(args[1] as { text: string }).text}`);
        return { data: 'cG5n' };
      }, async () => {
        await Promise.all(['first', 'second'].map((text, index) => runBrowserElementAction('browser-1', {
          protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.element.fill', tabId: 'tab-1',
          snapshotId: 'elements', ref: `e${index + 1}`, text,
        })));
      });
    });
    expect(events).toEqual(['focus:e1', 'input:first', 'focus:e2', 'input:second']);
  });

  it('allows queued visual actions to reuse one snapshot', async () => {
    const snapshot = await captureBrowserVisual('browser-1');
    const request = {
      protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.visual.click' as const, tabId: 'tab-1',
      snapshotId: snapshot.snapshotId, x: 40, y: 50,
    };
    const outcomes = await Promise.allSettled([
      clickBrowserVisual('browser-1', request), clickBrowserVisual('browser-1', request),
    ]);
    expect(outcomes[0]?.status).toBe('fulfilled');
    expect(outcomes[1]?.status).toBe('fulfilled');
  });

  it('keeps older snapshots usable after taking a new screenshot', async () => {
    const old = await captureBrowserVisual('browser-1');
    const current = await captureBrowserVisual('browser-1');
    const request = { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.visual.click' as const, tabId: 'tab-1', x: 40, y: 50 };
    await expect(clickBrowserVisual('browser-1', { ...request, snapshotId: old.snapshotId })).resolves.toBeUndefined();
    await expect(clickBrowserVisual('browser-1', { ...request, snapshotId: current.snapshotId })).resolves.toBeUndefined();
  });

  it.each([true, false])('activates checkable controls through browser input and verifies the result=%s', async (reached) => {
    const execute = mocks.page.webContents.executeJavaScriptInIsolatedWorld;
    await execute.withImplementation(async (_world, scripts) => {
      if (scripts[0]!.code.includes('"verify" ===')) return (reached ? { ok: true } : { ok: false, code: 'ELEMENT_NOT_INTERACTABLE' }) as never;
      return { ok: true, point: { x: 40, y: 50 }, needsClick: true } as never;
    }, async () => {
      const pending = runBrowserElementAction('browser-1', { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.element.set_checked', tabId: 'tab', snapshotId: 'snapshot', ref: 'target', checked: true });
      if (reached) await expect(pending).resolves.toBeUndefined();
      else await expect(pending).rejects.toMatchObject({ code: 'ELEMENT_NOT_INTERACTABLE' });
    });
    expect(mocks.page.webContents.debugger.sendCommand).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mousePressed', x: 40, y: 50 }));
    expect(mocks.page.webContents.debugger.sendCommand).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mouseReleased', x: 40, y: 50 }));
  });

  it.each(['nodes', 'time'])('bounds snapshot scanning by %s', async (budget) => {
    let visited = 0;
    await mocks.page.webContents.executeJavaScriptInIsolatedWorld.withImplementation(async (_world, scripts) => {
      return new Script(scripts[0]!.code).runInNewContext({
        performance: { now: () => budget === 'time' ? visited : 0 },
        document: { createTreeWalker: () => ({ nextNode: () => { visited++; return { matches: () => false, children: [null] }; } }) },
      });
    }, async () => {
      const result = await captureBrowserElements('browser-1');
      expect(result.scanTruncated).toBe(true);
      expect(result.elements).toEqual([]);
      expect(visited).toBe(budget === 'time' ? 100 : 10001);
    });
  });

  it.each([' ', '\t', '\n', '\r', '\f'])('redacts sensitive autocomplete tokens separated by %j in the injected snapshot', async (separator) => {
    class Input {
      tagName = 'INPUT';
      value = 'sensitive-value';
      constructor(readonly autocomplete: string) {}
      matches() { return true; }
      getAttribute(name: string) { return name === 'autocomplete' ? this.autocomplete : null; }
      getClientRects() { return [{}]; }
      getBoundingClientRect() { return { x: 0, y: 0, width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20 }; }
    }
    const inputs = ['one-time-code', 'cc-number', 'cc-csc', 'current-password', 'new-password', 'email']
      .map(token => new Input(`section-login${separator}${token}`));
    await mocks.page.webContents.executeJavaScriptInIsolatedWorld.withImplementation(async (_world, scripts) => {
      return new Script(scripts[0]!.code).runInNewContext({
        performance, document: { createTreeWalker: () => { const it = inputs.values(); return { nextNode: () => it.next().value ?? null }; } },
        HTMLInputElement: Input,
        getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
        innerHeight: 300,
        innerWidth: 400,
      });
    }, async () => {
      const result = await captureBrowserElements('browser-1');
      expect(result.elements).toHaveLength(6);
      for (const element of result.elements.slice(0, 5)) expect(element).not.toHaveProperty('value');
      expect(result.elements[5]?.value).toBe('sensitive-value');
    });
  });

  it('redacts sensitive autofill values from textareas and other non-input controls', async () => {
    class Input {
      tagName = 'INPUT';
      value = 'input-secret';
      constructor(readonly attributes: Record<string, string>) {}
      matches() { return true; }
      getAttribute(name: string) { return this.attributes[name] ?? null; }
      getClientRects() { return [{}]; }
      getBoundingClientRect() { return { x: 0, y: 0, width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20 }; }
    }
    class TextArea {
      tagName = 'TEXTAREA';
      value = 'textarea-secret';
      textContent = 'textarea-secret';
      constructor(readonly attributes: Record<string, string>) {}
      matches() { return true; }
      getAttribute(name: string) { return this.attributes[name] ?? null; }
      getClientRects() { return [{}]; }
      getBoundingClientRect() { return { x: 0, y: 0, width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20 }; }
    }
    const controls = [
      new TextArea({ autocomplete: 'one-time-code' }),
      new TextArea({ autocomplete: 'section-a current-password' }),
      new TextArea({}),
      new Input({ type: 'password' }),
      new TextArea({ type: 'password' }),
    ];
    await mocks.page.webContents.executeJavaScriptInIsolatedWorld.withImplementation(async (_world, scripts) => {
      return new Script(scripts[0]!.code).runInNewContext({
        performance, document: { createTreeWalker: () => { const it = controls.values(); return { nextNode: () => it.next().value ?? null }; } },
        HTMLInputElement: Input,
        getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
        innerHeight: 300,
        innerWidth: 400,
      });
    }, async () => {
      const result = await captureBrowserElements('browser-1');
      expect(result.elements.map((element) => element.value)).toEqual([undefined, undefined, 'textarea-secret', undefined, 'textarea-secret']);
      for (const index of [0, 1, 3]) expect(JSON.stringify(result.elements[index])).not.toContain('secret');
      expect(result.elements[2]).toMatchObject({ name: 'textarea-secret', text: 'textarea-secret' });
      const probed = await captureBrowserElements('browser-1', { scope: 'document', filter: { text: 'textarea-secret' } });
      expect(probed.elements).toHaveLength(2);
    });
  });

  it('sends a bounded wheel sequence with the requested total delta while allowing its own scrolling', async () => {
    const snapshot = await captureBrowserVisual('browser-1');
    const commands = mocks.page.webContents.debugger.sendCommand;
    await commands.withImplementation(async (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params?.['type'] === 'mouseWheel') mocks.page.position.scrollY += Number(params['deltaY']);
      return { data: 'cG5n' };
    }, async () => {
      await scrollBrowserVisual('browser-1', { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.visual.scroll', tabId: 'tab-1', snapshotId: snapshot.snapshotId, x: 100, y: 100, deltaX: 60, deltaY: 600 });
    });
    const wheels = commands.mock.calls.filter(([method, params]) => method === 'Input.dispatchMouseEvent' && params?.['type'] === 'mouseWheel');
    expect(wheels.length).toBeGreaterThan(1);
    expect(wheels.length).toBeLessThanOrEqual(12);
    expect(wheels.reduce((sum, [, params]) => sum + Number(params!['deltaY']), 0)).toBeCloseTo(600);
    expect(wheels.reduce((sum, [, params]) => sum + Number(params!['deltaX']), 0)).toBeCloseTo(60);
  });

  it('allows viewport changes during a wheel sequence', async () => {
    const snapshot = await captureBrowserVisual('browser-1');
    const commands = mocks.page.webContents.debugger.sendCommand;
    await commands.withImplementation(async (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params?.['type'] === 'mouseWheel') mocks.page.position.cssWidth += 1;
      return { data: 'cG5n' };
    }, async () => {
      await expect(scrollBrowserVisual('browser-1', { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.visual.scroll', tabId: 'tab-1', snapshotId: snapshot.snapshotId, x: 100, y: 100, deltaX: 0, deltaY: 600 })).resolves.toBeUndefined();
    });
    expect(commands.mock.calls.filter(([method, params]) => method === 'Input.dispatchMouseEvent' && params?.['type'] === 'mouseWheel')).toHaveLength(6);
  });

  it('stops a wheel sequence immediately when cancelled', async () => {
    const snapshot = await captureBrowserVisual('browser-1');
    const controller = new AbortController();
    const commands = mocks.page.webContents.debugger.sendCommand;
    await commands.withImplementation(async (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params?.['type'] === 'mouseWheel') controller.abort();
      return { data: 'cG5n' };
    }, async () => {
      await expect(scrollBrowserVisual('browser-1', { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.visual.scroll', tabId: 'tab-1', snapshotId: snapshot.snapshotId, x: 100, y: 100, deltaX: 0, deltaY: 600 }, controller.signal)).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
    });
    expect(commands.mock.calls.filter(([method, params]) => method === 'Input.dispatchMouseEvent' && params?.['type'] === 'mouseWheel')).toHaveLength(1);
  });

  it('discovers pointer-style controls without native button markup', async () => {
    const control = {
      tagName: 'DIV', children: [], matches: () => false,
      getAttribute: (name: string) => name === 'title' ? 'Zoom out' : null,
      getClientRects: () => [{}],
      getBoundingClientRect: () => ({ x: 20, y: 30, width: 30, height: 30, top: 30, left: 20, right: 50, bottom: 60 }),
    };
    await mocks.page.webContents.executeJavaScriptInIsolatedWorld.withImplementation(async (_world, scripts) => {
      return new Script(scripts[0]!.code).runInNewContext({ performance, document: { createTreeWalker: () => { let visited = false; return { nextNode: () => { if (visited) return null; visited = true; return control; } }; } }, getComputedStyle: () => ({ display: 'block', visibility: 'visible', cursor: 'pointer' }), innerHeight: 300, innerWidth: 400 });
    }, async () => {
      expect((await captureBrowserElements('browser-1')).elements).toMatchObject([{ ref: 'e1', name: 'Zoom out', bounds: { x: 20, y: 30, width: 30, height: 30 } }]);
    });
  });

  it('leaves fully transparent controls and their descendants out of element snapshots', async () => {
    const node = (title: string, opacity: string, parentElement: unknown = null) => ({
      tagName: 'BUTTON', children: [], opacity, parentElement, matches: () => true,
      getAttribute: (name: string) => name === 'title' ? title : null,
      getRootNode: () => ({}),
      getClientRects: () => [{}],
      getBoundingClientRect: () => ({ x: 0, y: 0, width: 30, height: 30, top: 0, left: 0, right: 30, bottom: 30 }),
    });
    const hiddenParent = node('Wrapper', '0');
    const controls = [node('Visible', '1'), node('Transparent', '0'), node('Inside transparent', '1', hiddenParent), node('Faint', '0.1')];
    await mocks.page.webContents.executeJavaScriptInIsolatedWorld.withImplementation(async (_world, scripts) => {
      return new Script(scripts[0]!.code).runInNewContext({
        performance, document: { createTreeWalker: () => { let index = 0; return { nextNode: () => controls[index++] ?? null }; } },
        getComputedStyle: (element: { opacity: string }) => ({ display: 'block', visibility: 'visible', opacity: element.opacity }), innerWidth: 400, innerHeight: 300,
      });
    }, async () => {
      expect((await captureBrowserElements('browser-1')).elements.map((element) => element.name)).toEqual(['Visible', 'Faint']);
    });
  });

  it('reports inherited disabled state in the injected element snapshot', async () => {
    class Input {
      tagName = 'INPUT';
      disabled = false;
      value = '';
      matches() { return true; }
      getAttribute() { return null; }
      getClientRects() { return [{}]; }
      getBoundingClientRect() { return { x: 0, y: 0, width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20 }; }
    }
    await mocks.page.webContents.executeJavaScriptInIsolatedWorld.withImplementation(async (_world, scripts) => {
      return new Script(scripts[0]!.code).runInNewContext({
        performance, document: { createTreeWalker: () => { let visited = false; return { nextNode: () => { if (visited) return null; visited = true; return new Input(); } }; } }, HTMLInputElement: Input,
        getComputedStyle: () => ({ display: 'block', visibility: 'visible' }), innerWidth: 400, innerHeight: 300,
      });
    }, async () => {
      expect((await captureBrowserElements('browser-1')).elements[0]?.disabled).toBe(true);
    });
  });

  it('redacts password and sensitive autofill values from element snapshots', () => {
    expect(shouldRedactBrowserElementValue('password', '')).toBe(true);
    expect(shouldRedactBrowserElementValue('text', 'username current-password')).toBe(true);
    expect(shouldRedactBrowserElementValue('text', 'new-password')).toBe(true);
    expect(shouldRedactBrowserElementValue('text', 'one-time-code')).toBe(true);
    expect(shouldRedactBrowserElementValue('text', 'cc-number')).toBe(true);
    expect(shouldRedactBrowserElementValue('text', 'email')).toBe(false);
  });

  it('rechecks the element after an asynchronous control validation changes it', async () => {
    let checks = 0;
    await expect(runBrowserElementAction('browser-1', {
      protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.element.click', tabId: 'tab-1', snapshotId: 'snapshot', ref: 'target',
    }, undefined, async () => {
      if (++checks === 3) mocks.page.elementResult = { ok: false, code: 'STALE_ELEMENT' } as never;
    })).rejects.toMatchObject({ code: 'STALE_ELEMENT' });
    expect(mocks.page.webContents.debugger.sendCommand).not.toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mousePressed' }));
  });

  it.each(['page.element.select_option', 'page.element.scroll_into_view'] as const)('checks control right before and after the in-page change for %s', async (operation) => {
    const events: string[] = [];
    let revoked = false;
    const execute = mocks.page.webContents.executeJavaScriptInIsolatedWorld;
    const original = execute.getMockImplementation()!;
    execute.mockImplementation(async (world, scripts) => {
      if (scripts[0]?.code.includes('request.operation')) {
        events.push('page-change');
        revoked = true;
      }
      return original(world, scripts);
    });
    const request = operation === 'page.element.select_option'
      ? { protocol: BROWSER_AUTOMATION_PROTOCOL, operation, tabId: 'tab-1', snapshotId: 'snapshot', ref: 'target', value: 'a' }
      : { protocol: BROWSER_AUTOMATION_PROTOCOL, operation, tabId: 'tab-1', snapshotId: 'snapshot', ref: 'target' };
    try {
      await expect(runBrowserElementAction('browser-1', request as never, undefined, async () => {
        events.push('check');
        if (revoked) throw Object.assign(new Error('taken over'), { code: 'BROWSER_USER_TAKEOVER' });
      })).rejects.toMatchObject({ code: 'BROWSER_USER_TAKEOVER' });
    } finally {
      execute.mockImplementation(original);
    }
    expect(events.slice(-3)).toEqual(['check', 'page-change', 'check']);
    expect(execute.mock.calls.some(([, scripts]) => scripts[0]?.code.includes('"change" === '))).toBe(false);
  });

  it('dispatches the select change event in its own step after control is confirmed', async () => {
    const execute = mocks.page.webContents.executeJavaScriptInIsolatedWorld;
    const phases: string[] = [];
    const original = execute.getMockImplementation()!;
    execute.mockImplementation(async (world, scripts) => {
      const phase = /"(prepare|change)" === /.exec(scripts[0]?.code ?? '')?.[1];
      if (phase !== undefined && scripts[0]!.code.includes('request.operation')) phases.push(phase);
      return original(world, scripts);
    });
    try {
      await runBrowserElementAction('browser-1', { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.element.select_option', tabId: 'tab-1', snapshotId: 'snapshot', ref: 'target', value: 'a' }, undefined, async () => { phases.push('check'); });
    } finally {
      execute.mockImplementation(original);
    }
    expect(phases.slice(-4)).toEqual(['prepare', 'check', 'change', 'check']);
  });

  it.each([['prepare', 1], ['change', 2]] as const)('reports a select whose %s script outlives the timeout as undetermined and dispatches nothing after it', async (stuck, at) => {
    vi.useFakeTimers();
    const execute = mocks.page.webContents.executeJavaScriptInIsolatedWorld;
    const original = execute.getMockImplementation()!;
    const phases: string[] = [];
    execute.mockImplementation(async (world, scripts) => {
      const phase = /"(prepare|change)" === /.exec(scripts[0]?.code ?? '')?.[1];
      if (phase !== undefined && scripts[0]!.code.includes('request.operation')) {
        phases.push(phase);
        if (phases.length === at) return new Promise(() => {});
      }
      return original(world, scripts);
    });
    try {
      const outcome = expect(runBrowserElementAction('browser-1', { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.element.select_option', tabId: 'tab-1', snapshotId: 'snapshot', ref: 'target', value: 'a' })).rejects.toMatchObject({ code: 'ACTION_UNDETERMINED', message: expect.stringContaining('before retrying') });
      await vi.advanceTimersByTimeAsync(BROWSER_PAGE_SCRIPT_TIMEOUT_MS);
      await outcome;
      await vi.advanceTimersByTimeAsync(BROWSER_PAGE_SCRIPT_TIMEOUT_MS);
    } finally {
      execute.mockImplementation(original);
      vi.useRealTimers();
    }
    expect(phases.at(-1)).toBe(stuck);
    expect(phases.filter(phase => phase === 'change')).toHaveLength(stuck === 'change' ? 1 : 0);
  });

  it('keeps a click whose script times out before any input as page-not-ready', async () => {
    vi.useFakeTimers();
    const execute = mocks.page.webContents.executeJavaScriptInIsolatedWorld;
    const original = execute.getMockImplementation()!;
    execute.mockImplementation(async (world, scripts) => scripts[0]?.code.includes('request.operation') ? new Promise(() => {}) : original(world, scripts));
    try {
      const outcome = expect(runBrowserElementAction('browser-1', { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.element.click', tabId: 'tab-1', snapshotId: 'snapshot', ref: 'target' })).rejects.toMatchObject({ code: 'PAGE_NOT_READY' });
      await vi.advanceTimersByTimeAsync(BROWSER_PAGE_SCRIPT_TIMEOUT_MS);
      await outcome;
    } finally {
      execute.mockImplementation(original);
      vi.useRealTimers();
    }
  });

  it('surfaces isolated-world stale element errors', async () => {
    mocks.page.elementResult = {
      ok: false,
      code: 'STALE_ELEMENT',
      message: 'The element is gone.',
    } as never;
    await expect(runBrowserElementAction('browser-1', {
      protocol: BROWSER_AUTOMATION_PROTOCOL,
      operation: 'page.element.click',
      tabId: 'tab-1',
      snapshotId: 'elements-old',
      ref: 'e1',
    })).rejects.toMatchObject({ code: 'STALE_ELEMENT' });
  });

  it('reuses a snapshot for repeated scrolling after a panel resize without stretching its coordinates', async () => {
    const snapshot = await captureBrowserVisual('browser-1');
    mocks.page.bounds = { ...mocks.page.bounds, width: 1320, height: 1048 };
    mocks.page.position = { ...mocks.page.position, cssWidth: 1320, cssHeight: 1048, scrollY: 200 };
    const request = { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.visual.scroll' as const, tabId: 'tab', snapshotId: snapshot.snapshotId, x: 200, y: 100, deltaX: 0, deltaY: 100 };
    await scrollBrowserVisual('browser-1', request);
    await scrollBrowserVisual('browser-1', request);
    const wheels = mocks.page.webContents.debugger.sendCommand.mock.calls.filter(([method, params]) => method === 'Input.dispatchMouseEvent' && params?.['type'] === 'mouseWheel');
    expect(wheels.slice(-2).map(([, params]) => ({ x: params!['x'], y: params!['y'] }))).toEqual([{ x: 100, y: 50 }, { x: 100, y: 50 }]);
  });

  it('applies the live device display scale after the final asynchronous control check', async () => {
    mocks.page.bounds = { x: 0, y: 0, width: 400, height: 300 };
    mocks.page.position = { scrollX: 0, scrollY: 0, cssWidth: 400, cssHeight: 300, deviceScaleFactor: 2 };
    mocks.page.inputScale = 1;
    const snapshot = await captureBrowserVisual('browser-1');
    let checks = 0;
    await clickBrowserVisual('browser-1', { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.visual.click', tabId: 'tab', snapshotId: snapshot.snapshotId, x: 200, y: 100 }, undefined, async () => {
      if (++checks === 3) { mocks.page.inputScale = 0.5; mocks.page.bounds = { ...mocks.page.bounds, width: 200 }; }
    });
    expect(mocks.page.webContents.debugger.sendCommand).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mousePressed', x: 50, y: 25 }));
  });

  it('still blocks navigation during the final control check before pressing', async () => {
    const snapshot = await captureBrowserVisual('browser-1');
    mocks.page.webContents.debugger.sendCommand.mockClear();
    let checks = 0;
    await expect(clickBrowserVisual('browser-1', { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.visual.click', tabId: 'tab', snapshotId: snapshot.snapshotId, x: 20, y: 20 }, undefined, async () => {
      if (++checks === 3) mocks.page.generation++;
    })).rejects.toMatchObject({ code: 'PAGE_NOT_READY' });
    expect(mocks.page.webContents.debugger.sendCommand).not.toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mousePressed' }));
  });

  it('bounds retained snapshot metadata while keeping recent references usable', async () => {
    const old = await captureBrowserVisual('browser-1');
    let latest = old;
    for (let i = 0; i < 8; i++) latest = await captureBrowserVisual('browser-1');
    const request = { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.visual.hover' as const, tabId: 'tab', x: 10, y: 10 };
    await expect(hoverBrowserVisual('browser-1', { ...request, snapshotId: old.snapshotId })).rejects.toMatchObject({ code: 'STALE_SNAPSHOT' });
    await expect(hoverBrowserVisual('browser-1', { ...request, snapshotId: latest.snapshotId })).resolves.toBeUndefined();
  });
});

describe('visual probe element references', () => {
  type FakeNode = ReturnType<typeof fakeNode>;

  function fakeNode(tagName: string, interactive: boolean, x: number, y: number) {
    const bounds = { x, y, left: x, top: y, right: x + 40, bottom: y + 20, width: 40, height: 20 };
    return {
      tagName, id: '', classList: [] as string[], children: [] as unknown[], textContent: tagName,
      isConnected: true, parentElement: null, shadowRoot: null,
      scrollIntoView: () => {},
      matches: (selector: string) => interactive && selector.startsWith('button,a[href]'),
      hasAttribute: () => false,
      getAttribute: () => null,
      getBoundingClientRect: () => bounds,
      getRootNode: () => ({}),
    };
  }

  function probeContext() {
    const button = fakeNode('BUTTON', true, 60, 40);
    const plain = fakeNode('DIV', false, 40, 40);
    const earlier = fakeNode('INPUT', true, 0, 0);
    const at = (node: FakeNode, x: number, y: number): boolean => {
      const bounds = node.getBoundingClientRect();
      return x >= bounds.left && x < bounds.right && y >= bounds.top && y < bounds.bottom;
    };
    const globals = {
      innerWidth: 800, innerHeight: 600,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', cursor: 'auto' }),
      document: {
        querySelectorAll: () => [plain, button],
        elementFromPoint: (x: number, y: number) => at(button, x, y) ? button : at(plain, x, y) ? plain : null,
      },
      __kimiBrowserElementState: { snapshotId: 'elements-earlier', elements: new Map([['e1', earlier]]) } as unknown,
    };
    return { button, context: createContext(globals), globals };
  }

  function probe(context: ReturnType<typeof createContext>, point: { x: number; y: number }, guardRef?: string): unknown {
    return new Script(visualTargetProbeCode('elements-probe', point, 48, { x: 1, y: 1 }, guardRef)).runInContext(context);
  }

  function resolves(context: ReturnType<typeof createContext>, snapshotId: string, ref: string) {
    const request = { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.element.scroll_into_view' as const, tabId: 'tab-1', snapshotId, ref };
    return new Script(elementCommandCode(request)).runInContext(context) as { ok: boolean; code?: string };
  }

  it('keeps earlier element refs usable when no target is found', () => {
    const { context, globals } = probeContext();
    const result = probe(context, { x: 50, y: 50 }) as { outcome: string; target?: unknown; nearby: Array<{ ref?: string }> };
    expect(result.outcome).toBe('no_target');
    expect(result.target).toBeUndefined();
    expect(result.nearby.map(candidate => candidate.ref)).toEqual(['e1']);
    expect((globals.__kimiBrowserElementState as { snapshotId: string }).snapshotId).toBe('elements-earlier');
    expect(resolves(context, 'elements-earlier', 'e1')).toEqual({ ok: true });
    expect(resolves(context, 'elements-probe', 'e1')).toEqual({ ok: true });
  });

  it.each([true, false])('replaces earlier element refs only when the target passes its final hit test (%s)', reachable => {
    const { button, context, globals } = probeContext();
    expect(probe(context, { x: 70, y: 50 })).toMatchObject({ target: { ref: 'e1' } });
    button.isConnected = reachable;
    expect(probe(context, { x: 70, y: 50 }, 'e1')).toBe(reachable);
    expect((globals.__kimiBrowserElementState as { snapshotId: string }).snapshotId).toBe(reachable ? 'elements-probe' : 'elements-earlier');
    expect(resolves(context, 'elements-earlier', 'e1')).toMatchObject(reachable ? { ok: false, code: 'STALE_ELEMENT' } : { ok: true });
    expect(resolves(context, 'elements-probe', 'e1')).toMatchObject({ ok: reachable });
  });
});

describe('element action preconditions', () => {
  function context(mode: string) {
    const previous = { id: 'previous' };
    const document = { activeElement: previous as unknown, elementFromPoint: (_x: number, _y: number): unknown => target };
    class Input {
      type = ['date', 'range', 'color', 'file'].includes(mode) ? mode : 'text';
      isConnected = true;
      readOnly = mode === 'readonly';
      select = vi.fn();
      scrollIntoView() {}
      getBoundingClientRect() { return { left: 10, right: mode === 'hidden' ? 10 : 110, top: 10, bottom: mode === 'hidden' ? 10 : 40 }; }
      focus() { if (mode !== 'unfocusable') document.activeElement = this; }
    }
    const target = new Input();
    if (mode === 'covered') document.elementFromPoint = () => ({ parentElement: null, getRootNode: () => document });
    if (mode === 'shadow') {
      const host = { shadowRoot: { activeElement: target, elementFromPoint: () => target } };
      document.elementFromPoint = () => host;
      target.focus = () => { document.activeElement = host; };
    }
    return { target, previous, document, innerWidth: 800, innerHeight: 600, HTMLInputElement: Input, HTMLTextAreaElement: class {}, __kimiBrowserElementState: { snapshotId: 'snapshot', elements: new Map([['target', target]]) } };
  }

  it.each([
    ['hidden', 'fill'], ['hidden', 'type_text'], ['hidden', 'press_key'],
    ['unfocusable', 'fill'], ['unfocusable', 'press_key'], ['readonly', 'type_text'],
    ['covered', 'click'], ['covered', 'hover'],
  ] as const)('refuses %s targets for %s without selecting the previous field', (mode, operation) => {
    const world = context(mode);
    const result = new Script(elementCommandCode({ protocol: BROWSER_AUTOMATION_PROTOCOL, operation: `page.element.${operation}`, tabId: 'tab', snapshotId: 'snapshot', ref: 'target', text: 'replacement', keys: ['Enter'] } as Parameters<typeof elementCommandCode>[0])).runInNewContext(world);
    expect(result).toMatchObject({ ok: false, code: 'ELEMENT_NOT_INTERACTABLE' });
    expect(world.document.activeElement).toBe(world.previous);
    expect(world.target.select).not.toHaveBeenCalled();
  });

  it.each(['date', 'range', 'color', 'file'])('rejects text insertion into native %s controls', (type) => {
    const world = context(type);
    const result = new Script(elementCommandCode({ protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.element.fill', tabId: 'tab', snapshotId: 'snapshot', ref: 'target', text: 'replacement' })).runInNewContext(world);
    expect(result).toMatchObject({ ok: false, code: 'UNSUPPORTED_ELEMENT' });
    expect(world.document.activeElement).toBe(world.previous);
  });

  it('does not restore stolen focus while validating pending keyboard input', () => {
    const world = context('text');
    const result = new Script(elementCommandCode({ protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.element.fill', tabId: 'tab', snapshotId: 'snapshot', ref: 'target', text: 'replacement' }, 'guard', 'keyboard')).runInNewContext(world);
    expect(result).toMatchObject({ ok: false, code: 'ELEMENT_NOT_INTERACTABLE' });
    expect(world.document.activeElement).toBe(world.previous);
  });

  it('recognizes keyboard focus and pointer hits inside an open shadow root', () => {
    const world = context('shadow');
    const result = new Script(elementCommandCode({ protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.element.fill', tabId: 'tab', snapshotId: 'snapshot', ref: 'target', text: 'replacement' })).runInNewContext(world);
    expect(result).toEqual({ ok: true });
    expect(world.target.select).not.toHaveBeenCalled();
  });
});

it.each(['index', 'label', 'disabled', 'group-disabled', 'fieldset-disabled', 'legend-enabled'])('selects options by identity and respects availability: %s', (mode) => {
  const options = [
    { index: 0, value: 'same', label: 'First', disabled: false, closest: () => null },
    { index: 1, value: 'same', label: 'Second', disabled: mode === 'disabled', closest: () => mode === 'group-disabled' ? { disabled: true } : null },
  ];
  class Select {
    isConnected = true;
    disabled = false;
    matches(selector: string) { return selector === ':disabled' && mode === 'fieldset-disabled'; }
    options = Object.assign(options, { item: (index: number) => options[index] });
    selectedIndex = 0;
    scrollIntoView() {}
    getBoundingClientRect() { return { left: 10, right: 100, top: 10, bottom: 40 }; }
    events: string[] = [];
    dispatchEvent(event: Event) { this.events.push(event.type); }
  }
  const target = new Select();
  const request = { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.element.select_option' as const, tabId: 'tab', snapshotId: 'snapshot', ref: 'target', ...(mode === 'label' ? { label: 'Second' } : { index: 1 }) };
  const result = new Script(elementCommandCode(request)).runInNewContext({ document: { elementFromPoint: () => target }, innerWidth: 800, innerHeight: 600, HTMLSelectElement: Select, Event, __kimiBrowserElementState: { snapshotId: 'snapshot', elements: new Map([['target', target]]) } });
  expect(result.ok).toBe(mode === 'index' || mode === 'label' || mode === 'legend-enabled');
  expect(target.selectedIndex).toBe(mode === 'index' || mode === 'label' || mode === 'legend-enabled' ? 1 : 0);
  expect(target.events).toEqual(result.ok ? ['input'] : []);

});

it.each([['value', { value: 'b' }], ['label', { label: 'Second' }], ['index', { index: 1 }]] as const)('fails the select by %s when the change listener resets the option', (_mode, pick) => {
  const options = [{ index: 0, value: 'a', label: 'First', text: 'First' }, { index: 1, value: 'b', label: 'Second', text: 'Second' }];
  const target = { isConnected: true, options, selectedIndex: 1, resets: false, dispatchEvent(event: Event) { if (event.type === 'change' && this.resets) this.selectedIndex = 0; } };
  const request = { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.element.select_option' as const, tabId: 'tab', snapshotId: 'snapshot', ref: 'target', ...pick };
  const run = () => new Script(elementCommandCode(request, 'change')).runInNewContext({ Event, __kimiBrowserElementState: { snapshotId: 'snapshot', elements: new Map([['target', target]]) } });
  expect(run()).toEqual({ ok: true });
  target.resets = true;
  expect(run()).toMatchObject({ ok: false, code: 'ELEMENT_NOT_INTERACTABLE' });
});

it('leaves a select untouched when its prepare or change script only starts after the timeout deadline', () => {
  const options = [{ index: 0, value: 'a', label: 'First', text: 'First', disabled: false, closest: () => null }, { index: 1, value: 'b', label: 'Second', text: 'Second', disabled: false, closest: () => null }];
  class Select {
    isConnected = true;
    disabled = false;
    matches() { return false; }
    options = Object.assign(options, { item: (index: number) => options[index] });
    selectedIndex = 0;
    scrollIntoView() {}
    getBoundingClientRect() { return { left: 10, right: 100, top: 10, bottom: 40 }; }
    events: string[] = [];
    dispatchEvent(event: Event) { this.events.push(event.type); }
  }
  const target = new Select();
  const request = { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.element.select_option' as const, tabId: 'tab', snapshotId: 'snapshot', ref: 'target', value: 'b' };
  const world = { document: { elementFromPoint: () => target }, innerWidth: 800, innerHeight: 600, HTMLSelectElement: Select, Event, __kimiBrowserElementState: { snapshotId: 'snapshot', elements: new Map([['target', target]]) } };
  const past = Date.now() - 1;
  expect(new Script(elementCommandCode(request, 'prepare', undefined, past)).runInNewContext(world)).toMatchObject({ ok: false, code: 'ACTION_UNDETERMINED' });
  expect(new Script(elementCommandCode(request, 'change', undefined, past)).runInNewContext(world)).toMatchObject({ ok: false, code: 'ACTION_UNDETERMINED' });
  expect(target.selectedIndex).toBe(0);
  expect(target.events).toEqual([]);
  expect(new Script(elementCommandCode(request, 'prepare', undefined, Date.now() + 60_000)).runInNewContext(world)).toEqual({ ok: true });
  expect(target.selectedIndex).toBe(1);
  expect(target.events).toEqual(['input']);
});

describe('element presentation for activity feedback', () => {
  function world(element: Record<string, unknown>, viewport?: { offsetLeft: number; offsetTop: number; scale: number }) {
    const target = { isConnected: true, tagName: 'BUTTON', getAttribute: () => null, getBoundingClientRect: () => ({ x: 30, y: 50, width: 120, height: 40 }), ...element };
    return { visualViewport: viewport, __kimiBrowserElementState: { snapshotId: 'snapshot', elements: new Map([['e1', target]]) } };
  }
  const run = (context: object, ref = 'e1', snapshotId = 'snapshot') => new Script(elementPresentationCode({ snapshotId, ref })).runInNewContext(context) as { label: string; rect: unknown } | null;

  it('names a control by its visible text and reports its box in visual viewport pixels', () => {
    expect(run(world({ innerText: '  Send\n  now ' }, { offsetLeft: 10, offsetTop: 20, scale: 2 }))).toEqual({
      label: 'Send now', rect: { x: 40, y: 60, width: 240, height: 80 },
    });
    expect(run(world({ tagName: 'INPUT', type: 'submit', value: 'Search' }))?.label).toBe('Search');
    expect(run(world({ innerText: 'x'.repeat(200) }))?.label).toHaveLength(80);
  });

  it('never exposes what a field contains', () => {
    const attributes = (values: Record<string, string>) => (name: string) => values[name] ?? null;
    expect(run(world({ tagName: 'INPUT', type: 'password', value: 'hunter2', innerText: 'hunter2', getAttribute: attributes({ placeholder: 'Password' }) }))?.label).toBe('Password');
    expect(run(world({ tagName: 'TEXTAREA', value: 'private draft', innerText: 'private draft' }))?.label).toBe('');
    expect(run(world({ tagName: 'DIV', isContentEditable: true, innerText: 'private draft', labels: [{ innerText: 'Message' }] }))?.label).toBe('Message');
    expect(run(world({ tagName: 'INPUT', type: 'text', value: 'secret', getAttribute: attributes({ 'aria-label': 'Search notes' }) }))?.label).toBe('Search notes');
  });

  it('treats scripted editors and their wrappers as fields too', () => {
    const attributes = (values: Record<string, string>) => (name: string) => values[name] ?? null;
    for (const role of ['textbox', 'searchbox', 'combobox', 'spinbutton']) {
      expect(run(world({ tagName: 'DIV', innerText: 'private draft', getAttribute: attributes({ role }) }))?.label, role).toBe('');
    }
    expect(run(world({ tagName: 'DIV', innerText: 'private draft', getAttribute: attributes({ role: 'TextBox', 'aria-label': 'Message' }) }))?.label).toBe('Message');
    expect(run(world({ tagName: 'DIV', innerText: 'Reply private draft', querySelector: () => ({}) }))?.label).toBe('');
    expect(run(world({ tagName: 'DIV', innerText: 'Open note', querySelector: () => null }))?.label).toBe('Open note');
  });

  it('returns nothing for stale, detached or empty targets', () => {
    expect(run(world({}), 'e9')).toBeNull();
    expect(run(world({}), 'e1', 'older-snapshot')).toBeNull();
    expect(run(world({ isConnected: false }))).toBeNull();
    expect(run(world({ getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 10 }) }))).toBeNull();
  });
});

describe('before-action receipts', () => {
  const requestOf = (code: string) => JSON.parse(/const request = (.*);\n/.exec(code)![1]!) as Record<string, unknown>;
  const inputs = async (work: () => Promise<unknown>) => {
    await mocks.page.webContents.debugger.sendCommand.withImplementation(async (method: string) => {
      if (method.startsWith('Input.')) receipts.events.push(method);
      return { data: 'cG5n' };
    }, work);
    return receipts.events;
  };

  beforeEach(() => {
    mocks.page.inputScale = 1;
    mocks.page.generation = 1;
    mocks.page.elementResult = { ok: true, point: { x: 40, y: 50 } };
    receipts.wanted = true;
    receipts.codes.length = 0;
    receipts.events.length = 0;
    receipts.during = undefined;
    rendering.held = 0;
    rendering.holds = 0;
  });
  afterEach(() => {
    receipts.wanted = false;
    receipts.during = undefined;
    mocks.page.generation = 1;
  });

  it('captures once, right before the first input of an element click, at the pointer and on the element', async () => {
    expect(await inputs(() => runBrowserElementAction('browser-1', { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.element.click', tabId: 'tab', snapshotId: 'snapshot', ref: 'e1' })))
      .toEqual(['capture', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent']);
    expect(requestOf(receipts.codes[0]!)).toMatchObject({ mode: 'pointer', point: { x: 40, y: 50 }, target: { snapshotId: 'snapshot', ref: 'e1' } });
  });

  it('anchors typing on the target element instead of a pointer', async () => {
    mocks.page.elementResult = { ok: true } as never;
    expect((await inputs(() => runBrowserElementAction('browser-1', { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.element.fill', tabId: 'tab', snapshotId: 'snapshot', ref: 'e2', text: 'hello' })))[0]).toBe('capture');
    const request = requestOf(receipts.codes[0]!);
    expect(request).toMatchObject({ mode: 'keyboard', target: { snapshotId: 'snapshot', ref: 'e2' } });
    expect(request['point']).toBeUndefined();
  });

  it('anchors visual typing on the focused element', async () => {
    await inputs(() => typeBrowserVisual('browser-1', { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.visual.type_text', tabId: 'tab', text: 'hello' }));
    const request = requestOf(receipts.codes[0]!);
    expect(request).toMatchObject({ mode: 'keyboard' });
    expect(request['target']).toBeUndefined();
  });

  it('reports coordinate actions in CSS pixels on a scaled page', async () => {
    const snapshot = await captureBrowserVisual('browser-1');
    mocks.page.inputScale = 2;
    await inputs(() => clickBrowserVisual('browser-1', { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.visual.click', tabId: 'tab', snapshotId: snapshot.snapshotId, x: 400, y: 300 }));
    expect(receipts.events.slice(0, 2)).toEqual(['capture', 'Input.dispatchMouseEvent']);
    expect(requestOf(receipts.codes[0]!)).toMatchObject({ mode: 'pointer', point: { x: 200, y: 150 } });
  });

  it('keeps a hidden page producing frames only while its receipt is captured', async () => {
    const held: number[] = [];
    receipts.during = () => { held.push(rendering.held); };
    rendering.holds = 0;
    expect(await inputs(() => runBrowserElementAction('browser-1', { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.element.click', tabId: 'tab', snapshotId: 'snapshot', ref: 'e1' })))
      .toEqual(['capture', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent']);
    receipts.wanted = true;
    await inputs(() => runBrowserElementAction('browser-1', { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.element.select_option', tabId: 'tab', snapshotId: 'snapshot', ref: 'e3', value: 'tokyo' }));
    expect(held).toEqual([1, 1]);
    expect(rendering.holds).toBe(2);
    expect(rendering.held).toBe(0);
    receipts.wanted = false;
    await inputs(() => runBrowserElementAction('browser-1', { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.element.click', tabId: 'tab', snapshotId: 'snapshot', ref: 'e1' }));
    expect(rendering.holds).toBe(2);
  });

  it('captures a selection once it is applied, since it sends no input', async () => {
    mocks.page.elementResult = { ok: true } as never;
    expect(await inputs(() => runBrowserElementAction('browser-1', { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.element.select_option', tabId: 'tab', snapshotId: 'snapshot', ref: 'e3', value: 'tokyo' })))
      .toEqual(['capture']);
    expect(requestOf(receipts.codes[0]!)).toMatchObject({ mode: 'target', target: { snapshotId: 'snapshot', ref: 'e3' } });
  });

  it('checks the target again after the capture and presses nothing once it is covered', async () => {
    receipts.during = () => { mocks.page.elementResult = { ok: false, code: 'ELEMENT_NOT_INTERACTABLE', message: 'The pointer no longer reaches the original element.' } as never; };
    const sendCommand = mocks.page.webContents.debugger.sendCommand;
    sendCommand.mockClear();
    const click = runBrowserElementAction('browser-1', { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.element.click', tabId: 'tab', snapshotId: 'snapshot', ref: 'e1' });
    await expect(inputs(() => click)).rejects.toMatchObject({ code: 'ELEMENT_NOT_INTERACTABLE' });
    expect(sendCommand.mock.calls.filter(([method]) => method.startsWith('Input.')).map(([, params]) => params?.['type'])).toEqual(['mouseReleased']);
  });

  it('checks the page again after the capture and types nothing into a new document', async () => {
    receipts.during = () => { mocks.page.generation = 2; };
    const typing = typeBrowserVisual('browser-1', { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.visual.type_text', tabId: 'tab', text: 'hello' });
    await expect(inputs(() => typing)).rejects.toMatchObject({ code: 'PAGE_NOT_READY' });
    expect(receipts.events).toEqual(['capture']);
  });

  it('runs the operation checks again after the capture', async () => {
    let controlled = true;
    receipts.during = () => { controlled = false; };
    const validate = vi.fn(async () => { if (!controlled) throw new Error('Browser control changed.'); });
    const typing = runBrowserElementAction('browser-1', { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.element.type_text', tabId: 'tab', snapshotId: 'snapshot', ref: 'e2', text: 'hello' }, undefined, validate);
    await expect(inputs(() => typing)).rejects.toThrow('Browser control changed.');
    expect(receipts.events).toEqual(['capture']);
  });

  it('does not measure anything when no receipt is wanted', async () => {
    receipts.wanted = false;
    await inputs(() => runBrowserElementAction('browser-1', { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.element.click', tabId: 'tab', snapshotId: 'snapshot', ref: 'e1' }));
    mocks.page.elementResult = { ok: true } as never;
    await inputs(() => runBrowserElementAction('browser-1', { protocol: BROWSER_AUTOMATION_PROTOCOL, operation: 'page.element.select_option', tabId: 'tab', snapshotId: 'snapshot', ref: 'e3', value: 'tokyo' }));
    expect(receipts.codes).toEqual([]);
  });
});

describe('receipt frame measurement', () => {
  type Box = { left: number; top: number; width: number; height: number };
  function node(tagName: string, box: Box, attributes: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
    return {
      tagName, isConnected: true, value: '', shadowRoot: null as unknown, style: {} as Record<string, string>,
      clientLeft: 0, clientTop: 0, clientWidth: box.width, clientHeight: box.height, offsetWidth: box.width, offsetHeight: box.height,
      getAttribute: (name: string) => attributes[name] ?? null,
      hasAttribute: (name: string) => Object.hasOwn(attributes, name),
      matches: (selector: string) => selector.split(',').map(item => item.trim().toUpperCase()).includes(tagName),
      getBoundingClientRect: () => ({ x: box.left, y: box.top, left: box.left, top: box.top, width: box.width, height: box.height, right: box.left + box.width, bottom: box.top + box.height }),
      ...extra,
    };
  }
  function page(nodes: ReturnType<typeof node>[] = [], options: { focus?: unknown; target?: unknown; width?: number; height?: number; visual?: { width: number; height: number; offsetLeft: number; offsetTop: number; scale: number } } = {}) {
    const body = node('BODY', { left: 0, top: 0, width: 1000, height: 800 });
    const document = { body, documentElement: body, activeElement: options.focus ?? body, querySelectorAll: () => nodes };
    return {
      document, innerWidth: options.width ?? 1000, innerHeight: options.height ?? 800,
      ...(options.visual ? { visualViewport: options.visual } : {}),
      getComputedStyle: (element: { style: Record<string, string> }) => ({ visibility: 'visible', paddingLeft: '0px', paddingTop: '0px', paddingRight: '0px', paddingBottom: '0px', ...element.style }),
      __kimiBrowserElementState: { snapshotId: 'snapshot', elements: new Map(options.target ? [['e1', options.target]] : []) },
    };
  }
  const measure = (context: object, request: Parameters<typeof receiptFrameCode>[0]) => JSON.parse(JSON.stringify(new Script(receiptFrameCode(request)).runInNewContext(context) ?? null));
  const target = { snapshotId: 'snapshot', ref: 'e1' };

  it('centres the crop on the pointer and keeps the element box', () => {
    const button = node('BUTTON', { left: 360, top: 330, width: 80, height: 30 });
    expect(measure(page([], { target: button }), { mode: 'pointer', point: { x: 400, y: 345 }, target })).toEqual({
      viewport: { width: 1000, height: 800 },
      crop: { x: 160, y: 195, width: 480, height: 300 },
      point: { x: 400, y: 345 },
      box: { x: 360, y: 330, width: 80, height: 30 },
    });
  });

  it('measures the crop in scaled visual viewport pixels on a zoomed page', () => {
    const visual = { width: 500, height: 400, offsetLeft: 100, offsetTop: 80, scale: 2 };
    const button = node('BUTTON', { left: 360, top: 330, width: 80, height: 30 });
    expect(measure(page([], { target: button, visual }), { mode: 'pointer', point: { x: 400, y: 345 }, target })).toEqual({
      viewport: { width: 1000, height: 800 },
      crop: { x: 360, y: 380, width: 480, height: 300 },
      point: { x: 600, y: 530 },
      box: { x: 520, y: 500, width: 160, height: 60 },
    });
  });

  it('scans for sensitive content in layout coordinates on a zoomed page', () => {
    const visual = { width: 500, height: 400, offsetLeft: 100, offsetTop: 80, scale: 2 };
    const point = { x: 300, y: 265 };
    const inside = node('INPUT', { left: 300, top: 300, width: 200, height: 30 }, { autocomplete: 'cc-number' }, { value: '4242 4242 4242 4242' });
    const outside = node('INPUT', { left: 700, top: 600, width: 200, height: 30 }, { autocomplete: 'cc-number' }, { value: '4242 4242 4242 4242' });
    expect(measure(page([inside], { visual }), { mode: 'pointer', point })).toBeNull();
    expect(measure(page([outside], { visual }), { mode: 'pointer', point })).toMatchObject({
      viewport: { width: 1000, height: 800 },
      crop: { x: 360, y: 380, width: 480, height: 300 },
      point: { x: 600, y: 530 },
    });
  });

  it('keeps the crop inside the viewport', () => {
    expect(measure(page(), { mode: 'pointer', point: { x: 20, y: 10 } })).toMatchObject({ crop: { x: 0, y: 0, width: 480, height: 300 }, box: null });
    expect(measure(page([], { width: 320, height: 200 }), { mode: 'pointer', point: { x: 310, y: 190 } })).toMatchObject({ crop: { x: 0, y: 0, width: 320, height: 200 } });
    expect(measure(page(), { mode: 'pointer', point: { x: 990, y: 790 } })).toMatchObject({ crop: { x: 520, y: 500 } });
  });

  it('centres typing on the focused element, following open shadow roots', () => {
    const field = node('INPUT', { left: 600, top: 400, width: 200, height: 40 });
    const host = node('DIV', { left: 0, top: 0, width: 10, height: 10 }, {}, { shadowRoot: { activeElement: field } });
    expect(measure(page([], { focus: host }), { mode: 'keyboard' })).toEqual({
      viewport: { width: 1000, height: 800 },
      crop: { x: 460, y: 270, width: 480, height: 300 },
      box: { x: 600, y: 400, width: 200, height: 40 },
    });
    expect(measure(page(), { mode: 'keyboard' })).toBeNull();
  });

  it('uses the element for a selection and gives up when it is gone', () => {
    const select = node('SELECT', { left: 100, top: 100, width: 160, height: 32 });
    expect(measure(page([], { target: select }), { mode: 'target', target })).toMatchObject({ crop: { x: 0, y: 0 }, box: { x: 100, y: 100 } });
    expect(measure(page([], { target: { ...select, isConnected: false } }), { mode: 'target', target })).toBeNull();
    expect(measure(page(), { mode: 'target', target })).toBeNull();
    expect(measure(page(), { mode: 'pointer', point: { x: 400, y: 345 }, target })).toMatchObject({ box: null });
  });

  it('never captures a sensitive field or a filled one that would be in view', () => {
    const password = node('INPUT', { left: 300, top: 300, width: 200, height: 30 }, { type: 'password' });
    const card = node('INPUT', { left: 300, top: 400, width: 200, height: 30 }, { autocomplete: 'cc-number' });
    expect(measure(page([], { target: password }), { mode: 'pointer', point: { x: 400, y: 315 }, target })).toBeNull();
    expect(measure(page([], { focus: password }), { mode: 'keyboard' })).toBeNull();
    expect(measure(page([{ ...card, value: '4242 4242 4242 4242' }]), { mode: 'pointer', point: { x: 400, y: 345 } })).toBeNull();
    expect(measure(page([{ ...card, value: '' }]), { mode: 'pointer', point: { x: 400, y: 345 } })).not.toBeNull();
    expect(measure(page([{ ...card, value: '4242' }]), { mode: 'pointer', point: { x: 100, y: 60 } })).not.toBeNull();
    const shadow = node('DIV', { left: 0, top: 0, width: 10, height: 10 }, {}, { shadowRoot: { querySelectorAll: () => [{ ...card, value: '4242' }] } });
    expect(measure(page([shadow]), { mode: 'pointer', point: { x: 400, y: 345 } })).toBeNull();
  });

  const click = { mode: 'pointer', point: { x: 400, y: 345 } } as const;
  const inView = { left: 300, top: 250, width: 300, height: 80 };
  const card = (left = 10, top = 10) => node('INPUT', { left, top, width: 220, height: 36 }, { autocomplete: 'cc-number' }, { value: '4242 4242 4242 4242' });
  const frame = (box: Box, contentDocument: unknown, extra: Record<string, unknown> = {}, tagName = 'IFRAME') => node(tagName, box, {}, { contentDocument, ...extra });
  const readable = (box: Box, nodes: unknown[], extra: Record<string, unknown> = {}) => frame(box, { querySelectorAll: () => nodes }, extra);

  it('treats a marked custom field in view as filled, since its content cannot be read reliably', () => {
    const at = { left: 300, top: 300, width: 200, height: 30 };
    expect(measure(page([node('DIV', at, { contenteditable: 'true', autocomplete: 'one-time-code' })]), click)).toBeNull();
    expect(measure(page([node('OTP-INPUT', at, { autocomplete: 'cc-number' })]), click)).toBeNull();
    expect(measure(page([node('DIV', at, { role: 'textbox', autocomplete: 'section-pay CC-CSC' })]), click)).toBeNull();
    expect(measure(page([readable(inView, [node('DIV', { left: 10, top: 10, width: 200, height: 30 }, { contenteditable: 'true', autocomplete: 'one-time-code' })])]), click)).toBeNull();
    expect(measure(page([node('DIV', { left: 700, top: 600, width: 200, height: 30 }, { contenteditable: 'true', autocomplete: 'one-time-code' })]), click)).not.toBeNull();
    expect(measure(page([node('DIV', at, { contenteditable: 'true', autocomplete: 'off' })]), click)).not.toBeNull();
    expect(measure(page([node('INPUT', at, { autocomplete: 'one-time-code' })]), click)).not.toBeNull();
  });

  it('never captures a visible frame it cannot look into', () => {
    expect(measure(page([frame(inView, null)]), click)).toBeNull();
    expect(measure(page([frame(inView, null, {}, 'FRAME')]), click)).toBeNull();
    expect(measure(page([frame(inView, null, {}, 'OBJECT')]), click)).toBeNull();
    expect(measure(page([frame(inView, undefined, {}, 'EMBED')]), click)).toBeNull();
    const blocked = frame(inView, null);
    Object.defineProperty(blocked, 'contentDocument', { get: () => { throw new Error('Blocked a frame from accessing a cross-origin frame.'); } });
    expect(measure(page([blocked]), click)).toBeNull();
    expect(measure(page([readable({ left: 300, top: 250, width: 150, height: 40 }, [], { offsetWidth: 300, offsetHeight: 80 })]), click)).toBeNull();
  });

  it('ignores frames outside the crop, hidden frames and tracking pixels', () => {
    expect(measure(page([frame({ left: 700, top: 600, width: 300, height: 80 }, null)]), click)).not.toBeNull();
    expect(measure(page([frame({ left: 400, top: 300, width: 1, height: 1 }, null)]), click)).not.toBeNull();
    expect(measure(page([frame({ left: 400, top: 300, width: 0, height: 0 }, null)]), click)).not.toBeNull();
    expect(measure(page([frame(inView, null, { style: { visibility: 'hidden' } })]), click)).not.toBeNull();
  });

  it('looks into frames it can read where their content is on screen', () => {
    expect(measure(page([readable(inView, [])]), click)).not.toBeNull();
    expect(measure(page([readable(inView, [card()])]), click)).toBeNull();
    expect(measure(page([readable(inView, [node('DIV', { left: 0, top: 0, width: 10, height: 10 }, {}, { shadowRoot: { querySelectorAll: () => [card()] } })])]), click)).toBeNull();
    expect(measure(page([readable({ left: 300, top: 250, width: 300, height: 40 }, [card(10, 60)])]), click)).not.toBeNull();
    expect(measure(page([readable({ left: 620, top: 250, width: 300, height: 80 }, [card(10)])]), click)).toBeNull();
    expect(measure(page([readable({ left: 620, top: 250, width: 300, height: 80 }, [card(40)])]), click)).not.toBeNull();
  });

  it('places frame content after the frame border and padding', () => {
    const low = { left: 300, top: 440, width: 300, height: 160 };
    expect(measure(page([readable(low, [card()])]), click)).toBeNull();
    expect(measure(page([readable(low, [card()], { clientTop: 50, clientHeight: 60 })]), click)).not.toBeNull();
    expect(measure(page([readable(low, [card()], { style: { paddingTop: '50px' } })]), click)).not.toBeNull();
  });

  it('checks frames nested in readable frames within their parent viewport', () => {
    expect(measure(page([readable(inView, [frame({ left: 0, top: 0, width: 100, height: 40 }, null)])]), click)).toBeNull();
    expect(measure(page([readable(inView, [frame({ left: 0, top: 120, width: 100, height: 40 }, null)])]), click)).not.toBeNull();
    expect(measure(page([readable(inView, [readable({ left: 0, top: 0, width: 280, height: 60 }, [card()])])]), click)).toBeNull();
  });
});

describe('page scripts', () => {
  afterEach(() => vi.useRealTimers());

  it('gives up on a page script that never answers, such as behind an open dialog', async () => {
    vi.useFakeTimers();
    const contents = { executeJavaScriptInIsolatedWorld: vi.fn(() => new Promise(() => {})) };
    const pending = expect(isolated(contents as never, '1', 1_000)).rejects.toMatchObject({ code: 'PAGE_NOT_READY', message: expect.stringContaining('page.dialog.get') });
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;
  });
});
