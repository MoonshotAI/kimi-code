import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import {
  accessTokensPath,
  createPersistedAccessToken,
  generateAccessToken,
  hashAccessToken,
  listPersistedAccessPrincipals,
  revokePersistedAccessPrincipal,
  startServer,
  type RunningServer,
} from '../src';
import { ErrorCode } from '../src/protocol/error-codes';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

function openWs(
  url: string,
  token: string,
): Promise<{ ws: WebSocket; frames: Record<string, unknown>[]; closed: Promise<{ code: number }> }> {
  return new Promise((resolve, reject) => {
    const frames: Record<string, unknown>[] = [];
    const ws = new WebSocket(url, [`kimi-code.bearer.${token}`]);
    const closed = new Promise<{ code: number }>((res) => {
      if (ws.readyState === WebSocket.CLOSED) {
        res({ code: 1008 });
        return;
      }
      ws.once('close', (code) => res({ code }));
    });
    ws.on('message', (raw) => {
      try {
        const text =
          typeof raw === 'string'
            ? raw
            : Buffer.isBuffer(raw)
              ? raw.toString('utf8')
              : Array.isArray(raw)
                ? Buffer.concat(raw).toString('utf8')
                : Buffer.from(raw).toString('utf8');
        frames.push(JSON.parse(text) as Record<string, unknown>);
      } catch {
      }
    });
    ws.once('open', () => resolve({ ws, frames, closed }));
    ws.once('error', reject);
  });
}

async function waitFor<T>(
  check: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 3_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await check();
    if (val !== undefined) return val;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('timed out waiting for condition');
}

describe('KAP access roles and token store', () => {
  let home: string | undefined;
  let server: RunningServer | undefined;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets.splice(0)) {
      try {
        ws.close();
      } catch {
      }
    }
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  async function boot(
    extra?: Partial<Parameters<typeof startServer>[0]>,
  ): Promise<{ base: string; wsUrl: string; ownerToken: string }> {
    home = await mkdtemp(join(tmpdir(), 'kimi-kap-access-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      debugEndpoints: true,
      ...extra,
    });
    return {
      base: `http://127.0.0.1:${server.port}`,
      wsUrl: `ws://127.0.0.1:${server.port}/api/v1/ws`,
      ownerToken: server.authTokenService.getToken(),
    };
  }

  it.skipIf(process.platform === 'win32')(
    'persists only sha256 hashes in 0600 access_tokens.json, enforces viewer / operator / owner boundaries, and closes active WS on revoke',
    async () => {
      const { base, wsUrl, ownerToken } = await boot();
      const workDir = await mkdtemp(join(tmpdir(), 'kimi-kap-ws-'));
      try {
        const opCreated = await createPersistedAccessToken(home!, {
          name: 'my-orchestrator',
          role: 'operator',
        });
        const viewerCreated = await createPersistedAccessToken(home!, {
          name: 'my-dashboard',
          role: 'viewer',
        });

        expect(opCreated.token.startsWith('kap_')).toBe(true);
        const fileStat = await stat(accessTokensPath(home!));
        expect(fileStat.mode & 0o777).toBe(0o600);
        const rawDisk = await readFile(accessTokensPath(home!), 'utf8');
        expect(rawDisk).not.toContain(opCreated.token);
        expect(rawDisk).toContain(hashAccessToken(opCreated.token));

        const ownerMe = await fetch(`${base}/api/v1/access/me`, {
          headers: { Authorization: `Bearer ${ownerToken}` },
        });
        expect(ownerMe.status).toBe(200);
        expect(((await ownerMe.json()) as { data: unknown }).data).toEqual({
          role: 'owner',
        });

        const opMe = await fetch(`${base}/api/v1/access/me`, {
          headers: { Authorization: `Bearer ${opCreated.token}` },
        });
        expect(((await opMe.json()) as { data: unknown }).data).toEqual({
          role: 'operator',
          principal_id: opCreated.principal.id,
          name: 'my-orchestrator',
        });

        const opSessionRes = await fetch(`${base}/api/v1/sessions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${opCreated.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ cwd: workDir }),
        });
        expect(opSessionRes.status).toBe(200);
        const sessionData = (await opSessionRes.json()) as { code: number; data: { id: string } };
        expect(sessionData.code).toBe(0);

        for (const [method, path, body] of [
          ['POST', '/api/v1/config', { yolo: true }],
          ['POST', '/api/v1/providers', { id: 'p1', type: 'openai', base_url: 'https://example.com/v1' }],
          ['POST', '/api/v1/oauth/logout', {}],
          ['GET', '/api/v1/oauth/userinfo', undefined],
          ['GET', '/api/v1/oauth/usage', undefined],
          ['POST', '/api/v1/plugins', { source: 'https://example.com/plugin' }],
          ['POST', '/api/v1/capabilities/kimi-cu:install', {}],
          ['POST', '/api/v1/mcp/servers', { name: 'm1', transport: 'http', url: 'https://example.com/mcp' }],
          ['GET', '/api/v1/fs:home', undefined],
          ['GET', `/api/v1/fs:content?path=${encodeURIComponent(join(workDir, 'a.txt'))}`, undefined],
          ['POST', '/api/v1/fs:mkdir', { path: join(workDir, 'sub') }],
          ['POST', '/api/v1/fs:suggest', { roots: [workDir], query: '' }],
          ['GET', `/api/v1/sessions/${sessionData.data.id}/fs/a.txt:download?allow_external_symlinks=true`, undefined],
          ['POST', `/api/v1/sessions/${sessionData.data.id}/fs:read`, { path: 'a.txt', allow_external_symlinks: true }],
          ['POST', `/api/v1/sessions/${sessionData.data.id}/fs:list`, { path: '.', allow_external_symlinks: true }],
          ['POST', `/api/v1/sessions/${sessionData.data.id}/fs:open`, { path: 'a.txt' }],
          ['POST', '/api/v1/shutdown', undefined],
          ['GET', '/api/v1/access/principals', undefined],
          ['GET', '/api/v1/debug/channels', undefined],
        ] as const) {
          const res = await fetch(`${base}${path}`, {
            method,
            headers: {
              Authorization: `Bearer ${opCreated.token}`,
              ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
          });
          expect(res.status, `${method} ${path} status`).toBe(403);
          const err = (await res.json()) as { code: number };
          expect(err.code, `${method} ${path} code`).toBe(ErrorCode.ACCESS_FORBIDDEN);
        }

        const unregisteredDir = await mkdtemp(join(tmpdir(), 'kimi-kap-unreg-'));
        try {
          const escapeWorkspaceFs = await fetch(`${base}/api/v1/workspace/fs:list`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${opCreated.token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ workspace: unregisteredDir }),
          });
          const escapeBody = (await escapeWorkspaceFs.json()) as { code: number };
          expect(escapeBody.code).toBe(ErrorCode.WORKSPACE_NOT_FOUND);
        } finally {
          await rm(unregisteredDir, { recursive: true, force: true });
        }

        const viewerListRes = await fetch(`${base}/api/v1/sessions`, {
          headers: { Authorization: `Bearer ${viewerCreated.token}` },
        });
        expect(viewerListRes.status).toBe(200);
        expect(((await viewerListRes.json()) as { code: number }).code).toBe(0);

        const viewerCreateRes = await fetch(`${base}/api/v1/sessions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${viewerCreated.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ cwd: workDir }),
        });
        expect(viewerCreateRes.status).toBe(403);
        expect(((await viewerCreateRes.json()) as { code: number }).code).toBe(
          ErrorCode.ACCESS_FORBIDDEN,
        );

        const viewerConn = await openWs(wsUrl, viewerCreated.token);
        sockets.push(viewerConn.ws);
        viewerConn.ws.send(
          JSON.stringify({
            type: 'subscribe',
            request_id: 'sub-1',
            session_id: sessionData.data.id,
          }),
        );
        const subReply = await waitFor(() =>
          viewerConn.frames.find((f) => f['type'] === 'response' && f['request_id'] === 'sub-1'),
        );
        expect(subReply['code']).toBe(0);

        viewerConn.ws.send(
          JSON.stringify({
            type: 'task.stop',
            request_id: 'stop-1',
            session_id: sessionData.data.id,
            agent_id: 'main',
            task_id: 'task_1',
          }),
        );
        const stopReply = await waitFor(() =>
          viewerConn.frames.find((f) => f['type'] === 'response' && f['request_id'] === 'stop-1'),
        );
        expect(stopReply['code']).toBe(ErrorCode.ACCESS_FORBIDDEN);

        const principals = await listPersistedAccessPrincipals(home!);
        expect(principals.some((p) => p.id === viewerCreated.principal.id)).toBe(true);

        await revokePersistedAccessPrincipal(home!, viewerCreated.principal.id);
        const closedInfo = await viewerConn.closed;
        expect(closedInfo.code).toBe(1008);

        const afterRevokeRes = await fetch(`${base}/api/v1/access/me`, {
          headers: { Authorization: `Bearer ${viewerCreated.token}` },
        });
        expect(afterRevokeRes.status).toBe(401);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
  );

  it('supports ephemeral in-memory tokens without creating or accepting server.token', async () => {
    const ephem = generateAccessToken();
    const { base } = await boot({
      disableOwnerTokenStore: true,
      enableAccessTokens: false,
      ephemeralTokens: [{ token: ephem, name: 'json-boot', role: 'operator' }],
    });

    await expect(stat(join(home!, 'server.token'))).rejects.toThrow();

    const metaRes = await fetch(`${base}/api/v1/meta`, {
      headers: { Authorization: `Bearer ${ephem}` },
    });
    expect(metaRes.status).toBe(200);
    const metaBody = (await metaRes.json()) as {
      code: number;
      data: { capabilities: Record<string, boolean> };
    };
    expect(metaBody.code).toBe(0);
    expect(metaBody.data.capabilities['access_tokens']).toBe(false);

    const meRes = await fetch(`${base}/api/v1/access/me`, {
      headers: { Authorization: `Bearer ${ephem}` },
    });
    expect(((await meRes.json()) as { data: { role: string } }).data.role).toBe('operator');
  });

  it('blocks non-owner tokens from SSH host routes, host proxy, hosts=include fanout, and config.hosts', async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-access-hosts-home-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    const base = `http://127.0.0.1:${server.port}`;
    const ownerToken = server.authTokenService.getToken();

    const putHostRes = await fetch(`${base}/api/v1/hosts/devbox`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        host: 'dev@example.test',
        identity_file: '/Users/test/.ssh/id_ed25519',
        enabled: false,
      }),
    });
    expect(putHostRes.status).toBe(200);

    const { token: operatorToken } = await createPersistedAccessToken(home, {
      name: 'Orchestrator',
      role: 'operator',
    });

    for (const [method, path] of [
      ['GET', '/api/v1/hosts'],
      ['GET', '/api/v1/hosts:ssh-hosts'],
      ['GET', '/api/v1/hosts/devbox/proxy/api/v1/meta'],
      ['GET', '/api/v1/workspaces?hosts=include'],
      ['GET', '/api/v1/sessions?hosts=include'],
      ['GET', '/api/v1/sessions/nonexistent?hosts=include'],
    ] as const) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${operatorToken}` },
      });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(((await res.json()) as { code: number }).code, `${method} ${path}`).toBe(
        ErrorCode.ACCESS_FORBIDDEN,
      );
    }

    const ownerConfigRes = await fetch(`${base}/api/v1/config`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const ownerConfig = (await ownerConfigRes.json()) as { data: Record<string, unknown> };
    expect(ownerConfig.data['hosts']).toBeDefined();

    const opConfigRes = await fetch(`${base}/api/v1/config`, {
      headers: { Authorization: `Bearer ${operatorToken}` },
    });
    const opConfig = (await opConfigRes.json()) as { data: Record<string, unknown> };
    expect(opConfig.data['hosts']).toBeUndefined();
  });
});
