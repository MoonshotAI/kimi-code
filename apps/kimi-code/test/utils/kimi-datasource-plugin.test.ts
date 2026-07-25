import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { resolveKimiCodeOAuthKey } from '@moonshot-ai/kimi-code-oauth';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '../../../..');
const SERVER_ENTRY = join(REPO_ROOT, 'plugins/official/kimi-datasource/bin/kimi-datasource.mjs');

describe('kimi-datasource MCP server', () => {
  it('exposes the same two generic tools as the Python plugin', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'kimi-datasource-plugin-'));
    const kimiHome = join(tempDir, 'kimi-home');
    let child: ChildProcessWithoutNullStreams | undefined;

    try {
      await mkdir(join(kimiHome, 'credentials'), { recursive: true });
      await writeFile(
        join(kimiHome, 'credentials', 'kimi-code.json'),
        JSON.stringify({ access_token: 'test-token', expires_at: 4_102_444_800 }),
        'utf8',
      );
      child = spawn(process.execPath, [SERVER_ENTRY], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          KIMI_CODE_HOME: kimiHome,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const client = createRpcClient(child);

      await client.request('initialize', {});
      const result = await client.request('tools/list', {});

      expect(result.error).toBeUndefined();
      const tools = (result.result as { tools: Array<{ name: string }> }).tools;
      expect(tools.map((tool) => tool.name)).toEqual(['call_data_source_tool', 'get_data_source_desc']);
    } finally {
      child?.stdin.end();
      child?.kill();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('prefers assistant text and writes response files', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'kimi-datasource-plugin-'));
    const kimiHome = join(tempDir, 'kimi-home');
    const textFile = join(tempDir, 'world-bank.csv');
    const binaryFile = join(tempDir, 'world-bank_payload.csv');
    const blockedFile = join(tempDir, 'blocked.csv');
    const requests: unknown[] = [];
    let child: ChildProcessWithoutNullStreams | undefined;

    const server = createServer((request, response) => {
      void handleMockDatasourceRequest(request, response, {
        requests,
        textFile,
        binaryFile,
        blockedFile,
      });
    });

    try {
      await mkdir(join(kimiHome, 'credentials'), { recursive: true });
      await writeFile(
        join(kimiHome, 'credentials', 'kimi-code.json'),
        JSON.stringify({ access_token: 'test-token', expires_at: 4_102_444_800 }),
        'utf8',
      );
      await listen(server);

      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('Expected an ephemeral TCP port for the test server.');
      }

      child = spawn(process.execPath, [SERVER_ENTRY], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          KIMI_CODE_HOME: kimiHome,
          KIMI_DATASOURCE_API_URL: `http://127.0.0.1:${address.port}`,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const client = createRpcClient(child);

      await client.request('initialize', {});
      const result = await client.request('tools/call', {
        name: 'call_data_source_tool',
        arguments: {
          data_source_name: 'world_bank_open_data',
          api_name: 'world_bank_open_data',
          params: { filepath: textFile },
        },
      });

      expect(result.error).toBeUndefined();
      expect(result.result).toEqual({
        content: [
          {
            type: 'text',
            text: expect.stringContaining('assistant complete result'),
          },
        ],
      });
      expect(JSON.stringify(result.result)).toContain('skipped returned file');
      expect(await readFile(textFile, 'utf8')).toBe('country,value\nCN,1\n');
      expect(await readFile(binaryFile, 'utf8')).toBe('binary payload');
      await expect(readFile(blockedFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(requests).toEqual([
        {
          authorization: 'Bearer test-token',
          method: 'call_data_source_tool',
          params: {
            data_source_name: 'world_bank_open_data',
            api_name: 'world_bank_open_data',
            params: { filepath: textFile },
          },
          url: '/',
        },
      ]);
    } finally {
      child?.stdin.end();
      child?.kill();
      await closeServer(server);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('uses env-scoped credentials and derives the datasource URL from KIMI_CODE_BASE_URL', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'kimi-datasource-plugin-'));
    const kimiHome = join(tempDir, 'kimi-home');
    const requests: unknown[] = [];
    let child: ChildProcessWithoutNullStreams | undefined;

    const server = createServer((request, response) => {
      void handleMockDatasourceRequest(request, response, {
        requests,
        textFile: join(tempDir, 'unused.csv'),
        binaryFile: join(tempDir, 'unused_payload.csv'),
        blockedFile: join(tempDir, 'blocked.csv'),
      });
    });

    try {
      await listen(server);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('Expected an ephemeral TCP port for the test server.');
      }

      const baseUrl = `http://127.0.0.1:${address.port}/coding/v1`;
      const oauthHost = 'https://auth.dev.example.test';
      const scopedCredential = kimiCodeEnvCredentialName({ oauthHost, baseUrl });

      await mkdir(join(kimiHome, 'credentials'), { recursive: true });
      await writeFile(
        join(kimiHome, 'credentials', 'kimi-code.json'),
        JSON.stringify({ access_token: 'expired-prod-token', expires_at: 1 }),
        'utf8',
      );
      await writeFile(
        join(kimiHome, 'credentials', `${scopedCredential}.json`),
        JSON.stringify({ access_token: 'scoped-token', expires_at: 4_102_444_800 }),
        'utf8',
      );

      child = spawn(process.execPath, [SERVER_ENTRY], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          KIMI_CODE_HOME: kimiHome,
          KIMI_CODE_BASE_URL: baseUrl,
          KIMI_CODE_OAUTH_HOST: oauthHost,
          KIMI_DATASOURCE_API_URL: undefined,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const client = createRpcClient(child);

      await client.request('initialize', {});
      const result = await client.request('tools/call', {
        name: 'get_data_source_desc',
        arguments: {
          name: 'arxiv',
        },
      });

      expect(result.error).toBeUndefined();
      expect(result.result).toEqual({
        content: [
          {
            type: 'text',
            text: expect.stringContaining('assistant complete result'),
          },
        ],
      });
      expect(requests).toEqual([
        {
          authorization: 'Bearer scoped-token',
          method: 'get_data_source_desc',
          params: { name: 'arxiv' },
          url: '/coding/v1/tools',
        },
      ]);
    } finally {
      child?.stdin.end();
      child?.kill();
      await closeServer(server);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('retries with a rotated credential when the backend rejects the previous token', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'kimi-datasource-plugin-'));
    const kimiHome = join(tempDir, 'kimi-home');
    const credentialsFile = join(kimiHome, 'credentials', 'kimi-code.json');
    const authorizations: Array<string | undefined> = [];
    let child: ChildProcessWithoutNullStreams | undefined;

    const server = createServer((request, response) => {
      void handleCredentialRotationRequest(request, response, {
        authorizations,
        credentialsFile,
      });
    });

    try {
      await mkdir(join(kimiHome, 'credentials'), { recursive: true });
      await writeFile(
        credentialsFile,
        JSON.stringify({ access_token: 'previous-token', expires_at: 1 }),
        'utf8',
      );
      await listen(server);

      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('Expected an ephemeral TCP port for the test server.');
      }

      child = spawn(process.execPath, [SERVER_ENTRY], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          KIMI_CODE_HOME: kimiHome,
          KIMI_DATASOURCE_API_URL: `http://127.0.0.1:${address.port}`,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const client = createRpcClient(child);

      await client.request('initialize', {});
      const result = await client.request('tools/call', {
        name: 'get_data_source_desc',
        arguments: { name: 'imf' },
      });

      expect(result.error).toBeUndefined();
      expect(result.result).toEqual({
        content: [
          {
            type: 'text',
            text: expect.stringContaining('assistant complete result'),
          },
        ],
      });
      expect(authorizations).toEqual(['Bearer previous-token', 'Bearer refreshed-token']);
    } finally {
      child?.stdin.end();
      child?.kill();
      await closeServer(server);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('returns the complete data-source routing contract when tools are listed', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'kimi-datasource-plugin-'));
    const kimiHome = join(tempDir, 'kimi-home');
    let child: ChildProcessWithoutNullStreams | undefined;

    try {
      await mkdir(join(kimiHome, 'credentials'), { recursive: true });
      await writeFile(
        join(kimiHome, 'credentials', 'kimi-code.json'),
        JSON.stringify({ access_token: 'test-token', expires_at: 4_102_444_800 }),
        'utf8',
      );
      child = spawn(process.execPath, [SERVER_ENTRY], {
        cwd: REPO_ROOT,
        env: { ...process.env, KIMI_CODE_HOME: kimiHome },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const client = createRpcClient(child);

      await client.request('initialize', {});
      const result = await client.request('tools/list', {});

      const tools = (
        result.result as {
          tools: Array<{
            name: string;
            description: string;
            inputSchema: {
              properties: Record<string, { description?: string; enum?: string[] }>;
            };
          }>;
        }
      ).tools;
      const call = tools.find((tool) => tool.name === 'call_data_source_tool');
      const desc = tools.find((tool) => tool.name === 'get_data_source_desc');
      expect(desc?.inputSchema.properties['name']?.enum).toEqual([
        'stock_finance_data',
        'yahoo_finance',
        'world_bank_open_data',
        'tianyancha',
        'arxiv',
        'scholar',
        'yuandian_law',
        'wind',
        'imf',
        'gildata',
        'sec_edgar',
        'sp_data',
      ]);
      expect(call?.description).toContain(
        'For a simple lookup, use one specialized source and stop after its first successful result',
      );
      expect(call?.description).toContain('When the user names a data source, use that source');
      expect(call?.inputSchema.properties['data_source_name']?.description).toContain(
        'When the user names a source, pass that source',
      );
      expect(desc?.description).toContain('choose exactly one specialized source');
      expect(desc?.inputSchema.properties['name']?.description).toContain(
        'yahoo_finance FX history is limited to about 2 years',
      );
    } finally {
      child?.stdin.end();
      child?.kill();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('appends a request-id / tool-call-id trace line to tool results', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'kimi-datasource-plugin-'));
    const kimiHome = join(tempDir, 'kimi-home');
    let child: ChildProcessWithoutNullStreams | undefined;

    const server = createServer((request, response) => {
      request.on('data', () => {});
      request.on('end', () => {
        response.setHeader('x-request-id', 'backend-req-test');
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify({ is_success: true, result: { assistant: [{ type: 'text', text: 'ok' }] } }),
        );
      });
    });

    try {
      await mkdir(join(kimiHome, 'credentials'), { recursive: true });
      await writeFile(
        join(kimiHome, 'credentials', 'kimi-code.json'),
        JSON.stringify({ access_token: 'test-token', expires_at: 4_102_444_800 }),
        'utf8',
      );
      await listen(server);

      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('Expected an ephemeral TCP port for the test server.');
      }

      child = spawn(process.execPath, [SERVER_ENTRY], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          KIMI_CODE_HOME: kimiHome,
          KIMI_DATASOURCE_API_URL: `http://127.0.0.1:${address.port}`,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const client = createRpcClient(child);

      await client.request('initialize', {});
      const result = await client.request('tools/call', {
        name: 'get_data_source_desc',
        arguments: { name: 'yuandian_law' },
      });

      const text = (result.result as { content: Array<{ text: string }> }).content[0]!.text;
      expect(text).toContain('[kimi-datasource] request-id: backend-req-test · tool-call-id:');
    } finally {
      child?.stdin.end();
      child?.kill();
      await closeServer(server);
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

// Pin the expected credential file name to the canonical OAuth-key resolver so
// this test fails if the plugin's standalone digest drifts from the source of
// truth in @moonshot-ai/kimi-code-oauth. The credential file name is the OAuth
// key with its `oauth/` prefix stripped.
function kimiCodeEnvCredentialName(options: {
  readonly oauthHost: string;
  readonly baseUrl: string;
}): string {
  return resolveKimiCodeOAuthKey(options).replace(/^oauth\//, '');
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
  }
  return JSON.parse(body);
}

async function handleMockDatasourceRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: {
    readonly requests: unknown[];
    readonly textFile: string;
    readonly binaryFile: string;
    readonly blockedFile: string;
  },
): Promise<void> {
  try {
    options.requests.push({
      ...(await readJson(request) as Record<string, unknown>),
      authorization: request.headers.authorization,
      url: request.url,
    });
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        is_success: true,
        result: {
          assistant: [{ type: 'text', text: 'assistant complete result' }],
          user: [{ type: 'text', text: '{"data_preview": null}' }],
        },
        files: [
          { name: options.textFile, content: 'country,value\nCN,1\n' },
          {
            name: options.binaryFile,
            content: Buffer.from('binary payload').toString('base64'),
            encoding: 'base64',
          },
          { name: options.blockedFile, content: 'blocked\n' },
        ],
      }),
    );
  } catch (error) {
    response.statusCode = 500;
    response.end(error instanceof Error ? error.message : String(error));
  }
}

async function handleCredentialRotationRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: {
    readonly authorizations: Array<string | undefined>;
    readonly credentialsFile: string;
  },
): Promise<void> {
  try {
    await readJson(request);
    options.authorizations.push(request.headers.authorization);
    response.setHeader('Content-Type', 'application/json');

    if (options.authorizations.length === 1) {
      await writeFile(
        options.credentialsFile,
        JSON.stringify({ access_token: 'refreshed-token', expires_at: 4_102_444_800 }),
        'utf8',
      );
      response.statusCode = 401;
      response.end(JSON.stringify({ error: 'expired access token' }));
      return;
    }

    response.end(
      JSON.stringify({
        is_success: true,
        result: { assistant: [{ type: 'text', text: 'assistant complete result' }] },
      }),
    );
  } catch (error) {
    response.statusCode = 500;
    response.end(error instanceof Error ? error.message : String(error));
  }
}

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function createRpcClient(child: ChildProcessWithoutNullStreams) {
  let nextId = 1;
  const stderr: string[] = [];
  const pending = new Map<
    number,
    {
      resolve: (value: JsonRpcResponse) => void;
      reject: (err: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr.push(chunk);
  });

  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    const message = JSON.parse(line) as JsonRpcResponse;
    const id = typeof message.id === 'number' ? message.id : undefined;
    if (id === undefined) return;
    const waiter = pending.get(id);
    if (waiter === undefined) return;
    clearTimeout(waiter.timeout);
    pending.delete(id);
    waiter.resolve(message);
  });

  child.on('exit', (code, signal) => {
    for (const [id, waiter] of pending) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error(`MCP server exited before response ${id}: code=${code}, signal=${signal}.`));
    }
    pending.clear();
  });

  return {
    request(method: string, params: unknown): Promise<JsonRpcResponse> {
      const id = nextId++;
      const payload = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out waiting for MCP response ${id}. stderr: ${stderr.join('')}`));
        }, 5_000);
        pending.set(id, { resolve, reject, timeout });
        child.stdin.write(payload);
      });
    },
  };
}

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: unknown;
}
