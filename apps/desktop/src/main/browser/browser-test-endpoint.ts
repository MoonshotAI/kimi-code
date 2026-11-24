import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DesktopBrowserHost } from './browser-host';

export interface BrowserTestEndpoint {
  readonly url: string;
  close(): Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function startBrowserTestEndpoint(host: DesktopBrowserHost, token: string): Promise<BrowserTestEndpoint> {
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/run') {
      response.writeHead(404).end('not found');
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end('unauthorized');
      return;
    }
    const abort = new AbortController();
    response.once('close', () => abort.abort());
    void readBody(request).then(async (body) => {
      const { sessionId, args } = body as { sessionId: string; args: unknown };
      const result = await host.run({ sessionId, args, signal: abort.signal });
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    }).catch((error: unknown) => {
      if (response.headersSent) return;
      response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(error) }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/run`,
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}
