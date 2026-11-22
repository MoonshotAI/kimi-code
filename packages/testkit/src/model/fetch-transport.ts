import type { PlaybackSink } from '#/model/playback';
import { connectionReset, CRASH_STATUS, crashBody, type RequestHandler } from '#/model/transport';

const encoder = new TextEncoder();

export function createFetchTransport(handler: RequestHandler): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const body = await request.text();
    request.signal.throwIfAborted();
    const url = new URL(request.url);
    return new Promise<Response>((resolve, reject) => {
      const sink = new FetchSink(resolve, reject, request.signal);
      void handler(
        { method: request.method, path: `${url.pathname}${url.search}`, headers: Object.fromEntries(request.headers), body },
        sink,
      ).catch((error: unknown) => sink.crash(error));
    });
  };
}

const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

class FetchSink implements PlaybackSink {
  private controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  private responded = false;
  private finished = false;
  private readonly goneController = new AbortController();
  private readonly onAbort = (): void => this.stop(this.signal.reason);

  constructor(
    private readonly resolve: (response: Response) => void,
    private readonly reject: (reason: unknown) => void,
    private readonly signal: AbortSignal,
  ) {
    signal.addEventListener('abort', this.onAbort, { once: true });
  }

  get headSent(): boolean {
    return this.responded;
  }

  get gone(): boolean {
    return this.goneController.signal.aborted;
  }

  get goneSignal(): AbortSignal {
    return this.goneController.signal;
  }

  head(status: number, headers: Readonly<Record<string, string>>): void {
    if (this.responded || this.gone) return;
    const body = NULL_BODY_STATUSES.has(status)
      ? null
      : new ReadableStream<Uint8Array>({
          start: (controller) => {
            this.controller = controller;
          },
          cancel: (reason: unknown) => this.stop(reason),
        });
    const response = new Response(body, { status, headers });
    this.responded = true;
    this.resolve(response);
  }

  write(data: string | Uint8Array): void {
    if (this.finished || this.gone) return;
    this.controller?.enqueue(typeof data === 'string' ? encoder.encode(data) : data);
  }

  end(): void {
    if (this.finished) return;
    this.finished = true;
    this.signal.removeEventListener('abort', this.onAbort);
    if (!this.gone) this.controller?.close();
  }

  disconnect(): void {
    this.stop(new TypeError(this.responded ? 'terminated' : 'fetch failed', { cause: connectionReset() }));
  }

  resetConnection(): void {
    this.disconnect();
  }

  crash(error: unknown): void {
    if (this.finished || this.gone) return;
    if (this.responded) {
      this.stop(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    this.head(CRASH_STATUS, { 'content-type': 'application/json' });
    this.write(crashBody(error));
    this.end();
  }

  private stop(reason: unknown): void {
    if (this.finished) return;
    this.finished = true;
    this.signal.removeEventListener('abort', this.onAbort);
    this.goneController.abort(reason);
    if (this.responded) this.controller?.error(reason);
    else this.reject(reason);
  }
}
