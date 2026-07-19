import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createSecureServer } from 'node:http2';
import type { AddressInfo } from 'node:net';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Agent } from 'undici';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ErrorCodes, KimiError } from '../../src/errors';
import {
  buildMcpHttpHeaders,
  HttpMcpClient,
  isTerminalTransportError,
} from '../../src/mcp/client-http';
import { createMcpFetch } from '../../src/mcp/client-remote';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

function expectConfigInvalid(fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(KimiError);
    expect((error as KimiError).code).toBe(ErrorCodes.CONFIG_INVALID);
    return;
  }
  throw new Error('expected function to throw');
}

describe('buildMcpHttpHeaders', () => {
  it('returns undefined when no headers and no bearer are configured', () => {
    expect(
      buildMcpHttpHeaders({ transport: 'http', url: 'https://x' }, () => undefined),
    ).toBeUndefined();
  });

  it('passes through configured static headers', () => {
    expect(
      buildMcpHttpHeaders(
        { transport: 'http', url: 'https://x', headers: { 'X-Tenant': 'kimi' } },
        () => undefined,
      ),
    ).toEqual({ 'X-Tenant': 'kimi' });
  });

  it('injects Authorization Bearer when env lookup yields a token', () => {
    expect(
      buildMcpHttpHeaders(
        { transport: 'http', url: 'https://x', bearerTokenEnvVar: 'TOK' },
        (name) => (name === 'TOK' ? 'secret' : undefined),
      ),
    ).toEqual({ Authorization: 'Bearer secret' });
  });

  it('throws KimiError(config.invalid) when a configured bearer token env var is empty or missing', () => {
    expectConfigInvalid(() =>
      buildMcpHttpHeaders(
        { transport: 'http', url: 'https://x', bearerTokenEnvVar: 'MISSING' },
        () => undefined,
      ),
    );
    expect(() =>
      buildMcpHttpHeaders(
        { transport: 'http', url: 'https://x', bearerTokenEnvVar: 'MISSING' },
        () => undefined,
      ),
    ).toThrow(/"MISSING" is not set or is empty/);
    expectConfigInvalid(() =>
      buildMcpHttpHeaders(
        { transport: 'http', url: 'https://x', bearerTokenEnvVar: 'EMPTY' },
        () => '',
      ),
    );
    expect(() =>
      buildMcpHttpHeaders(
        { transport: 'http', url: 'https://x', bearerTokenEnvVar: 'EMPTY' },
        () => '',
      ),
    ).toThrow(/"EMPTY" is not set or is empty/);
  });

  it('merges bearer over the same Authorization key from static headers', () => {
    expect(
      buildMcpHttpHeaders(
        {
          transport: 'http',
          url: 'https://x',
          headers: { Authorization: 'Bearer stale', 'X-Trace': '1' },
          bearerTokenEnvVar: 'TOK',
        },
        () => 'fresh',
      ),
    ).toEqual({ Authorization: 'Bearer fresh', 'X-Trace': '1' });
  });

  it('flags errors the SDK uses to signal a dead HTTP transport as terminal', () => {
    const unauthorized = new Error('Unauthorized');
    unauthorized.name = 'UnauthorizedError';
    expect(isTerminalTransportError(unauthorized)).toBe(true);
    expect(isTerminalTransportError(new Error('Maximum reconnection attempts (3) exceeded.'))).toBe(
      true,
    );
  });

  it('does not flag transient SDK errors as terminal', () => {
    expect(isTerminalTransportError(new Error('SSE stream disconnected: ECONNRESET'))).toBe(false);
    expect(isTerminalTransportError(new Error('fetch failed'))).toBe(false);
    expect(isTerminalTransportError(new Error('Connection closed'))).toBe(false);
  });

  it('strips case-variant authorization headers before injecting the bearer', () => {
    expect(
      buildMcpHttpHeaders(
        {
          transport: 'http',
          url: 'https://x',
          headers: { authorization: 'Bearer stale', AUTHORIZATION: 'Bearer older', 'X-Trace': '1' },
          bearerTokenEnvVar: 'TOK',
        },
        () => 'fresh',
      ),
    ).toEqual({ Authorization: 'Bearer fresh', 'X-Trace': '1' });
  });
});

async function startInProcessHttpMcpServer(opts?: {
  authToken?: string;
}): Promise<{ url: string; close: () => Promise<void> }> {
  const mcpServer = new McpServer({ name: 'mock-http', version: '0.0.1' });
  mcpServer.registerTool(
    'echo',
    { description: 'Echoes text', inputSchema: { text: z.string() } },
    ({ text }) => ({ content: [{ type: 'text', text }] }),
  );

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await mcpServer.connect(transport);

  const httpServer: Server = createServer((req, res) => {
    if (opts?.authToken !== undefined) {
      const auth = req.headers['authorization'];
      if (auth !== `Bearer ${opts.authToken}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
    }
    void transport.handleRequest(req, res);
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  const port = (httpServer.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    async close() {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
    },
  };
}

describe('HttpMcpClient', () => {
  it('connects, lists tools, and round-trips a call over real HTTP', async () => {
    const server = await startInProcessHttpMcpServer();
    cleanups.push(server.close);

    const client = new HttpMcpClient({ transport: 'http', url: server.url });
    try {
      await client.connect();
      const tools = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(['echo']);

      const result = await client.callTool('echo', { text: 'hello http' });
      expect(result.isError).toBe(false);
      expect(result.content).toEqual([{ type: 'text', text: 'hello http' }]);
    } finally {
      await client.close();
    }
  }, 15000);

  it('flips to unexpected-close when the SDK signals a terminal transport error', async () => {
    const server = await startInProcessHttpMcpServer();
    cleanups.push(server.close);

    const client = new HttpMcpClient({ transport: 'http', url: server.url });
    const closes: Array<{ error?: string }> = [];
    client.onUnexpectedClose((reason) => {
      closes.push({ error: reason.error?.message });
    });
    try {
      await client.connect();
      // The SDK normally calls `Client.onerror` from its own retry loop
      // (e.g. "Maximum reconnection attempts (3) exceeded.") — there is no
      // matching `onclose` for HTTP. Simulate that path directly to exercise
      // the terminal-error branch without rigging an SSE reconnect storm.
      const internal = (client as unknown as {
        client: { onerror?: (error: Error) => void };
      }).client;
      internal.onerror?.(new Error('Maximum reconnection attempts (3) exceeded.'));
      // Listener may fire in a later microtask; give it a chance.
      await new Promise((r) => setTimeout(r, 25));
      expect(closes).toHaveLength(1);
      expect(closes[0]?.error).toContain('Maximum reconnection attempts');
    } finally {
      await client.close();
    }
  }, 15000);

  it('ignores transient SDK errors that the transport recovers from', async () => {
    const server = await startInProcessHttpMcpServer();
    cleanups.push(server.close);

    const client = new HttpMcpClient({ transport: 'http', url: server.url });
    const closes: number[] = [];
    client.onUnexpectedClose(() => closes.push(Date.now()));
    try {
      await client.connect();
      const internal = (client as unknown as {
        client: { onerror?: (error: Error) => void };
      }).client;
      // SSE flap that the SDK will retry on its own — should NOT flip the
      // entry to failed; otherwise a brief network blip would tear down every
      // HTTP MCP connection.
      internal.onerror?.(new Error('SSE stream disconnected: ECONNRESET'));
      internal.onerror?.(new Error('fetch failed'));
      await new Promise((r) => setTimeout(r, 25));
      expect(closes).toEqual([]);
    } finally {
      await client.close();
    }
  }, 15000);

  it('forwards bearer token from envLookup', async () => {
    const server = await startInProcessHttpMcpServer({ authToken: 'good-token' });
    cleanups.push(server.close);

    const client = new HttpMcpClient(
      {
        transport: 'http',
        url: server.url,
        bearerTokenEnvVar: 'EXAMPLE_TOKEN',
      },
      { envLookup: (name) => (name === 'EXAMPLE_TOKEN' ? 'good-token' : undefined) },
    );
    try {
      await client.connect();
      const tools = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(['echo']);
    } finally {
      await client.close();
    }
  }, 15000);
});

describe('HTTP/1.1 pinning (createMcpFetch)', () => {
  // Reproduces the failure mode of Cloudflare-hosted MCP servers (observed
  // with Cloudflare's own docs endpoint): an HTTP/2 server that answers
  // `initialize` and holds the standalone SSE GET stream open, but never
  // answers POSTs that arrive while that GET stream is open on the same H2
  // connection. Over H2 the handshake connects but `listTools` hangs; the
  // H1.1-pinned fetch puts the requests on separate connections and succeeds.
  it('hangs over HTTP/2 and succeeds over the pinned HTTP/1.1 fetch', async () => {
    const server = await startStallingH2McpServer();
    cleanups.push(server.close);

    const config = { transport: 'http' as const, url: server.url };

    // Baseline: an H2-capable agent hits the same stall as Node's global fetch.
    const h2Agent = new Agent({ allowH2: true, connect: { rejectUnauthorized: false } });
    cleanups.push(() => h2Agent.destroy());
    const h2Client = new HttpMcpClient(config, { fetch: createMcpFetch(h2Agent) });
    try {
      await h2Client.connect();
      const stalled = await Promise.race([
        h2Client.listTools().then(() => 'resolved' as const),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 3000)),
      ]);
      expect(stalled).toBe('timeout');
    } finally {
      await h2Client.close();
    }

    // The H1.1-pinned default fetch avoids the stall.
    const h1Agent = new Agent({ allowH2: false, connect: { rejectUnauthorized: false } });
    cleanups.push(() => h1Agent.destroy());
    const h1Client = new HttpMcpClient(config, { fetch: createMcpFetch(h1Agent) });
    try {
      await h1Client.connect();
      const tools = await h1Client.listTools();
      expect(tools.map((t) => t.name)).toEqual(['echo']);
    } finally {
      await h1Client.close();
    }
  }, 30000);
});

const H2_STALL_TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUDoSXEvr8xtqEm9NGkEfpabMw8CUwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDcxOTA3NTQyOVoXDTM2MDcx
NjA3NTQyOVowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEApdJUKNqaXWXo9dEEwEky2BNqbzzv20scyB/Tp1KaQvGn
n9L9ZVlEUM3HLRu1GcOp7OS6lu97PC3SZypHbUOQrw+iN540hef0jpXGUquxW2/R
NTbdaG7XHyBTOBOtPipRT83ikYPtBh0nBgD/s41y5LSyetMsQ9T5IkJ3IIGUxim1
heNifKujm0belDADGJ48iwqQv6d14nHHePIZESZ73E1QLw4D0TNQG0ei+gj3OnLz
DzgizEUzw8UVEsjOkdpbUc/JRpN5Fsn1qG3lRu37Ob4lbs0ymEZSmbj6h0Nx9TSF
9ldRg5vq5eq/X+duMh9rXambe4BRmYPSiNXlFjD2MQIDAQABo28wbTAdBgNVHQ4E
FgQUoC+OxUv9E65b/9G8bU/+w6DE1dQwHwYDVR0jBBgwFoAUoC+OxUv9E65b/9G8
bU/+w6DE1dQwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SH
BH8AAAEwDQYJKoZIhvcNAQELBQADggEBAGy3Obij9yhEYTi7wo7x2SqSrIiHJFhl
NKXmGE8UqXitWsOWZ3cwHEPdofRYwXLmtkGuWYG1QLuuQN36wD/6jgAUGcuR2Ezk
ZKe5Xq6/kxCst+RXzWGIe5ktz349/Jc+u52p73y4dJxAImdEjLm30HI7k6oKAN/2
Vb8qBFwCWImPICiUhMW+e9O9f4mFI/A5BbNeeI4zrpZoSDb9FhLPmkdE2T/PNcTQ
bClPGKoWApLJGNFEpPVX9/N+vwxAOAxiKqVq13gCrXgWHCeVwdfaRG8xzuBJ0Ysg
CgFL/dPQMJBQhBYBpsFuz7M4z9Q5zUFRPxkzxs4JgSdZ/YZ7cI0g2+0=
-----END CERTIFICATE-----`;

const H2_STALL_TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCl0lQo2ppdZej1
0QTASTLYE2pvPO/bSxzIH9OnUppC8aef0v1lWURQzcctG7UZw6ns5LqW73s8LdJn
KkdtQ5CvD6I3njSF5/SOlcZSq7Fbb9E1Nt1obtcfIFM4E60+KlFPzeKRg+0GHScG
AP+zjXLktLJ60yxD1PkiQncggZTGKbWF42J8q6ObRt6UMAMYnjyLCpC/p3Xiccd4
8hkRJnvcTVAvDgPRM1AbR6L6CPc6cvMPOCLMRTPDxRUSyM6R2ltRz8lGk3kWyfWo
beVG7fs5viVuzTKYRlKZuPqHQ3H1NIX2V1GDm+rl6r9f524yH2tdqZt7gFGZg9KI
1eUWMPYxAgMBAAECggEAB1MgYRKbnX242eeS+7xwA2/uHxOfGRMlu72o1NwMUOHe
+0DFF92RgTaUcldmO0kI6pwwQCZmzZciPhOLHADkn/sDOcziTzpFCP8Fh5V/zC/H
BcBSl5WdKTSSwH12r7I2V8ha1lMwcePxRe20MytPydmlMFGU2Q/hYQ70Yf+fVwEi
mzIuSZpPoqUfETeCtqQ1/ZDb3fe9Y11bLnTGymOEXcjJajCHUNomscK9rTwo6+NI
gxZpi/koZpR0QzRbBpEQs/alw3pR8HY1jk+rQS0u70vFm5YbrduKerD7QMbJbtnY
9TfTWg8sSwyrImLS4makPQMIjeiW6nI8RVhVQ3vovQKBgQDVWa0owcyN+/sRMRIU
njfNMZAk2+DdfyGldFuYntb19rlJ0aQYzH+/qNGSpZCwXffyI6ZqemNMOgDxPwGv
nBPDNpKSWRrDEJvNDMOadP832UwyfIgxLQwvL7HUX6Nccz0iS0a7ONE8FKV6PIPn
lO1HF215ZLNiwUJ+AFsHjLLuHQKBgQDG+FgFtSEi0SunVP2WNe6OJKlVJDmcw241
xPNrt4wCYXxd4lKurqV4W4TjjJnd3/Z4JNAS8S/yzoqXvwA4NOKgAPG0ORv/o9jG
7U+snbwGBMLIiMCfh2cAgBKintsoz23aHZZRXtdbNWCyZan+/ih0HSZDRUA32UBc
QZ91crD8JQKBgEEzEpPuBdEuPF/Ymynp4Cu5Bc/90g5el620jXlqsU6hg6Znhrp9
ZFzx/nnOVxVO4kMBWg4YMNhOsZMIKj+8dt2lg81tpZwPK03SpMRDFOvAYGTdYdGF
br/M14+LWqUaIoikcI0uo+K0fI2KiNTw0kJzimUavSdk4CkZergn61aRAoGBAJSO
sAny5z67tkBFsOEKe4cd0GCFn45wTEVRO/5dGOheKSFf7iQGuf1XN60+OVPz+G5T
7hd2hTphBBGwxlUxB1Q34D+TtFf22dANN8PGMbC8tUJM+KUjz8AL394Thca+uWJ1
XNp8WYb8H6qTRY3h7gpkCUGI3x3T074OMSTb8VERAoGAeqgZdLE2Y3nvmlHWZlb0
fdiiaKKBNHICLYSNa4uW0a5rWSVw+cWgJYFvmFkz5DuTJkAOyLukNouC3TYUWcTe
al9H7C0WYMmTbMeDrJa0/UgHBkuxkCua2W8Z69x0g14vR4ni21DaGXomNQXS9R8k
pN9iHuSv+UDZLidheNnLqOY=
-----END PRIVATE KEY-----`;

/**
 * Mimics the wire behavior of Cloudflare-hosted MCP servers that broke
 * remote MCP startup: over a single HTTP/2 connection, `initialize` is
 * answered and the standalone GET SSE stream is held open, but a POST
 * (e.g. `tools/list`) sent while that GET stream is open is never answered.
 * HTTP/1.1 requests are always answered.
 */
async function startStallingH2McpServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const initializeResult = (id: unknown) =>
    `event: message\ndata: ${JSON.stringify({
      result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'h2-stall-mock', version: '0.0.1' },
      },
      jsonrpc: '2.0',
      id,
    })}\n\n`;
  const toolsResult = (id: unknown) =>
    `event: message\ndata: ${JSON.stringify({
      result: {
        tools: [
          {
            name: 'echo',
            description: 'Echoes text',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
          },
        ],
      },
      jsonrpc: '2.0',
      id,
    })}\n\n`;

  const server = createSecureServer({ allowHTTP1: true, cert: H2_STALL_TEST_CERT, key: H2_STALL_TEST_KEY });

  // HTTP/2 requests arrive on the 'stream' event.
  server.on('stream', (stream, headers) => {
    const method = headers[':method'];
    if (method === 'GET') {
      // Standalone SSE stream: respond and hold it open, never writing.
      stream.respond({ ':status': 200, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      return;
    }
    let body = '';
    stream.on('data', (chunk: Buffer) => (body += chunk.toString()));
    stream.on('end', () => {
      const message = JSON.parse(body) as { method?: string; id?: unknown };
      if (message.method === 'initialize') {
        stream.respond({ ':status': 200, 'content-type': 'text/event-stream' });
        stream.end(initializeResult(message.id));
        return;
      }
      if (message.method === 'notifications/initialized') {
        stream.respond({ ':status': 202 });
        stream.end();
        return;
      }
      // The stall: over H2, post-handshake POSTs (tools/list, tools/call)
      // are never answered. The real-world trigger is the standalone GET
      // stream being open on the same connection; because the SDK opens it
      // asynchronously, keying on the stream directly would make this mimic
      // racy, so it stalls all post-handshake H2 POSTs deterministically.
      return;
    });
  });

  // HTTP/1.1 requests also arrive on the compat 'request' event (H2 requests
  // fire both 'stream' and 'request'; only handle 1.x here). Always answered.
  server.on('request', (req, res) => {
    if (req.httpVersionMajor !== 1 || res.headersSent) return;
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      // Hold the stream open; an empty write flushes headers without a body chunk.
      res.write('');
      return;
    }
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      const message = JSON.parse(body) as { method?: string; id?: unknown };
      if (message.method === 'notifications/initialized') {
        res.writeHead(202).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(message.method === 'initialize' ? initializeResult(message.id) : toolsResult(message.id));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;

  return {
    url: `https://localhost:${port}/mcp`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
