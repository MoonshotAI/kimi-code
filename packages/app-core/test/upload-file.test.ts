import { afterEach, describe, expect, it, vi } from 'vitest';
import { DaemonKimiWebApi } from '../src/api/daemon/client';
import { DaemonApiError } from '../src/api/errors';

const identity = {
  clientId: 'web_t',
  clientName: 't',
  clientVersion: '0',
  clientUiMode: 'web',
};

function makeApi() {
  return new DaemonKimiWebApi({
    origin: 'http://test.local',
    identity,
  });
}

class FakeXhr {
  static instances: FakeXhr[] = [];
  upload = { onprogress: null as ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  timeout = 0;
  status = 200;
  statusText = 'OK';
  responseText = '';
  method = '';
  url = '';
  headers: Record<string, string> = {};
  aborted = false;
  sent = false;
  static responseBody = '';
  static progressEvents: Array<{ loaded: number; total: number }> = [];

  constructor() {
    FakeXhr.instances.push(this);
  }
  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }
  send(): void {
    this.sent = true;
    queueMicrotask(() => {
      if (this.aborted) return;
      for (const event of FakeXhr.progressEvents) {
        this.upload.onprogress?.({ lengthComputable: true, ...event });
      }
      this.responseText = FakeXhr.responseBody;
      this.onload?.();
    });
  }
  abort(): void {
    this.aborted = true;
    if (this.sent) this.onabort?.();
  }
}

function stubXhr(response: unknown, progress: Array<{ loaded: number; total: number }> = []): void {
  FakeXhr.instances = [];
  FakeXhr.progressEvents = progress;
  FakeXhr.responseBody = JSON.stringify(response);
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('uploadFile transport', () => {
  it('with a progress consumer: takes the XHR path and forwards byte progress', async () => {
    stubXhr(
      { code: 0, msg: '', data: { id: 'f_1', name: 'a.png', media_type: 'image/png', size: 100 }, request_id: 'req_t' },
      [
        { loaded: 40, total: 100 },
        { loaded: 100, total: 100 },
      ],
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const seen: Array<[number, number]> = [];

    const result = await makeApi().uploadFile({
      file: new Blob(['x']),
      name: 'a.png',
      onProgress: (loaded, total) => seen.push([loaded, total]),
    });

    expect(FakeXhr.instances).toHaveLength(1);
    expect(FakeXhr.instances[0]!.method).toBe('POST');
    expect(FakeXhr.instances[0]!.url).toBe('http://test.local/api/v1/files');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(seen).toEqual([
      [40, 100],
      [100, 100],
    ]);
    expect(result).toEqual({ id: 'f_1', name: 'a.png', mediaType: 'image/png', size: 100 });
  });

  it('without a progress consumer: keeps the fetch path (no XHR constructed)', async () => {
    stubXhr({ code: 0, msg: '', data: {}, request_id: 'req_t' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ code: 0, msg: '', data: { id: 'f_2', name: 'b.pdf', media_type: 'application/pdf', size: 7 }, request_id: 'req_t' }), { status: 200 }),
      ),
    );

    const result = await makeApi().uploadFile({ file: new Blob(['x']), name: 'b.pdf' });

    expect(FakeXhr.instances).toHaveLength(0);
    expect(result.id).toBe('f_2');
  });

  it('raises DaemonApiError with the envelope code on the XHR path too', async () => {
    stubXhr({ code: 41301, msg: 'file too large', data: null, request_id: 'req_t' });
    await expect(makeApi().uploadFile({ file: new Blob(['x']), onProgress: () => {} })).rejects.toMatchObject({
      code: 41301,
      message: 'file too large',
    });
    await expect(makeApi().uploadFile({ file: new Blob(['x']), onProgress: () => {} })).rejects.toBeInstanceOf(DaemonApiError);
  });

  it('aborts an in-flight XHR upload through AbortSignal', async () => {
    stubXhr({ code: 0, msg: '', data: {}, request_id: 'req_t' });
    const controller = new AbortController();
    const upload = makeApi().uploadFile({
      file: new Blob(['x']),
      onProgress: () => {},
      signal: controller.signal,
    });

    controller.abort();

    await expect(upload).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeXhr.instances[0]!.aborted).toBe(true);
  });
});

describe('bounded media previews', () => {
  it.each(['file', 'session'] as const)('requests only a prefix through the %s media endpoint', async (kind) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), {
      status: 206,
      headers: { 'content-type': 'video/mp4', 'content-length': '3', 'content-range': 'bytes 0-2/10000000' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const options = { prefixBytes: 3, signal: controller.signal };
    const api = makeApi();
    const blob = kind === 'file'
      ? await api.getFileBlob('f_1', options)
      : await api.getSessionMediaBlob('s_1', 'f_1', options);

    expect(blob.size).toBe(3);
    expect(blob.type).toBe('video/mp4');
    const [url, request] = fetchMock.mock.calls[0]!;
    expect(url).toContain(kind === 'file' ? '/files/f_1' : '/sessions/s_1/media/f_1');
    expect(request.headers.Range).toBe('bytes=0-2');
    controller.abort();
    expect(request.signal.aborted).toBe(true);
  });

  it('cancels a response that ignores Range and advertises the full file', async () => {
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }), {
      status: 200, headers: { 'content-length': '10000000' },
    })));
    await expect(makeApi().getFileBlob('video', { prefixBytes: 3 }))
      .rejects.toMatchObject({ name: 'FileTooLargeError', limit: 3 });
    expect(cancel).toHaveBeenCalled();
  });

  it('enforces the cap on a chunked response without Content-Length', async () => {
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
      },
      cancel,
    }), { status: 206 })));
    await expect(makeApi().getFileBlob('video', { prefixBytes: 3 }))
      .rejects.toMatchObject({ name: 'FileTooLargeError', limit: 3 });
    expect(cancel).toHaveBeenCalled();
  });
});

 it('rejects an already-aborted upload without sending the XHR', async () => {
  stubXhr({ code: 0, data: {} });
  const controller = new AbortController();
  controller.abort();
  await expect(makeApi().uploadFile({ file: new Blob(['video']), onProgress: () => {}, signal: controller.signal }))
    .rejects.toMatchObject({ name: 'AbortError' });
  expect(FakeXhr.instances[0]?.sent).toBe(false);
});
