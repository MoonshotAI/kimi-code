import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface DownloadAuthRoutes {
  readonly origin: string;
  readonly url: (path: string) => string;
  readonly streamedBytes: () => number;
  readonly close: () => Promise<void>;
}

const STREAM_CHUNK = Buffer.alloc(512 * 1024, 'x');

function attachment(response: ServerResponse, name: string, body: string): void {
  response.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="${name}"`,
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
  }).end(body);
}

export async function startDownloadAuthRoutes(): Promise<DownloadAuthRoutes> {
  let streamed = 0;
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path === '/files/report.csv') return attachment(response, 'report.csv', 'month,total\njanuary,42\n');
    if (path === '/files/own-report.csv') return attachment(response, 'own-report.csv', 'month,total\nfebruary,7\n');
    if (path === '/files/archive.bin') {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="archive.bin"', 'cache-control': 'no-store' });
      const timer = setInterval(() => {
        streamed += STREAM_CHUNK.length;
        response.write(STREAM_CHUNK);
      }, 5);
      response.on('close', () => clearInterval(timer));
      return;
    }
    if (path === '/members') {
      response.writeHead(401, { 'www-authenticate': 'Basic realm="Members area"', 'content-type': 'text/html; charset=utf-8' })
        .end('<!doctype html><title>Members area</title><style>html{background:#fff;color:#111}</style><h1>401 Members only</h1>');
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    url: path => `${origin}${path}`,
    streamedBytes: () => streamed,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
