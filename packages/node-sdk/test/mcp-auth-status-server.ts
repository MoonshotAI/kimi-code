import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface McpAuthStatusServer {
  readonly plainUrl: string;
  readonly oauthUrl: string;
  readonly authorizedUrl: string;
  readonly unavailableUrl: string;
  close(): Promise<void>;
}

export async function startMcpAuthStatusServer(): Promise<McpAuthStatusServer> {
  const server = createServer((request, response) => {
    if (request.url === '/oauth') {
      response.writeHead(401).end('Unauthorized');
      return;
    }
    if (request.url === '/unavailable') {
      response.writeHead(503).end('Unavailable');
      return;
    }
    if (request.url === '/authorized') {
      if (request.headers.authorization !== 'Bearer test-access-token') {
        response.writeHead(401).end('Unauthorized');
        return;
      }
      void handleMcpRequest(request, response);
      return;
    }
    if (request.url === '/plain') {
      void handleMcpRequest(request, response);
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
    authorizedUrl: `${baseUrl}/authorized`,
    unavailableUrl: `${baseUrl}/unavailable`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      }),
  };
}

async function handleMcpRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method !== 'POST') {
    response.writeHead(405).end('Method not allowed');
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const message = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
    readonly id?: string | number;
    readonly method?: string;
    readonly params?: { readonly protocolVersion?: string };
  };
  if (message.id === undefined) {
    response.writeHead(202).end();
    return;
  }

  let result: unknown;
  if (message.method === 'initialize') {
    result = {
      protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'auth-status-fixture', version: '1.0.0' },
    };
  } else if (message.method === 'tools/list') {
    result = { tools: [] };
  } else {
    result = {};
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
}
