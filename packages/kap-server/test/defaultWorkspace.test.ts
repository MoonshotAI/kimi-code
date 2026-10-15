import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IConfigService } from '@moonshot-ai/agent-core-v2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { authHeaders } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

interface StatusWire {
  path: string | null;
  custom_path: string | null;
  exists: boolean;
}

interface WorkspaceWire {
  id: string;
  root: string;
  is_default: boolean;
}

describe('server-v2 /api/v1/default-workspace', () => {
  let server: RunningServer | undefined;
  let home: string;
  let scratch: string;
  let base: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-default-ws-'));
    scratch = await mkdtemp(join(tmpdir(), 'kimi-default-ws-target-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server?.close();
    server = undefined;
    await rm(home, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  });

  async function request<T>(method: string, path: string, body?: unknown): Promise<Envelope<T>> {
    const hasBody = body !== undefined;
    const res = await fetch(`${base}${path}`, {
      method,
      headers: authHeaders(
        server as RunningServer,
        hasBody ? { 'content-type': 'application/json' } : {},
      ),
      body: hasBody ? JSON.stringify(body) : undefined,
    } as never);
    return (await res.json()) as Envelope<T>;
  }

  it('creates the custom location and stores it in config.toml', async () => {
    const target = join(scratch, 'Chats');

    const updated = await request<StatusWire>('PATCH', '/api/v1/default-workspace', {
      path: target,
    });

    expect(updated.code).toBe(0);
    expect(updated.data).toEqual({ path: target, custom_path: target, exists: true });
    expect(await readFile(join(home, 'config.toml'), 'utf8')).toContain('[default_workspace]');

    const fetched = await request<StatusWire>('GET', '/api/v1/default-workspace');
    expect(fetched.data).toEqual(updated.data);
  });

  it('creates default-workspace sessions in the custom location', async () => {
    const target = join(scratch, 'Sessions');
    await request('PATCH', '/api/v1/default-workspace', { path: target });

    const session = await request<{ metadata: { cwd: string } }>('POST', '/api/v1/sessions', {
      default_workspace: true,
    });

    expect(session.code).toBe(0);
    expect(session.data.metadata.cwd).toBe(target);
  });

  it('moves the default flag between registered workspaces and back to the system location', async () => {
    const project = join(scratch, 'project');
    await mkdir(project, { recursive: true });
    const created = await request<WorkspaceWire>('POST', '/api/v1/workspaces', { root: project });
    expect(created.data.is_default).toBe(false);

    await request('PATCH', '/api/v1/default-workspace', { path: project });
    const asDefault = await request<{ items: WorkspaceWire[] }>('GET', '/api/v1/workspaces');
    expect(asDefault.data.items.find((ws) => ws.id === created.data.id)?.is_default).toBe(true);

    const reset = await request<StatusWire>('PATCH', '/api/v1/default-workspace', { path: null });
    expect(reset.data.custom_path).toBeNull();
    expect(reset.data.path).not.toBe(project);
    expect(await readFile(join(home, 'config.toml'), 'utf8')).not.toContain('[default_workspace]');
    await (server as RunningServer).core.accessor.get(IConfigService).reload();
    const reloaded = await request<StatusWire>('GET', '/api/v1/default-workspace');
    expect(reloaded.data.custom_path).toBeNull();
    const afterReset = await request<{ items: WorkspaceWire[] }>('GET', '/api/v1/workspaces');
    expect(afterReset.data.items.find((ws) => ws.id === created.data.id)?.is_default).toBe(false);
  });

  it.each([
    ['a relative path', () => 'relative/dir', 'invalid_path'],
    ['a path under a file', () => join(scratch, 'note.txt', 'Default'), 'blocked_by_file'],
  ])('rejects %s with 40930 and keeps the previous location', async (_label, target, reason) => {
    await writeFile(join(scratch, 'note.txt'), 'x');
    const kept = join(scratch, 'Kept');
    await request('PATCH', '/api/v1/default-workspace', { path: kept });

    const rejected = await request<{ path: string | null; reason: string }>(
      'PATCH',
      '/api/v1/default-workspace',
      { path: target() },
    );

    expect(rejected.code).toBe(40930);
    expect(rejected.data.reason).toBe(reason);
    const status = await request<StatusWire>('GET', '/api/v1/default-workspace');
    expect(status.data.custom_path).toBe(kept);
  });
});
