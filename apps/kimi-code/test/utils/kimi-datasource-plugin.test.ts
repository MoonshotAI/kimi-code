import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '../../../..');
const SERVER_ENTRY = join(REPO_ROOT, 'plugins/official/kimi-datasource/bin/kimi-datasource.mjs');

describe('kimi-datasource MCP server', () => {
  it('prefers assistant text and writes response files', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'kimi-datasource-plugin-'));
    const kimiHome = join(tempDir, 'kimi-home');
    const textFile = join(tempDir, 'world-bank.csv');
    const binaryFile = join(tempDir, 'world-bank_payload.csv');
    const blockedFile = join(tempDir, 'blocked.csv');
    const requests: unknown[] = [];
    let child: ChildProcessWithoutNullStreams | undefined;

    const server = createServer(async (request, response) => {
      try {
        requests.push(await readJson(request));
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify({
            is_success: true,
            result: {
              assistant: [{ type: 'text', text: 'assistant complete result' }],
              user: [{ type: 'text', text: '{"data_preview": null}' }],
            },
            files: [
              { name: textFile, content: 'country,value\nCN,1\n' },
              {
                name: binaryFile,
                content: Buffer.from('binary payload').toString('base64'),
                encoding: 'base64',
              },
              { name: blockedFile, content: 'blocked\n' },
            ],
          }),
        );
      } catch (error) {
        response.statusCode = 500;
        response.end(error instanceof Error ? error.message : String(error));
      }
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
          method: 'call_data_source_tool',
          params: {
            data_source_name: 'world_bank_open_data',
            api_name: 'world_bank_open_data',
            params: { filepath: textFile },
          },
        },
      ]);
    } finally {
      child?.stdin.end();
      child?.kill();
      await closeServer(server);
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

async function readJson(request: IncomingMessage): Promise<unknown> {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
  }
  return JSON.parse(body);
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
