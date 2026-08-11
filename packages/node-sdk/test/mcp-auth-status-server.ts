import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface McpAuthStatusServer {
  readonly plainUrl: string;
  readonly oauthUrl: string;
  close(): Promise<void>;
}

export async function startMcpAuthStatusServer(): Promise<McpAuthStatusServer> {
  const server = createServer((request, response) => {
    if (request.url === '/oauth') {
      response.writeHead(401).end('Unauthorized');
      return;
    }
    response.writeHead(404).end('Not found');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    plainUrl: `${baseUrl}/plain`,
    oauthUrl: `${baseUrl}/oauth`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      }),
  };
}
