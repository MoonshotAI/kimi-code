import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  writeIncident: vi.fn(async (..._args: unknown[]) => '/tmp/incident.json'),
  markRendererGone: vi.fn(),
  track: vi.fn(),
}));

vi.mock('electron', () => ({ app: { getVersion: () => '1.3.0', isPackaged: true }, dialog: { showErrorBox: vi.fn() } }));
vi.mock('../../../src/main/diagnostics/incidents', () => ({ writeIncident: mocks.writeIncident }));
vi.mock('../../../src/main/app/launch-state', () => ({ markRendererGone: mocks.markRendererGone }));
vi.mock('../../../src/main/diagnostics/track', () => ({ trackDesktopEvent: mocks.track, trySendDesktopEvent: vi.fn() }));
vi.mock('../../../src/main/diagnostics/collector', () => ({ withTimeout: <T>(promise: Promise<T>) => promise }));

import { logStartup } from '../../../src/main/diagnostics/log';
import {
  BOOT_STALL_MS,
  MAX_STACK_SAMPLES,
  MOUNT_STALL_MS,
  RENDERER_GONE_GRACE_MS,
  STACK_SAMPLE_INTERVAL_MS,
  STARTUP_STALL_MS,
  attachWhiteScreenWatchdog,
  groupStacks,
} from '../../../src/main/window/white-screen-watchdog';

class FakeContents {
  handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  url = 'app://renderer/index.html';
  destroyed = false;
  stacks: string[] = [];
  mainFrame = {
    collectJavaScriptCallStack: vi.fn(async () => this.stacks.shift() ?? 'Error\n    at loop (app://renderer/assets/index.js:1:42)'),
  };
  on(event: string, handler: (...args: unknown[]) => void): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return this;
  }
  once(event: string, handler: (...args: unknown[]) => void): this {
    return this.on(event, handler);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }
  getURL(): string {
    return this.url;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
}

let quitting = false;

function attach(): { contents: FakeContents; dispose: () => void } {
  const contents = new FakeContents();
  const dispose = attachWhiteScreenWatchdog(contents as never, {
    isAppUrl: (url) => url.startsWith('app://'),
    isQuitting: () => quitting,
  });
  return { contents, dispose };
}

function suspected(): Array<{ kind: string; stage: string; elapsed_ms: number }> {
  return mocks.track.mock.calls
    .filter(([event]) => event === 'white_screen_suspected')
    .map(([, properties]) => properties as { kind: string; stage: string; elapsed_ms: number });
}

let disposers: Array<() => void> = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  quitting = false;
  disposers = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  for (const dispose of disposers) dispose();
  vi.useRealTimers();
});

function watched(): FakeContents {
  const { contents, dispose } = attach();
  disposers.push(dispose);
  return contents;
}

describe('startup stall', () => {
  it('records the last startup step when no page has loaded after 10s, then notes the recovery', async () => {
    const contents = watched();
    logStartup('server-start');
    await vi.advanceTimersByTimeAsync(STARTUP_STALL_MS);

    expect(suspected()).toEqual([{ kind: 'startup_stalled', stage: 'server-start', elapsed_ms: STARTUP_STALL_MS }]);
    expect(mocks.writeIncident).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'startup-stalled',
      summary: `startup-stalled stage=server-start after=${STARTUP_STALL_MS}ms`,
      contents,
    }));

    contents.emit('did-finish-load');
    expect(suspected()).toHaveLength(1);
  });

  it('stands down once the app page loads, or when an error or update page is shown instead', async () => {
    const loaded = watched();
    loaded.url = 'data:text/html,waiting';
    loaded.emit('did-finish-load');
    loaded.url = 'app://renderer/index.html';
    loaded.emit('did-finish-load');
    logStartup('ui-mounted');
    logStartup('ui-ready');
    watched();
    logStartup('connect-failed', 'stage=server_start');
    await vi.advanceTimersByTimeAsync(STARTUP_STALL_MS);
    expect(suspected().filter((entry) => entry.kind === 'startup_stalled')).toHaveLength(0);
  });

  it('pauses while the update wait or failure page is shown and starts over when startup resumes', async () => {
    watched();
    logStartup('web-assets-wait');
    await vi.advanceTimersByTimeAsync(STARTUP_STALL_MS * 3);
    expect(suspected()).toEqual([]);

    logStartup('server-start');
    await vi.advanceTimersByTimeAsync(STARTUP_STALL_MS);
    logStartup('connect-failed', 'stage=server_start');
    await vi.advanceTimersByTimeAsync(STARTUP_STALL_MS * 3);
    logStartup('load-url');
    await vi.advanceTimersByTimeAsync(STARTUP_STALL_MS);

    expect(suspected()).toEqual([
      { kind: 'startup_stalled', stage: 'server-start', elapsed_ms: STARTUP_STALL_MS },
      { kind: 'startup_stalled', stage: 'load-url', elapsed_ms: STARTUP_STALL_MS },
    ]);
  });

  it('does not restart the startup check once the app page has loaded', async () => {
    const contents = watched();
    contents.emit('did-finish-load');
    logStartup('ui-mounted');
    logStartup('ui-ready');
    logStartup('connect-failed', 'stage=server_start');
    logStartup('load-url');
    await vi.advanceTimersByTimeAsync(STARTUP_STALL_MS);
    expect(suspected()).toEqual([]);
  });
});

describe('mount and boot stalls', () => {
  it('flags a loaded page that never mounts, with page evidence', async () => {
    const contents = watched();
    contents.emit('did-finish-load');
    await vi.advanceTimersByTimeAsync(MOUNT_STALL_MS);
    expect(suspected()).toEqual([{ kind: 'not_mounted', stage: 'window-created', elapsed_ms: MOUNT_STALL_MS }]);
    expect(mocks.writeIncident).toHaveBeenCalledWith(expect.objectContaining({ kind: 'not-mounted', contents }));
  });

  it('flags a mounted UI whose startup never finishes, naming the boot stage it stopped at', async () => {
    const contents = watched();
    contents.emit('did-finish-load');
    logStartup('ui-mounted');
    logStartup('boot-sessions');
    await vi.advanceTimersByTimeAsync(BOOT_STALL_MS);
    expect(suspected()).toEqual([{ kind: 'boot_stalled', stage: 'boot-sessions', elapsed_ms: BOOT_STALL_MS }]);
  });

  it('does not flag a page whose UI mounted before the load event fired', async () => {
    const contents = watched();
    contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    logStartup('ui-mounted');
    contents.emit('did-finish-load');
    await vi.advanceTimersByTimeAsync(MOUNT_STALL_MS);
    expect(suspected()).toEqual([]);
    logStartup('ui-ready');
    contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    contents.emit('did-finish-load');
    await vi.advanceTimersByTimeAsync(MOUNT_STALL_MS);
    expect(suspected()).toEqual([{ kind: 'not_mounted', stage: 'ui-ready', elapsed_ms: MOUNT_STALL_MS }]);
  });

  it('stays quiet when the UI becomes ready in time or the page navigates away', async () => {
    const ready = watched();
    ready.emit('did-finish-load');
    logStartup('ui-mounted');
    logStartup('ui-ready');
    const reloading = watched();
    reloading.emit('did-finish-load');
    reloading.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    reloading.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    await vi.advanceTimersByTimeAsync(BOOT_STALL_MS + MOUNT_STALL_MS);
    expect(suspected()).toEqual([]);
  });
});

describe('renderer death', () => {
  it('reports a renderer that died while the app keeps running', async () => {
    const contents = watched();
    contents.emit('did-finish-load');
    logStartup('ui-mounted');
    logStartup('ui-ready');
    contents.emit('render-process-gone', {}, { reason: 'killed', exitCode: 15 });
    await vi.advanceTimersByTimeAsync(RENDERER_GONE_GRACE_MS);
    expect(mocks.markRendererGone).toHaveBeenCalledOnce();
    expect(suspected()).toEqual([{ kind: 'renderer_gone', stage: 'ui-ready', elapsed_ms: RENDERER_GONE_GRACE_MS }]);
    expect(mocks.writeIncident).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'renderer-gone',
      contents: null,
      details: { reason: 'killed', exitCode: 15 },
    }));
  });

  it('ignores clean exits and renderers that go away while the app quits', async () => {
    const contents = watched();
    contents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 });
    contents.emit('render-process-gone', {}, { reason: 'killed', exitCode: 15 });
    quitting = true;
    await vi.advanceTimersByTimeAsync(RENDERER_GONE_GRACE_MS);
    expect(mocks.markRendererGone).not.toHaveBeenCalled();
    expect(suspected().filter((entry) => entry.kind === 'renderer_gone')).toEqual([]);
  });

  it('caps repeated incidents of the same kind per launch', async () => {
    const contents = watched();
    for (let i = 0; i < 3; i += 1) {
      contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 11 });
      await vi.advanceTimersByTimeAsync(RENDERER_GONE_GRACE_MS);
    }
    expect(suspected().filter((entry) => entry.kind === 'renderer_gone')).toHaveLength(2);
  });
});

describe('unresponsive renderer', () => {
  it('samples JavaScript stacks until the renderer responds again', async () => {
    const contents = watched();
    contents.stacks = ['stack A', 'stack A', 'stack B'];
    contents.emit('unresponsive');
    contents.emit('unresponsive');
    await vi.advanceTimersByTimeAsync(2_500);
    contents.emit('responsive');
    await vi.advanceTimersByTimeAsync(1_000);

    expect(contents.mainFrame.collectJavaScriptCallStack).toHaveBeenCalledTimes(3);
    expect(suspected()).toEqual([{ kind: 'unresponsive', stage: 'window-created', elapsed_ms: 3_000 }]);
    expect(mocks.writeIncident).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'unresponsive',
      details: { recovered: true, rendererGone: false, stacks: [{ stack: 'stack A', count: 2 }, { stack: 'stack B', count: 1 }] },
    }));
  });

  it('does not count a renderer that died while unresponsive as recovered', async () => {
    const contents = watched();
    contents.emit('unresponsive');
    await vi.advanceTimersByTimeAsync(1_500);
    contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 11 });
    await vi.advanceTimersByTimeAsync(STACK_SAMPLE_INTERVAL_MS);

    expect(mocks.writeIncident).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'unresponsive',
      details: expect.objectContaining({ recovered: false, rendererGone: true }),
    }));
  });

  it('drops a sampling run that outlives the watchdog', async () => {
    const contents = watched();
    contents.emit('unresponsive');
    await vi.advanceTimersByTimeAsync(1_500);
    contents.destroyed = true;
    contents.emit('destroyed');
    await vi.advanceTimersByTimeAsync(MAX_STACK_SAMPLES * STACK_SAMPLE_INTERVAL_MS);

    expect(suspected()).toEqual([]);
    expect(mocks.writeIncident).not.toHaveBeenCalled();
  });

  it('groups identical stacks by frequency', () => {
    expect(groupStacks(['b', 'a', 'b'])).toEqual([{ stack: 'b', count: 2 }, { stack: 'a', count: 1 }]);
  });
});

describe('cleanup', () => {
  it('stops watching once the web contents is destroyed', async () => {
    const contents = watched();
    contents.emit('destroyed');
    logStartup('ui-mounted');
    await vi.advanceTimersByTimeAsync(BOOT_STALL_MS + STARTUP_STALL_MS);
    expect(suspected()).toEqual([]);
  });
});
