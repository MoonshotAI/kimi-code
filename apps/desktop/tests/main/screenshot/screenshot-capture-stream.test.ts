import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

class FakeHostWindow {
  static nextLoad: Promise<void> | null = null;
  crashed = false;
  webContents = {
    mainFrame: {},
    executeJavaScript: vi.fn(),
    isDestroyed: () => false,
    isCrashed: () => this.crashed,
    on: vi.fn(),
  };
  loadURL = vi.fn(() => FakeHostWindow.nextLoad ?? Promise.resolve());
  destroy = vi.fn(() => {
    this.destroyed = true;
  });
  on = vi.fn();
  destroyed = false;
  constructor() {
    windows.push(this);
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
}

const windows: FakeHostWindow[] = [];
const getSources = vi.fn();
const setDisplayMediaRequestHandler = vi.fn();

vi.mock('electron', () => ({
  app: { isPackaged: true },
  BrowserWindow: FakeHostWindow,
  desktopCapturer: { getSources },
  session: {
    defaultSession: { setDisplayMediaRequestHandler },
  },
}));

vi.mock('../../../src/main/diagnostics/log', () => ({
  log: { info: vi.fn(), warn: vi.fn() },
}));

async function importModule(): Promise<typeof import('../../../src/main/screenshot/screenshot-capture-stream')> {
  return import('../../../src/main/screenshot/screenshot-capture-stream');
}

beforeEach(() => {
  vi.resetModules();
  Object.defineProperty(process, 'platform', { value: 'win32' });
  FakeHostWindow.nextLoad = null;
  windows.length = 0;
  getSources.mockReset();
  setDisplayMediaRequestHandler.mockReset();
});

afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform);
});

const SOURCES = [
  { display_id: '1', id: 'screen-1' },
  { display_id: '2', id: 'screen-2' },
];

function stubHostPage(win: FakeHostWindow): void {
  win.webContents.executeJavaScript.mockImplementation(async (script: string) => {
    if (script.includes('.has(')) return false;
    if (script.includes('startStream')) return { ok: true, width: 1920, height: 1080 };
    if (script.includes('grab("1")')) return { width: 2, height: 2, data: new Uint8Array(16).fill(7) };
    if (script.includes('grab(')) throw new Error('stream-missing');
    return undefined;
  });
}

describe('screenshot capture stream manager', () => {
  it('does nothing off win32', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const { warmCaptureStreams } = await importModule();
    await warmCaptureStreams(['1']);
    expect(getSources).not.toHaveBeenCalled();
    expect(windows).toHaveLength(0);
  });

  it('warms one stream per display through the hidden host page', async () => {
    const { warmCaptureStreams } = await importModule();
    getSources.mockResolvedValue(SOURCES);
    await warmCaptureStreams(['1', '2']);
    expect(getSources).toHaveBeenCalledWith({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    expect(windows).toHaveLength(1);
    expect(windows[0]!.loadURL).toHaveBeenCalledWith('app://renderer/capture-host/index.html');
    const scripts = windows[0]!.webContents.executeJavaScript.mock.calls.map(([script]) => script as string);
    expect(scripts.filter((script) => script.includes('startStream'))).toHaveLength(2);
  });

  it('warms the only source with an empty display_id even without a requested thumbnail', async () => {
    const { warmCaptureStreams } = await importModule();
    const source = { display_id: '', id: 'screen:0:0', thumbnail: { isEmpty: vi.fn(() => true) } };
    getSources.mockResolvedValue([source]);
    const pending = warmCaptureStreams(['1']);
    await vi.waitFor(() => expect(windows).toHaveLength(1));
    const handler = setDisplayMediaRequestHandler.mock.calls[0]![0] as (request: unknown, callback: (value: unknown) => void) => void;
    const win = windows[0]!;
    const approved: unknown[] = [];
    win.webContents.executeJavaScript.mockImplementation(async (script: string) => {
      if (script.includes('.has(')) return false;
      if (script.includes('startStream("1")')) {
        handler({ frame: win.webContents.mainFrame }, (value: unknown) => approved.push(value));
        return { ok: true, width: 1920, height: 1080 };
      }
      return undefined;
    });
    await pending;
    expect(approved).toEqual([{ video: source }]);
    expect(source.thumbnail.isEmpty).not.toHaveBeenCalled();
  });

  it('does not guess an empty display_id source across displays', async () => {
    const { warmCaptureStreams } = await importModule();
    getSources.mockResolvedValue([{ display_id: '', id: 'screen:0:0' }]);
    await warmCaptureStreams(['1', '2']);
    const scripts = windows[0]!.webContents.executeJavaScript.mock.calls.map(([script]) => script as string);
    expect(scripts.filter((script) => script.includes('startStream'))).toHaveLength(0);
  });

  it('approves display media only for the host frame with a pending source', async () => {
    const { warmCaptureStreams } = await importModule();
    getSources.mockResolvedValue(SOURCES);
    windows.length = 0;
    const pending = warmCaptureStreams(['1']);
    await vi.waitFor(() => expect(setDisplayMediaRequestHandler).toHaveBeenCalled());
    const handler = setDisplayMediaRequestHandler.mock.calls[0]![0] as (request: unknown, callback: (value: unknown) => void) => void;
    const win = windows[0]!;
    win.webContents.executeJavaScript.mockImplementation(async (script: string) => {
      if (script.includes('startStream')) {
        const approved: unknown[] = [];
        handler({ frame: win.webContents.mainFrame }, (value: unknown) => approved.push(value));
        expect(approved[0]).toEqual({ video: SOURCES[0] });
        return { ok: true, width: 1920, height: 1080 };
      }
      if (script.includes('.has(')) return false;
      return undefined;
    });
    await pending;
    const rejected: unknown[] = [];
    handler({ frame: {} }, (value: unknown) => rejected.push(value));
    expect(rejected[0]).toEqual({});
  });

  it('grabs frames for every display and returns null on any failure', async () => {
    const { warmCaptureStreams, grabStreamFrames } = await importModule();
    getSources.mockResolvedValue(SOURCES);
    await warmCaptureStreams(['1']);
    stubHostPage(windows[0]!);
    const frames = await grabStreamFrames(['1']);
    expect(frames?.get('1')).toEqual({ width: 2, height: 2, data: new Uint8Array(16).fill(7) });
    expect(await grabStreamFrames(['2'])).toBeNull();
  });

  it.each(['throw', 'empty'] as const)('discards a failed grab host and rebuilds on next warmup (%s)', async (mode) => {
    const { warmCaptureStreams, grabStreamFrames } = await importModule();
    getSources.mockResolvedValue(SOURCES);
    await warmCaptureStreams(['1']);
    const win = windows[0]!;
    win.webContents.executeJavaScript.mockImplementation(async (script: string) => {
      if (script.includes('grab("1")')) {
        if (mode === 'throw') throw new Error('canvas-failed');
        return { width: 2, height: 2, data: new Uint8Array(0) };
      }
      return undefined;
    });
    expect(await grabStreamFrames(['1'])).toBeNull();
    expect(win.destroy).toHaveBeenCalledTimes(1);
    await warmCaptureStreams(['1']);
    expect(windows).toHaveLength(2);
  });

  it('returns null from grab when the host never started', async () => {
    const { grabStreamFrames } = await importModule();
    expect(await grabStreamFrames(['1'])).toBeNull();
  });

  it('destroys the host on display change and shutdown', async () => {
    const { warmCaptureStreams, resetCaptureStreamsForDisplayChange, shutdownCaptureStreams } = await importModule();
    getSources.mockResolvedValue(SOURCES);
    await warmCaptureStreams(['1']);
    expect(windows).toHaveLength(1);
    resetCaptureStreamsForDisplayChange();
    expect(windows[0]!.destroy).toHaveBeenCalled();
    await warmCaptureStreams(['1']);
    expect(windows).toHaveLength(2);
    shutdownCaptureStreams();
    expect(windows[1]!.destroy).toHaveBeenCalled();
  });

  it('a stale load failure never destroys the replacement host', async () => {
    const { warmCaptureStreams } = await importModule();
    getSources.mockResolvedValue(SOURCES);
    let rejectFirstLoad: (error: Error) => void = () => undefined;
    FakeHostWindow.nextLoad = new Promise((_resolve, reject) => {
      rejectFirstLoad = reject;
    });
    const first = warmCaptureStreams(['1']);
    await vi.waitFor(() => expect(windows.length).toBe(1));
    const goneHandler = windows[0]!.webContents.on.mock.calls.find(([event]) => event === 'render-process-gone')?.[1] as (() => void) | undefined;
    goneHandler!();
    FakeHostWindow.nextLoad = null;
    const second = warmCaptureStreams(['1']);
    await vi.waitFor(() => expect(windows.length).toBe(2));
    rejectFirstLoad(new Error('load-failed'));
    await first;
    await second;
    expect(windows[1]!.destroy).not.toHaveBeenCalled();
  });

  it('rebuilds the host when its renderer crashes or is reported gone', async () => {
    const { warmCaptureStreams } = await importModule();
    getSources.mockResolvedValue(SOURCES);
    await warmCaptureStreams(['1']);
    expect(windows).toHaveLength(1);
    windows[0]!.crashed = true;
    await warmCaptureStreams(['1']);
    expect(windows).toHaveLength(2);
    expect(windows[0]!.destroy).toHaveBeenCalled();
    const goneHandler = windows[1]!.webContents.on.mock.calls.find(([event]) => event === 'render-process-gone')?.[1] as (() => void) | undefined;
    expect(goneHandler).toBeDefined();
    goneHandler!();
    expect(windows[1]!.destroy).toHaveBeenCalled();
    await warmCaptureStreams(['1']);
    expect(windows).toHaveLength(3);
  });
});

describe('screenshotRgbaFrame', () => {
  it('writes a v4 header with RGBA masks and copies pixels verbatim', async () => {
    const { screenshotRgbaFrame } = await import('../../../src/main/screenshot/screenshot-frame');
    const rgba = Buffer.from([10, 20, 30, 255, 40, 50, 60, 255]);
    const frame = screenshotRgbaFrame(rgba, 2, 1);
    expect(frame.subarray(0, 2).toString('ascii')).toBe('BM');
    expect(frame.readUInt32LE(2)).toBe(122 + 8);
    expect(frame.readInt32LE(18)).toBe(2);
    expect(frame.readInt32LE(22)).toBe(-1);
    expect(frame.readUInt32LE(54)).toBe(0x000000ff);
    expect(frame.readUInt32LE(58)).toBe(0x0000ff00);
    expect(frame.readUInt32LE(62)).toBe(0x00ff0000);
    expect(frame.readUInt32LE(66)).toBe(0xff000000);
    expect(frame.subarray(122)).toEqual(rgba);
  });

  it('rejects malformed input', async () => {
    const { screenshotRgbaFrame } = await import('../../../src/main/screenshot/screenshot-frame');
    expect(() => screenshotRgbaFrame(Buffer.alloc(3), 1, 1)).toThrow('invalid-screenshot-bitmap');
  });
});
