/**
 * Session-level boundary tests: an `additionalDirectories` entry that
 * does not exist on disk must be rejected at `session/new` time so a
 * misconfigured client can't push the failure into a tool call many
 * turns later. The effective root set is resolved when the boundary-
 * aware {@link AcpKaos} is built (`maybeBuildAcpKaos`); if any root's
 * `realpath` fails we surface a structured `invalid_params` error
 * before the harness sees the request.
 *
 * These tests cover the wiring, not the boundary logic itself (that
 * lives in `path-boundary.test.ts` / `kaos-boundary.test.ts`). Each
 * test advertises the FS reverse-RPC capability on `initialize` so
 * `maybeBuildAcpKaos` actually constructs an `AcpKaos` and runs the
 * root-set resolution; without the capability, the boundary code is
 * never reached and the test would be testing nothing.
 */

import {
  AgentSideConnection,
  ClientSideConnection,
  ndJsonStream,
  type Client,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from '@agentclientprotocol/sdk';
import type { KimiHarness } from '@moonshot-ai/kimi-code-sdk';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AcpServer } from '../src/server';
import { AUTHED_STATUS } from './_helpers/harness-stubs';

function makeInMemoryStreamPair(): {
  agentStream: ReturnType<typeof ndJsonStream>;
  clientStream: ReturnType<typeof ndJsonStream>;
} {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  const agentStream = ndJsonStream(agentToClient.writable, clientToAgent.readable);
  const clientStream = ndJsonStream(clientToAgent.writable, agentToClient.readable);
  return { agentStream, clientStream };
}

class StubClient implements Client {
  async readTextFile(_p: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    throw new Error('not exercised');
  }
  async writeTextFile(_p: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    throw new Error('not exercised');
  }
  async sessionUpdate(_n: SessionNotification): Promise<void> {
    /* no-op */
  }
  async requestPermission(_p: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    throw new Error('not exercised');
  }
}

function makeHarness(): {
  harness: KimiHarness;
  calls: { newSession: number; resumeSession: number };
} {
  const calls = { newSession: 0, resumeSession: 0 };
  const harness = {
    auth: { status: async () => AUTHED_STATUS },
    createSession: vi.fn(async (options: Record<string, unknown>) => {
      calls.newSession += 1;
      return {
        id: String((options as { id?: string }).id ?? 'sess-x'),
        prompt: async () => undefined,
        cancel: async () => undefined,
        onEvent: () => () => undefined,
      };
    }),
    resumeSession: vi.fn(async (options: Record<string, unknown>) => {
      calls.resumeSession += 1;
      return {
        id: String((options as { id?: string }).id ?? 'sess-r'),
        prompt: async () => undefined,
        cancel: async () => undefined,
        onEvent: () => () => undefined,
      };
    }),
    getConfig: async () => ({ providers: {}, models: {} }),
  } as unknown as KimiHarness;
  return { harness, calls };
}

let cwdOnDisk: string;

beforeEach(async () => {
  cwdOnDisk = await fsp.mkdtemp(path.join(tmpdir(), 'acp-sess-cwd-'));
});

afterEach(async () => {
  await fsp.rm(cwdOnDisk, { recursive: true, force: true });
});

describe('session/new — boundary', () => {
  it('rejects when an additionalDirectories entry does not exist on disk', async () => {
    const { harness, calls } = makeHarness();
    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    await client.initialize({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    });

    await expect(
      client.newSession({
        cwd: cwdOnDisk,
        mcpServers: [],
        additionalDirectories: [path.join(cwdOnDisk, 'definitely-not-here')],
      }),
    ).rejects.toMatchObject({ code: -32602 });

    // Strong invariant: harness.createSession must NOT have been
    // called when boundary validation fails — that's the whole point
    // of validating upfront.
    expect(calls.newSession).toBe(0);
  });

  it('accepts when every additionalDirectory entry exists on disk', async () => {
    const extra = path.join(cwdOnDisk, 'shared');
    await fsp.mkdir(extra);
    const { harness, calls } = makeHarness();
    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ClientSideConnection((_a) => new StubClient(), clientStream);

    await client.initialize({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    });

    const response = await client.newSession({
      cwd: cwdOnDisk,
      mcpServers: [],
      additionalDirectories: [extra],
    });

    expect(response.sessionId).toBeDefined();
    expect(calls.newSession).toBe(1);
  });
});
