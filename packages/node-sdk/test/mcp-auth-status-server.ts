import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

export interface McpAuthStatusServer {
  readonly authToken: string;
  readonly refreshToken: string;
  readonly plainUrl: string;
  readonly oauthUrl: string;
  readonly unavailableUrl: string;
  requestCount(pathname: string): number;
  close(): Promise<void>;
}

/** The one refresh token the `/token` endpoint honors. */
const REFRESH_TOKEN = 'valid-test-refresh-token';

export async function startMcpAuthStatusServer(): Promise<McpAuthStatusServer> {
  const authToken = 'valid-test-access-token';
  let baseUrl = '';
  const requestCounts = new Map<string, number>();
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', baseUrl).pathname;
    requestCounts.set(pathname, (requestCounts.get(pathname) ?? 0) + 1);
    void handleRequest(request, response, baseUrl, authToken).catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500);
      response.end(String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  return {
    authToken,
    refreshToken: REFRESH_TOKEN,
    plainUrl: `${baseUrl}/plain`,
    oauthUrl: `${baseUrl}/oauth`,
    unavailableUrl: `${baseUrl}/unavailable`,
    requestCount: (pathname) => requestCounts.get(pathname) ?? 0,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      }),
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  baseUrl: string,
  authToken: string,
): Promise<void> {
  const url = new URL(request.url ?? '/', baseUrl);
  if (url.pathname === '/unavailable') {
    response.writeHead(503).end('Temporarily unavailable');
    return;
  }
  if (url.pathname === '/token' && request.method === 'POST') {
    // Token endpoint: a valid refresh grant rotates into a fresh access
    // token; anything else is rejected, so probes of stale credentials still
    // land on needs-auth.
    const rawBody = await readBody(request);
    const params = new URLSearchParams(rawBody);
    if (
      params.get('grant_type') === 'refresh_token' &&
      params.get('refresh_token') === REFRESH_TOKEN
    ) {
      sendJson(response, {
        access_token: authToken,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: REFRESH_TOKEN,
      });
      return;
    }
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'invalid_grant' }));
    return;
  }
  if (url.pathname === '/.well-known/oauth-protected-resource') {
    sendJson(response, {
      resource: `${baseUrl}/oauth`,
      authorization_servers: [baseUrl],
    });
    return;
  }
  if (
    url.pathname === '/.well-known/oauth-authorization-server' ||
    url.pathname === '/.well-known/openid-configuration'
  ) {
    sendJson(response, {
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/token`,
      registration_endpoint: `${baseUrl}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
    return;
  }
  if (url.pathname === '/register' && request.method === 'POST') {
    const metadata = await readJson(request);
    sendJson(response, { client_id: 'test-client', ...metadata }, 201);
    return;
  }
  if (url.pathname === '/oauth' && request.headers.authorization !== `Bearer ${authToken}`) {
    response.writeHead(401, {
      'content-type': 'application/json',
      'www-authenticate': `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
    });
    response.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }
  if (request.method !== 'POST') {
    response.writeHead(405).end('Method not allowed');
    return;
  }
  const message = (await readJson(request)) as {
    readonly id?: string | number;
    readonly method?: string;
  };
  if (message.id === undefined) {
    response.writeHead(202).end();
    return;
  }
  const result =
    message.method === 'initialize'
      ? {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'auth-status', version: '0.0.1' },
        }
      : message.method === 'tools/list'
        ? { tools: [] }
        : {};
  sendJson(response, { jsonrpc: '2.0', id: message.id, result });
}

async function readBody(request: AsyncIterable<unknown>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(request: AsyncIterable<unknown>): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function sendJson(
  response: ServerResponse,
  body: unknown,
  status = 200,
): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}
