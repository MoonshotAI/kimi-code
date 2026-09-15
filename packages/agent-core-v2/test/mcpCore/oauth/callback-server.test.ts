import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo as HttpAddress } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  type CallbackServer,
  OAuthCallbackClosedError,
  startCallbackServer,
} from '#/mcpCore/oauth/callback-server';
import { McpOAuthService } from '#/mcpCore/oauth/service';

import { createMemoryMcpOAuthStore } from '../stubs';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

function trackServer(server: CallbackServer): void {
  cleanups.push(() => server.close());
}

async function startRegistrationServer(): Promise<{ readonly url: string }> {
  const httpServer: HttpServer = createHttpServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/register') {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf-8');
    });
    req.on('end', () => {
      const metadata = JSON.parse(body) as Record<string, unknown>;
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...metadata, client_id: 'test-client' }));
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      }),
  );
  const port = (httpServer.address() as HttpAddress).port;
  return { url: `http://127.0.0.1:${port}` };
}

describe('startCallbackServer', () => {
  it('resolves a late waitForCode with a callback that arrived before it', async () => {
    const server = await startCallbackServer();
    trackServer(server);

    const response = await fetch(`${server.redirectUri}?code=early-code&state=early-state`);
    expect(response.status).toBe(200);

    await expect(server.waitForCode({ timeoutMs: 10_000 })).resolves.toEqual({
      code: 'early-code',
      state: 'early-state',
    });
  });

  it('delivers the callback payload to a pending wait', async () => {
    const server = await startCallbackServer();
    trackServer(server);
    const pending = server.waitForCode({ timeoutMs: 10_000 });

    await fetch(`${server.redirectUri}?code=code-1&state=state-1`);

    await expect(pending).resolves.toEqual({ code: 'code-1', state: 'state-1' });
  });

  it('rejects a pending wait with a closed error when explicitly closed', async () => {
    const server = await startCallbackServer();
    trackServer(server);
    const pending = server.waitForCode({ timeoutMs: 10_000 });
    const rejection = expect(pending).rejects.toBeInstanceOf(OAuthCallbackClosedError);

    await server.close();

    await rejection;
  });

  it('rejects a late waitForCode after close', async () => {
    const server = await startCallbackServer();
    trackServer(server);

    await server.close();

    await expect(server.waitForCode({ timeoutMs: 10_000 })).rejects.toBeInstanceOf(
      OAuthCallbackClosedError,
    );
  });
});

describe('McpOAuthService cancellation', () => {
  it('rejects an in-flight completion when the authorization flow is cancelled', async () => {
    const service = new McpOAuthService({ store: createMemoryMcpOAuthStore() });
    cleanups.push(() => service.dispose());
    const registrationServer = await startRegistrationServer();
    const provider = service.getProvider('example', 'https://mcp.example.test/rpc');
    await provider.ready;
    await provider.saveDiscoveryState({
      authorizationServerUrl: registrationServer.url,
      authorizationServerMetadata: {
        issuer: registrationServer.url,
        authorization_endpoint: `${registrationServer.url}/authorize`,
        token_endpoint: `${registrationServer.url}/token`,
        registration_endpoint: `${registrationServer.url}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        token_endpoint_auth_methods_supported: ['none'],
      },
    });

    const flow = await service.beginAuthorization('example', 'https://mcp.example.test/rpc');
    const completion = flow.complete({ timeoutMs: 10_000 });
    const rejection = expect(completion).rejects.toThrow('OAuth callback listener closed');

    await flow.cancel();

    await rejection;
  }, 15000);
});
