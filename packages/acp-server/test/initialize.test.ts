import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';

import { ndJsonStream } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';

import { runAcpServerWithStream } from '../src/start';
import { CURRENT_VERSION, MIN_PROTOCOL_VERSION, negotiateVersion } from '../src/version';

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

describe('negotiateVersion', () => {
  it('returns CURRENT_VERSION when the client version is below MIN_PROTOCOL_VERSION', () => {
    const result = negotiateVersion(0);
    expect(result).toBe(CURRENT_VERSION);
    expect(result.protocolVersion).toBe(1);
  });

  it('returns the matching spec when the client requests the current version', () => {
    const result = negotiateVersion(1);
    expect(result).toBe(CURRENT_VERSION);
    expect(result.protocolVersion).toBe(1);
    expect(result.specTag).toBe('v0.10.x');
    expect(result.sdkVersion).toBe('0.23.0');
  });

  it('returns the highest supported version when the client advertises a newer one', () => {
    const result = negotiateVersion(99);
    expect(result).toBe(CURRENT_VERSION);
    expect(result.protocolVersion).toBe(1);
  });

  it('exposes MIN_PROTOCOL_VERSION = 1', () => {
    expect(MIN_PROTOCOL_VERSION).toBe(1);
  });
});

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
          agentCapabilities: {
            loadSession: true,
            auth: { logout: {} },
            mcpCapabilities: { http: true, sse: true },
            sessionCapabilities: { additionalDirectories: {}, delete: {}, fork: {} },
          },
        });

        await server.close();
        toAgent.end();
        toClient.end();
      } finally {
        await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    },
    30_000,
  );

  it(
    'negotiates down to the highest supported version when the client advertises a newer one',
    async () => {
      const homeDir = await mkdtemp(join(tmpdir(), 'acp-server-neg-'));
      const toAgent = new PassThrough();
      const toClient = new PassThrough();
      try {
        const stream = ndJsonStream(Writable.toWeb(toClient), Readable.toWeb(toAgent));
        const server = await runAcpServerWithStream(stream, { homeDir });

        toAgent.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: 99, clientCapabilities: {} },
          })}\n`,
        );

        const response = await readOneMessage(toClient);
        expect(response.error).toBeUndefined();
        expect((response.result as { protocolVersion?: number })?.protocolVersion).toBe(1);

        await server.close();
        toAgent.end();
        toClient.end();
      } finally {
        await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
        await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    },
    30_000,
  );
});
