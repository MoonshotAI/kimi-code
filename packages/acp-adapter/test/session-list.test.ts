import { describe, expect, it } from 'vitest';

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
import type { KimiHarness, SessionSummary } from '@moonshot-ai/kimi-code-sdk';

import { AcpServer } from '../src/server';
import { AUTHED_STATUS } from './_helpers/harness-stubs';

class StubClient implements Client {
  async requestPermission(_p: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    throw new Error('StubClient.requestPermission should not be called in session-list test');
  }
  async sessionUpdate(_n: SessionNotification): Promise<void> {
    throw new Error('StubClient.sessionUpdate should not be called in session-list test');
  }
  async writeTextFile(_p: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    throw new Error('StubClient.writeTextFile should not be called in session-list test');
  }
  async readTextFile(_p: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    throw new Error('StubClient.readTextFile should not be called in session-list test');
  }
}

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

interface CapturedListOptions {
  options: { workDir?: string; sessionId?: string };
}

function makeHarness(
  summaries: SessionSummary[],
  captured: CapturedListOptions[] = [],
): KimiHarness {
  return {
    auth: { status: async () => AUTHED_STATUS },
    listSessions: async (options: { workDir?: string; sessionId?: string } = {}) => {
      captured.push({ options });
      if (options.workDir !== undefined) {
        return summaries.filter((s) => s.workDir === options.workDir);
      }
      return summaries;
    },
  } as unknown as KimiHarness;
}

function openConn(harness: KimiHarness): ClientSideConnection {
  const { agentStream, clientStream } = makeInMemoryStreamPair();
  new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
  return new ClientSideConnection((_a) => new StubClient(), clientStream);
}

describe('AcpServer session/list', () => {
  it('returns an empty list (with nextCursor: null) when the harness reports no sessions', async () => {
    const harness = makeHarness([]);
    const client = openConn(harness);

    const response = await client.listSessions({});

    expect(response.sessions).toEqual([]);
    expect(response.nextCursor).toBeNull();
  });

  it('maps SessionSummary[] to SessionInfo[] with sessionId / cwd / title / updatedAt', async () => {
    const updated1Ms = Date.UTC(2026, 0, 1, 12, 0, 0);
    const updated2Ms = Date.UTC(2026, 4, 15, 9, 30, 0);
    const summaries: SessionSummary[] = [
      {
        id: 'sess-a',
        title: 'My first chat',
        workDir: '/repo/a',
        sessionDir: '/home/.kimi/sessions/sess-a',
        createdAt: updated1Ms - 1_000,
        updatedAt: updated1Ms,
      },
      {
        id: 'sess-b',
        title: 'Refactor',
        workDir: '/repo/b',
        sessionDir: '/home/.kimi/sessions/sess-b',
        createdAt: updated2Ms - 1_000,
        updatedAt: updated2Ms,
      },
    ];
    const harness = makeHarness(summaries);
    const client = openConn(harness);

    const response = await client.listSessions({});

    expect(response.sessions).toHaveLength(2);
    expect(response.sessions[0]).toMatchObject({
      sessionId: 'sess-a',
      cwd: '/repo/a',
      title: 'My first chat',
      updatedAt: new Date(updated1Ms).toISOString(),
    });
    expect(response.sessions[1]).toMatchObject({
      sessionId: 'sess-b',
      cwd: '/repo/b',
      title: 'Refactor',
      updatedAt: new Date(updated2Ms).toISOString(),
    });
    expect(response.nextCursor).toBeNull();
  });

  it('passes the cwd filter through to harness.listSessions as workDir', async () => {
    const summaries: SessionSummary[] = [
      {
        id: 'sess-here',
        workDir: '/repo/here',
        sessionDir: '/home/.kimi/sessions/sess-here',
        createdAt: 0,
        updatedAt: 0,
      },
      {
        id: 'sess-elsewhere',
        workDir: '/repo/elsewhere',
        sessionDir: '/home/.kimi/sessions/sess-elsewhere',
        createdAt: 0,
        updatedAt: 0,
      },
    ];
    const captured: CapturedListOptions[] = [];
    const harness = makeHarness(summaries, captured);
    const client = openConn(harness);

    const response = await client.listSessions({ cwd: '/repo/here' });

    expect(captured).toEqual([{ options: { workDir: '/repo/here' } }]);
    expect(response.sessions).toHaveLength(1);
    expect(response.sessions[0]?.sessionId).toBe('sess-here');
    expect(response.sessions[0]?.cwd).toBe('/repo/here');
  });

  it('falls back to title: null when the SDK summary has no title', async () => {
    const summaries: SessionSummary[] = [
      {
        id: 'sess-untitled',
        workDir: '/repo/u',
        sessionDir: '/home/.kimi/sessions/sess-untitled',
        createdAt: 0,
        updatedAt: 1,
      },
      {
        id: 'sess-empty-title',
        title: '',
        workDir: '/repo/e',
        sessionDir: '/home/.kimi/sessions/sess-empty-title',
        createdAt: 0,
        updatedAt: 2,
      },
    ];
    const harness = makeHarness(summaries);
    const client = openConn(harness);

    const response = await client.listSessions({});

    expect(response.sessions[0]?.title).toBeNull();
    expect(response.sessions[1]?.title).toBeNull();
  });
});
