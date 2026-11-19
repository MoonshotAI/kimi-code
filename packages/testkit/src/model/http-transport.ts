import { createServer, validateHeaderName, validateHeaderValue, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { TestkitError } from '#/errors';
import type { PlaybackSink } from '#/model/playback';
import { CRASH_STATUS, crashBody, type RequestHandler } from '#/model/transport';

export interface HttpEndpoint {
  readonly origin: string;
  close(): Promise<void>;
}

export async function serveHttp(handler: RequestHandler): Promise<HttpEndpoint> {
  const server = createServer((request, response) => {
    void dispatch(handler, request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function dispatch(handler: RequestHandler, request: IncomingMessage, response: ServerResponse): Promise<void> {
  let body: string;
  try {
    body = await readBody(request);
  } catch {
    response.destroy();
    return;
  }
  const sink = new HttpSink(request, response);
  try {
    await handler({ method: request.method ?? 'GET', path: request.url ?? '/', headers: headersOf(request), body }, sink);
  } catch (error) {
    sink.crash(error);
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function headersOf(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return headers;
}

class HttpSink implements PlaybackSink {
  private readonly goneController = new AbortController();

  constructor(
    private readonly request: IncomingMessage,
    private readonly response: ServerResponse,
  ) {
    response.on('close', () => {
      if (!response.writableFinished) this.goneController.abort();
    });
  }

  get headSent(): boolean {
    return this.response.headersSent;
  }

  get gone(): boolean {
    return this.goneController.signal.aborted || this.response.destroyed;
  }

  get goneSignal(): AbortSignal {
    return this.goneController.signal;
  }

  head(status: number, headers: Readonly<Record<string, string>>): void {
    if (this.response.headersSent || this.gone) return;
    if (!Number.isInteger(status) || status < 100 || status > 999) throw new TestkitError(`HTTP status ${status} is out of range`);
    for (const [name, value] of Object.entries(headers)) {
      validateHeaderName(name);
      validateHeaderValue(name, value);
    }
    this.response.writeHead(status, headers);
    this.response.flushHeaders();
  }

  write(data: string): void {
    if (this.gone || this.response.writableEnded) return;
    this.response.write(data);
  }

  end(): void {
    if (this.gone || this.response.writableEnded) return;
    this.response.end();
  }

  disconnect(): void {
    this.response.destroy();
  }

  resetConnection(): void {
    this.request.socket.destroy();
  }

  crash(error: unknown): void {
    if (this.gone || this.response.writableEnded) return;
    if (this.response.headersSent) {
      this.response.destroy(error instanceof Error ? error : undefined);
      return;
    }
    this.response.writeHead(CRASH_STATUS, { 'content-type': 'application/json' });
    this.response.end(crashBody(error));
  }
}
