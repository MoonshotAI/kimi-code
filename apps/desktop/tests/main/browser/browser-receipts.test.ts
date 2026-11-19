import { mkdtemp, readdir, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ root: '', writes: null as Promise<void> | null, failWrites: false, warn: vi.fn(), events: [] as string[], releaseWrites: () => {} }));
const images = vi.hoisted(() => ({
  jobs: [] as Array<Record<string, unknown>>,
  bitmaps: [] as Array<{ width: number; height: number; bgra: Buffer }>,
  encode: vi.fn(),
  failWorker: false,
  workers: [] as Array<{ readonly path: string; emit: (event: string, ...args: unknown[]) => boolean }>,
  afterPost: undefined as (() => void) | undefined,
}));
vi.mock('electron', () => ({
  app: { getPath: () => env.root },
  nativeImage: {
    createFromBitmap: (bgra: Buffer, size: { width: number; height: number }) => {
      images.bitmaps.push({ ...size, bgra: Buffer.from(bgra) });
      return { isEmpty: () => false, toJPEG: (quality: number) => { images.encode(quality, size); return Buffer.from('jpeg-bytes'); } };
    },
  },
}));
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  const { cropReceiptBitmap } = await import('../../../src/main/browser/browser-receipt-image');
  class FakeWorker extends EventEmitter {
    constructor(readonly path: string) { super(); images.workers.push(this); }
    unref(): void {}
    postMessage(job: Parameters<typeof cropReceiptBitmap>[0] & { id: number }): void {
      images.jobs.push(job as never);
      images.afterPost?.();
      setImmediate(() => {
        if (images.failWorker) this.emit('error', new Error('worker crashed'));
        else this.emit('message', { id: job.id, bitmap: cropReceiptBitmap(job) });
      });
    }
  }
  return { Worker: FakeWorker };
});
vi.mock('../../../src/main/diagnostics/log', () => ({ log: { warn: env.warn, error: vi.fn() } }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (env.writes) await env.writes;
      if (env.failWrites && typeof args[0] === 'string' && args[0].endsWith('.json')) throw new Error('disk full');
      await actual.writeFile(...args);
      if (typeof args[0] === 'string') env.events.push(`wrote ${args[0]}`);
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      env.events.push(`rm ${String(args[0])}`);
      return actual.rm(...args);
    },
  };
});

import { encodePng } from '../fixtures/receipt-png';
import {
  browserReceiptWanted, captureBrowserReceipt, copyBrowserReceipts, deleteBrowserReceipts,
  pruneBrowserReceipts, readBrowserReceipt, settleBrowserReceiptWritesForTest, withBrowserReceipt,
} from '../../../src/main/browser/browser-receipts';

const JPEG = Buffer.from('jpeg-bytes').toString('base64');
const inCrop = (x: number, y: number) => x >= 320 && x < 1280 && y >= 390 && y < 990;
const PNG = encodePng(1600, 1000, (x, y) => inCrop(x, y) ? [0, 200, 0] : [255, 0, 0]).toString('base64');
const FRAME = { viewport: { width: 800, height: 500 }, crop: { x: 160, y: 195, width: 480, height: 300 }, point: { x: 400, y: 345 } };

function page(frame: unknown = FRAME, screenshot: () => Promise<unknown> = async () => ({ data: PNG })) {
  const sendCommand = vi.fn(async (method: string, _params?: Record<string, unknown>) => method === 'Page.captureScreenshot' ? screenshot() : undefined);
  const executeJavaScriptInIsolatedWorld = vi.fn(async (_world: number, _scripts: Array<{ code: string }>) => frame);
  return { sendCommand, executeJavaScriptInIsolatedWorld, value: { isDestroyed: () => false, executeJavaScriptInIsolatedWorld, debugger: { isAttached: () => true, sendCommand } } as never };
}

const shotOf = (target: ReturnType<typeof page>) => target.sendCommand.mock.calls.find(call => call[0] === 'Page.captureScreenshot')?.[1];
const shots = (target: ReturnType<typeof page>) => target.sendCommand.mock.calls.filter(call => call[0] === 'Page.captureScreenshot').length;

beforeEach(async () => {
  env.root = await mkdtemp(join(tmpdir(), 'kimi-receipts-'));
  env.writes = null;
  env.failWrites = false;
  env.warn.mockClear();
  env.events = [];
  env.releaseWrites = () => {};
  images.jobs = [];
  images.bitmaps = [];
  images.encode.mockClear();
  images.failWorker = false;
  images.afterPost = undefined;
});

function holdWrites(): () => void {
  let release: () => void = () => {};
  env.writes = new Promise<void>(resolve => { release = resolve; });
  env.releaseWrites = () => { env.writes = null; release(); };
  return env.releaseWrites;
}
async function removeTestRoot(): Promise<void> {
  await settleBrowserReceiptWritesForTest();
  await rm(env.root, { recursive: true, force: true });
}
afterEach(async () => {
  env.releaseWrites();
  await removeTestRoot();
});

describe('browser action receipts', () => {
  it('captures the whole viewport once per operation, crops the measured area from it and stores it privately', async () => {
    const target = page();
    const { receiptId } = await withBrowserReceipt('session_1', async () => {
      expect(browserReceiptWanted()).toBe(true);
      await captureBrowserReceipt(target.value, 'frame-code');
      expect(browserReceiptWanted()).toBe(false);
      await captureBrowserReceipt(target.value, 'frame-code');
    });
    expect(receiptId).toMatch(/^r-[0-9a-f]{12}$/);
    expect(target.executeJavaScriptInIsolatedWorld).toHaveBeenCalledWith(1001, [{ code: 'frame-code' }], true);
    expect(shots(target)).toBe(1);
    expect(shotOf(target)).toEqual({ format: 'png', optimizeForSpeed: true, captureBeyondViewport: false });
    expect(shotOf(target)).not.toHaveProperty('clip');
    expect(await readBrowserReceipt('session_1', receiptId!)).toEqual({
      id: receiptId, mimeType: 'image/jpeg', data: JPEG, width: 480, height: 300, point: { x: 0.5, y: 0.5 },
    });
    expect(images.jobs).toEqual([expect.objectContaining({ data: PNG, viewport: FRAME.viewport, crop: FRAME.crop, maxWidth: 720 })]);
    expect(images.workers.at(-1)?.path).toBe(fileURLToPath(new URL('../../../src/main/browser/browser-receipt-worker.cjs', import.meta.url)));
    expect(images.encode).toHaveBeenCalledWith(72, { width: 720, height: 450 });
    expect(new Set(images.bitmaps[0]!.bgra.toString('hex').match(/.{8}/g))).toEqual(new Set(['00c800ff']));
    const file = join(env.root, 'browser-receipts', 'session_1', `${receiptId}.jpg`);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(env.root, 'browser-receipts', 'session_1'))).mode & 0o777).toBe(0o700);
  });

  it('keeps the element box only when it fits inside the crop', async () => {
    const inside = page({ ...FRAME, point: undefined, box: { x: 280, y: 330, width: 240, height: 30 } });
    const first = await withBrowserReceipt('session_1', () => captureBrowserReceipt(inside.value, 'code'));
    expect((await readBrowserReceipt('session_1', first.receiptId!))).toMatchObject({ box: { x: 0.25, y: 0.45, width: 0.5, height: 0.1 } });
    expect((await readBrowserReceipt('session_1', first.receiptId!))!.point).toBeUndefined();

    const larger = page({ ...FRAME, box: { x: 100, y: 100, width: 900, height: 500 } });
    const second = await withBrowserReceipt('session_1', () => captureBrowserReceipt(larger.value, 'code'));
    const stored = await readBrowserReceipt('session_1', second.receiptId!);
    expect(stored!.box).toBeUndefined();
    expect(stored!.point).toEqual({ x: 0.5, y: 0.5 });
  });

  it('does not decode, crop or encode anything until the action has finished', async () => {
    const target = page();
    const { receiptId } = await withBrowserReceipt('session_1', async () => {
      await captureBrowserReceipt(target.value, 'code');
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(images.jobs).toEqual([]);
      expect(images.bitmaps).toEqual([]);
    });
    expect(images.jobs).toEqual([]);
    expect(await readBrowserReceipt('session_1', receiptId!)).toMatchObject({ id: receiptId, data: JPEG });
    expect(images.jobs).toHaveLength(1);
  });

  it('abandons the receipt of an action that fails and writes nothing for it', async () => {
    const target = page();
    await expect(withBrowserReceipt('session_1', async () => {
      await captureBrowserReceipt(target.value, 'code');
      throw new Error('click failed');
    })).rejects.toThrow('click failed');
    await new Promise(resolve => setTimeout(resolve, 20));
    await settleBrowserReceiptWritesForTest();
    expect(shots(target)).toBe(1);
    expect(images.jobs).toEqual([]);
    expect(await readdir(join(env.root, 'browser-receipts')).catch(() => [])).toEqual([]);
  });

  it('writes nothing when the session is deleted before the receipt is processed', async () => {
    const { receiptId } = await withBrowserReceipt('session_removed', () => captureBrowserReceipt(page().value, 'code'));
    expect(receiptId).toBeDefined();
    await deleteBrowserReceipts('session_removed');
    expect(images.jobs).toEqual([]);
    expect(await readdir(join(env.root, 'browser-receipts')).catch(() => [])).toEqual([]);
  });

  it('reports the receipt as unavailable when the screenshot cannot be processed', async () => {
    const mismatched = await withBrowserReceipt('session_1', () => captureBrowserReceipt(page({ ...FRAME, viewport: { width: 800, height: 400 } }).value, 'code'));
    expect(await readBrowserReceipt('session_1', mismatched.receiptId!)).toBeNull();
    images.failWorker = true;
    const crashed = await withBrowserReceipt('session_1', () => captureBrowserReceipt(page().value, 'code'));
    expect(await readBrowserReceipt('session_1', crashed.receiptId!)).toBeNull();
    expect(env.warn).toHaveBeenCalledWith(expect.stringContaining('worker crashed'));
    expect(images.encode).not.toHaveBeenCalled();
    expect(await readdir(join(env.root, 'browser-receipts')).catch(() => [])).toEqual([]);
    images.failWorker = false;
    const next = await withBrowserReceipt('session_1', () => captureBrowserReceipt(page().value, 'code'));
    expect(await readBrowserReceipt('session_1', next.receiptId!)).toMatchObject({ data: JPEG });
  });

  it('keeps the jobs of a replacement worker when the crashed one exits later', async () => {
    images.failWorker = true;
    const crashed = await withBrowserReceipt('session_1', () => captureBrowserReceipt(page().value, 'code'));
    expect(await readBrowserReceipt('session_1', crashed.receiptId!)).toBeNull();
    const old = images.workers.at(-1)!;
    images.failWorker = false;
    images.afterPost = () => { images.afterPost = undefined; old.emit('exit', 1); };
    const next = await withBrowserReceipt('session_1', () => captureBrowserReceipt(page().value, 'code'));
    expect(await readBrowserReceipt('session_1', next.receiptId!)).toMatchObject({ id: next.receiptId, data: JPEG });
    expect(images.workers.at(-1)).not.toBe(old);
  });

  it('skips pages that report nothing to capture or an invalid measurement', async () => {
    for (const frame of [null, 'x', { ...FRAME, crop: { x: 0, y: 0, width: 0, height: 10 } }, { ...FRAME, viewport: { width: Number.NaN, height: 1000 } }, { ...FRAME, viewport: undefined }, { ...FRAME, point: undefined, box: undefined }]) {
      const target = page(frame);
      const { receiptId } = await withBrowserReceipt('session_1', () => captureBrowserReceipt(target.value, 'code'));
      expect(receiptId, JSON.stringify(frame)).toBeUndefined();
      expect(shots(target)).toBe(0);
    }
  });

  it('works only inside an operation that has a session', async () => {
    const target = page();
    expect(browserReceiptWanted()).toBe(false);
    await captureBrowserReceipt(target.value, 'code');
    expect((await withBrowserReceipt(undefined, async () => {
      expect(browserReceiptWanted()).toBe(false);
      await captureBrowserReceipt(target.value, 'code');
    })).receiptId).toBeUndefined();
    expect(target.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
  });

  it('never fails or stalls the action, and drops a capture that finishes too late', async () => {
    vi.useFakeTimers();
    try {
      const broken = page(FRAME, async () => { throw new Error('capture failed'); });
      await expect(withBrowserReceipt('session_1', () => captureBrowserReceipt(broken.value, 'code'))).resolves.toMatchObject({ receiptId: undefined });

      let finish: (value: unknown) => void = () => {};
      const slow = page(FRAME, () => new Promise(resolve => { finish = resolve; }));
      const pending = withBrowserReceipt('session_1', () => captureBrowserReceipt(slow.value, 'code'));
      await vi.advanceTimersByTimeAsync(200);
      await expect(pending).resolves.toMatchObject({ receiptId: undefined });
      finish({ data: PNG });
      await vi.advanceTimersByTimeAsync(10);
    } finally {
      vi.useRealTimers();
    }
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(await readdir(join(env.root, 'browser-receipts')).catch(() => [])).toEqual([]);
  });

  it('waits at most 150 ms for the screenshot', async () => {
    vi.useFakeTimers();
    try {
      const slow = page(FRAME, () => new Promise(() => {}));
      let settled = false;
      const pending = withBrowserReceipt('session_1', () => captureBrowserReceipt(slow.value, 'code')).then((result) => { settled = true; return result; });
      await vi.advanceTimersByTimeAsync(149);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      await expect(pending).resolves.toEqual({ value: undefined, receiptId: undefined });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a screenshot that arrived in time even when saving it takes longer than the limit', async () => {
    vi.useFakeTimers();
    let release = () => {};
    try {
      release = holdWrites();
      const { receiptId } = await withBrowserReceipt('session_1', () => captureBrowserReceipt(page().value, 'code'));
      expect(receiptId).toMatch(/^r-[0-9a-f]{12}$/);
      await vi.advanceTimersByTimeAsync(1000);
      const read = readBrowserReceipt('session_1', receiptId!);
      release();
      vi.useRealTimers();
      await expect(read).resolves.toMatchObject({ id: receiptId, data: JPEG });
    } finally {
      release();
      vi.useRealTimers();
    }
  });

  it('does not leave a receipt behind when its session is deleted while it is being saved', async () => {
    const release = holdWrites();
    const { receiptId } = await withBrowserReceipt('session_saving', () => captureBrowserReceipt(page().value, 'code'));
    expect(receiptId).toBeDefined();
    const deleting = deleteBrowserReceipts('session_saving');
    release();
    await deleting;
    expect(await readdir(join(env.root, 'browser-receipts')).catch(() => [])).toEqual([]);
  });

  it('drops a receipt whose session is deleted while the screenshot is being taken, and measures nothing for it later', async () => {
    let asked = () => {};
    const requested = new Promise<void>(resolve => { asked = resolve; });
    let deliver: (value: unknown) => void = () => {};
    const target = page(FRAME, () => { asked(); return new Promise(resolve => { deliver = resolve; }); });
    const capturing = withBrowserReceipt('session_gone', () => captureBrowserReceipt(target.value, 'code'));
    await requested;
    await deleteBrowserReceipts('session_gone');
    deliver({ data: PNG });
    expect((await capturing).receiptId).toBeUndefined();
    expect(await readBrowserReceipt('session_gone', 'r-000000000000')).toBeNull();
    expect(await readdir(join(env.root, 'browser-receipts')).catch(() => [])).toEqual([]);

    const later = page();
    const next = await withBrowserReceipt('session_gone', async () => {
      const wanted = browserReceiptWanted();
      await captureBrowserReceipt(later.value, 'code');
      return wanted;
    });
    expect(next).toEqual({ value: false, receiptId: undefined });
    expect(later.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
    expect((await withBrowserReceipt('session_kept', () => captureBrowserReceipt(page().value, 'code'))).receiptId).toBeDefined();
  });

  it('copies a receipt that is still being saved', async () => {
    const release = holdWrites();
    const { receiptId } = await withBrowserReceipt('session_1', () => captureBrowserReceipt(page().value, 'code'));
    const copying = copyBrowserReceipts('session_1', 'session_2');
    release();
    await copying;
    expect(await readBrowserReceipt('session_2', receiptId!)).toMatchObject({ id: receiptId });
  });

  it('reports a receipt it could not save as unavailable and leaves no partial files', async () => {
    env.failWrites = true;
    const { receiptId } = await withBrowserReceipt('session_1', () => captureBrowserReceipt(page().value, 'code'));
    expect(receiptId).toBeDefined();
    expect(await readBrowserReceipt('session_1', receiptId!)).toBeNull();
    expect(await readdir(join(env.root, 'browser-receipts', 'session_1'))).toEqual([]);
    expect(env.warn).toHaveBeenCalledWith(expect.stringContaining('disk full'));
  });

  it('returns the value of the operation and rethrows its error', async () => {
    expect(await withBrowserReceipt('session_1', async () => 'done')).toEqual({ value: 'done', receiptId: undefined });
    await expect(withBrowserReceipt('session_1', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  });

  it('refuses ids that could leave its directory', async () => {
    const { receiptId } = await withBrowserReceipt('session_1', () => captureBrowserReceipt(page().value, 'code'));
    expect((await withBrowserReceipt('../escape', () => captureBrowserReceipt(page().value, 'code'))).receiptId).toBeUndefined();
    expect(await readBrowserReceipt('../session_1', receiptId!)).toBeNull();
    expect(await readBrowserReceipt('session_1', '../../etc/passwd')).toBeNull();
    expect(await readBrowserReceipt('session_1', 'r-000000000000')).toBeNull();
    await deleteBrowserReceipts('../session_1');
    await copyBrowserReceipts('session_1', '../elsewhere');
    expect(await readBrowserReceipt('session_1', receiptId!)).not.toBeNull();
    expect(await readdir(join(env.root, 'browser-receipts'))).toEqual(['session_1']);
  });

  it('copies receipts to a forked session and deletes them with their session', async () => {
    const { receiptId } = await withBrowserReceipt('session_source', () => captureBrowserReceipt(page().value, 'code'));
    await copyBrowserReceipts('session_source', 'session_2');
    await copyBrowserReceipts('session_source', 'session_2');
    await copyBrowserReceipts('missing', 'session_3');
    expect(await readBrowserReceipt('session_2', receiptId!)).toEqual(await readBrowserReceipt('session_source', receiptId!));
    expect((await stat(join(env.root, 'browser-receipts', 'session_2', `${receiptId}.jpg`))).mode & 0o777).toBe(0o600);
    await deleteBrowserReceipts('session_source');
    expect(await readBrowserReceipt('session_source', receiptId!)).toBeNull();
    expect(await readBrowserReceipt('session_2', receiptId!)).not.toBeNull();
    expect((await readdir(join(env.root, 'browser-receipts'))).sort()).toEqual(['session_2']);
  });

  it('removes receipts older than thirty days and sessions left empty', async () => {
    const old = await withBrowserReceipt('session_old', () => captureBrowserReceipt(page().value, 'code'));
    const mixedOld = await withBrowserReceipt('session_mixed', () => captureBrowserReceipt(page().value, 'code'));
    const mixedNew = await withBrowserReceipt('session_mixed', () => captureBrowserReceipt(page().value, 'code'));
    for (const [session, id] of [['session_old', old.receiptId], ['session_mixed', mixedOld.receiptId], ['session_mixed', mixedNew.receiptId]] as const) {
      expect(await readBrowserReceipt(session, id!)).not.toBeNull();
    }
    const past = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    for (const [session, id] of [['session_old', old.receiptId], ['session_mixed', mixedOld.receiptId]] as const) {
      for (const extension of ['jpg', 'json']) await utimes(join(env.root, 'browser-receipts', session, `${id}.${extension}`), past, past);
    }
    await pruneBrowserReceipts();
    expect(await readdir(join(env.root, 'browser-receipts'))).toEqual(['session_mixed']);
    expect(await readBrowserReceipt('session_mixed', mixedOld.receiptId!)).toBeNull();
    expect(await readBrowserReceipt('session_mixed', mixedNew.receiptId!)).not.toBeNull();
  });

  it('lets receipts still being saved finish before the test folder is removed', async () => {
    const release = holdWrites();
    await withBrowserReceipt('session_teardown', () => captureBrowserReceipt(page().value, 'code'));
    const removing = removeTestRoot();
    release();
    await removing;
    const removal = env.events.indexOf(`rm ${env.root}`);
    expect(env.events.slice(0, removal).filter(event => event.startsWith('wrote '))).toHaveLength(2);
    expect(env.events.slice(removal)).toEqual([`rm ${env.root}`]);
    expect(env.warn).not.toHaveBeenCalled();
  });

  it('still tears down after a test stops before releasing the writes it held', async () => {
    holdWrites();
    const { receiptId } = await withBrowserReceipt('session_abandoned', () => captureBrowserReceipt(page().value, 'code'));
    expect(receiptId).toBeDefined();
  });

  it('does not prune the folder of a first receipt that is still being saved', async () => {
    const release = holdWrites();
    const { receiptId } = await withBrowserReceipt('session_new', () => captureBrowserReceipt(page().value, 'code'));
    await vi.waitFor(async () => expect(await readdir(join(env.root, 'browser-receipts'))).toEqual(['session_new']));
    const pruning = pruneBrowserReceipts();
    await new Promise(resolve => setTimeout(resolve, 20));
    release();
    await pruning;
    expect(await readBrowserReceipt('session_new', receiptId!)).not.toBeNull();
    expect(env.warn).not.toHaveBeenCalled();
  });
});
