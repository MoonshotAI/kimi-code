import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type McpAuthStatusServerMode =
  | 'rfc9728'
  | 'challenge'
  | 'unsupported'
  | 'error'
  | 'slow-redirect'
  | 'mismatch'
  | 'redirect';

export interface RecordedMcpAuthRequest {
  readonly side: 'resource' | 'authorization';
  readonly path: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

export interface McpAuthStatusTestServer {
  readonly url: string;
  readonly requests: RecordedMcpAuthRequest[];
  readonly close: () => Promise<void>;
}

export async function startMcpAuthStatusTestServer(options: {
  readonly mode: McpAuthStatusServerMode;
  readonly requiredResourceHeader?: readonly [name: string, value: string];
}): Promise<McpAuthStatusTestServer> {
  const requests: RecordedMcpAuthRequest[] = [];
  const authorizationServer = createServer((request, response) => {
    requests.push(recordRequest('authorization', request));
    void handleAuthorizationRequest(request, response, authorizationBase);
  });
  await listen(authorizationServer);
  const authorizationBase = serverBaseUrl(authorizationServer);

  let resourceBase = '';
  const resourceServer = createServer((request, response) => {
    requests.push(recordRequest('resource', request));
    void handleResourceRequest(
      request,
      response,
      options,
      resourceBase,
      authorizationBase,
    );
  });
  await listen(resourceServer);
  resourceBase = serverBaseUrl(resourceServer);

  return {
    url: `${resourceBase}/mcp`,
    requests,
    async close() {
      resourceServer.closeAllConnections();
      authorizationServer.closeAllConnections();
      await Promise.all([closeServer(resourceServer), closeServer(authorizationServer)]);
    },
  };
}

async function handleResourceRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: {
    readonly mode: McpAuthStatusServerMode;
    readonly requiredResourceHeader?: readonly [name: string, value: string];
  },
  resourceBase: string,
  authorizationBase: string,
): Promise<void> {
  const path = new URL(request.url ?? '/', resourceBase).pathname;
  const requiredHeader = options.requiredResourceHeader;
  if (
    requiredHeader !== undefined &&
    request.headers[requiredHeader[0].toLowerCase()] !== requiredHeader[1]
  ) {
    response.writeHead(403).end('missing resource header');
    return;
  }

  if (options.mode === 'slow-redirect' && path === '/.well-known/oauth-protected-resource/mcp') {
    await delay(20);
    response.writeHead(302, { location: `${resourceBase}/slow-resource-metadata` }).end();
    return;
  }
  if (options.mode === 'slow-redirect' && path === '/slow-resource-metadata') {
    await delay(70);
    sendJson(response, {
      resource: `${resourceBase}/mcp`,
      authorization_servers: [`${authorizationBase}/issuer`],
    });
    return;
  }
  if (options.mode === 'error' && path === '/.well-known/oauth-protected-resource/mcp') {
    response.writeHead(500).end('metadata failure');
    return;
  }
  if (options.mode === 'redirect' && path === '/.well-known/oauth-protected-resource/mcp') {
    response.writeHead(302, { location: `${authorizationBase}/redirect-target` }).end();
    return;
  }
  if (
    (options.mode === 'rfc9728' || options.mode === 'mismatch') &&
    path === '/.well-known/oauth-protected-resource/mcp'
  ) {
    sendJson(response, {
      resource: options.mode === 'mismatch' ? `${resourceBase}/different` : `${resourceBase}/mcp`,
      authorization_servers: [`${authorizationBase}/issuer`],
    });
    return;
  }
  if (options.mode === 'challenge' && path === '/mcp') {
    response
      .writeHead(401, {
        'www-authenticate': `Bearer resource_metadata="${resourceBase}/resource-metadata"`,
      })
      .end('authorization required');
    return;
  }
  if (options.mode === 'challenge' && path === '/resource-metadata') {
    sendJson(response, {
      resource: `${resourceBase}/mcp`,
      authorization_servers: [`${authorizationBase}/issuer`],
    });
    return;
  }
  if (path === '/mcp') {
    response.writeHead(405).end();
    return;
  }
  response.writeHead(404).end();
}

async function handleAuthorizationRequest(
  request: IncomingMessage,
  response: ServerResponse,
  authorizationBase: string,
): Promise<void> {
  const path = new URL(request.url ?? '/', authorizationBase).pathname;
  if (path === '/.well-known/oauth-authorization-server/issuer') {
    sendJson(response, {
      issuer: `${authorizationBase}/issuer`,
      authorization_endpoint: `${authorizationBase}/authorize`,
      token_endpoint: `${authorizationBase}/token`,
      registration_endpoint: `${authorizationBase}/register`,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
    });
    return;
  }
  if (path === '/register' && request.method === 'POST') {
    const body = JSON.parse(await readBody(request)) as { readonly redirect_uris?: string[] };
    sendJson(response, {
      client_id: 'test-client',
      redirect_uris: body.redirect_uris ?? [],
      token_endpoint_auth_method: 'none',
    });
    return;
  }
  if (path === '/redirect-target') {
    sendJson(response, { reached: true });
    return;
  }
  response.writeHead(404).end();
}

function recordRequest(
  side: RecordedMcpAuthRequest['side'],
  request: IncomingMessage,
): RecordedMcpAuthRequest {
  return {
    side,
    path: new URL(request.url ?? '/', 'http://127.0.0.1').pathname,
    headers: { ...request.headers },
  };
}

function sendJson(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function serverBaseUrl(server: Server): string {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
