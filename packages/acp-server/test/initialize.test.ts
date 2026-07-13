import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';

import { ndJsonStream } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';

import { runAcpServerWithStream } from '../src/start';

interface JsonRpcMessage {
  readonly jsonrpc?: string;
  readonly id?: number | string;
  readonly method?: string;
  readonly result?: unknown;
  readonly error?: unknown;
}

/** Read a single ND-JSON JSON-RPC message off a readable stream. */
async function readOneMessage(readable: Readable): Promise<JsonRpcMessage> {
  let buf = '';
  for await (const chunk of readable) {
    buf += (chunk as Buffer).toString('utf8');
    const idx = buf.indexOf('\n');
    if (idx >= 0) {
      return JSON.parse(buf.slice(0, idx)) as JsonRpcMessage;
    }
  }
  throw new Error('stream closed before a full JSON-RPC message was received');
}

describe('acp-server initialize handshake', () => {
  it(
    'boots agent-core-v2 and answers the ACP initialize request',
    async () => {
      const homeDir = await mkdtemp(join(tmpdir(), 'acp-server-init-'));
      // One PassThrough per direction: writes on one side appear on the other.
      const toAgent = new PassThrough();
      const toClient = new PassThrough();
      try {
        const stream = ndJsonStream(Writable.toWeb(toClient), Readable.toWeb(toAgent));
        const server = await runAcpServerWithStream(stream, { homeDir });

        const request = {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: 1, clientCapabilities: {} },
        };
        toAgent.write(`${JSON.stringify(request)}\n`);

        const response = await readOneMessage(toClient);
        expect(response.id).toBe(1);
        expect(response.error).toBeUndefined();
        expect(response.result).toMatchObject({
          agentCapabilities: { loadSession: true },
        });

        await server.close();
        toAgent.end();
        toClient.end();
      } finally {
        await rm(homeDir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it(
    'advertises terminal-auth with forwarded env and the legacy _meta fallback',
    async () => {
      const homeDir = await mkdtemp(join(tmpdir(), 'acp-server-auth-'));
      const toAgent = new PassThrough();
      const toClient = new PassThrough();
      try {
        const stream = ndJsonStream(Writable.toWeb(toClient), Readable.toWeb(toAgent));
        const server = await runAcpServerWithStream(stream, {
          homeDir,
          terminalAuthEnv: { KIMI_CODE_HOME: '/tmp/sandbox' },
          terminalAuthLegacyCommand: '/opt/kimi/bin/kimi',
        });

        toAgent.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: 1, clientCapabilities: {} },
          })}\n`,
        );

        const response = await readOneMessage(toClient);
        const authMethods = (response.result as { authMethods?: unknown[] })?.authMethods;
        expect(Array.isArray(authMethods)).toBe(true);
        const method = authMethods?.[0] as {
          type: string;
          args: string[];
          env: Record<string, string>;
          _meta?: { 'terminal-auth'?: { command: string; args: string[]; env: Record<string, string> } };
        };
        expect(method.type).toBe('terminal');
        expect(method.args).toEqual(['--login']);
        expect(method.env).toEqual({ KIMI_CODE_HOME: '/tmp/sandbox' });
        expect(method._meta?.['terminal-auth']).toMatchObject({
          command: '/opt/kimi/bin/kimi',
          args: ['login'],
          env: { KIMI_CODE_HOME: '/tmp/sandbox' },
        });

        await server.close();
        toAgent.end();
        toClient.end();
      } finally {
        await rm(homeDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
