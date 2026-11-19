import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PAGES_DIR = fileURLToPath(new URL('../pages/', import.meta.url));

export interface FixtureRequest {
  readonly method: string;
  readonly path: string;
}

export interface FixturePages {
  readonly origin: string;
  readonly requests: () => readonly FixtureRequest[];
  readonly url: (name: string) => string;
  readonly close: () => Promise<void>;
}

export async function startFixturePages(): Promise<FixturePages> {
  const requests: FixtureRequest[] = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    requests.push({ method: request.method ?? 'GET', path });
    const name = basename(path);
    if (!name.endsWith('.html')) {
      response.writeHead(404).end();
      return;
    }
    readFile(join(PAGES_DIR, name)).then(
      body => response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(body),
      () => response.writeHead(404).end(),
    );
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    requests: () => [...requests],
    url: name => `${origin}/${name}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
