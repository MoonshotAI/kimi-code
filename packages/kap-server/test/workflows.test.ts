/**
 * `/api/v1/sessions/{sid}/workflows*` route tests.
 *
 * Boots an isolated server and verifies route registration, session-guard
 * (40401), and empty-list behavior for the Dynamic Workflows endpoints.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IModelCatalog,
} from '@moonshot-ai/agent-core-v2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { authHeaders } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
  details?: unknown;
}

interface WorkflowSummaryWire {
  name: string;
  description: string;
  phases: Array<{ title: string; detail?: string }>;
  path: string;
  source: string;
}

interface WorkflowDetailWire extends WorkflowSummaryWire {
  script: string;
}

interface ListWorkflowsWire {
  items: WorkflowSummaryWire[];
}

interface GetWorkflowWire {
  workflow: WorkflowDetailWire | null;
}

interface RunWorkflowResultWire {
  runId: string;
  taskId: string;
  workflowName: string;
}

interface ListWorkflowRunsWire {
  items: unknown[];
}

interface GetWorkflowRunWire {
  run: unknown | null;
}

interface CancelWorkflowRunWire {
  cancelled: boolean;
}

interface SaveWorkflowResultWire {
  path: string;
  name: string;
}

interface ReloadWorkflowsResultWire {
  workflows: WorkflowSummaryWire[];
  skipped: Array<{ path: string; reason: string }>;
}

describe('server-v2 /api/v1/sessions/{sid}/workflows', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-workflows-'));
    const modelCatalog: IModelCatalog = {
      _serviceBrand: undefined,
      get: () => { throw new Error('modelCatalog.get not exercised'); },
      getRequester: () => { throw new Error('modelCatalog.getRequester not exercised'); },
      inspect: () => { throw new Error('modelCatalog.inspect not exercised'); },
      ping: () => { throw new Error('modelCatalog.ping not exercised'); },
      findByName: () => [],
      listModels: async () => [],
      listProviders: async () => [],
      getProvider: async () => { throw new Error('modelCatalog.getProvider not exercised'); },
      setDefaultModel: async () => { throw new Error('modelCatalog.setDefaultModel not exercised'); },
    };
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      seeds: [[IModelCatalog, modelCatalog]],
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 } as never);
      home = undefined;
    }
  });

  async function getJson<T>(path: string): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function postJson<T>(path: string, body?: unknown): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      }),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function createSession(): Promise<string> {
    const res = await fetch(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ metadata: { cwd: home as string } }),
    } as never);
    const body = (await res.json()) as Envelope<{ id: string }>;
    expect(body.code).toBe(0);
    return body.data.id;
  }

  // -----------------------------------------------------------------------
  // Session guard — every endpoint returns 40401 for unknown sessions
  // -----------------------------------------------------------------------

  it('returns 40401 for an unknown session on all workflow endpoints', async () => {
    const getList = await getJson<ListWorkflowsWire>('/api/v1/sessions/nope/workflows');
    expect(getList.body.code).toBe(40401);

    const getDetail = await getJson<GetWorkflowWire>('/api/v1/sessions/nope/workflows/my-wf');
    expect(getDetail.body.code).toBe(40401);

    const run = await postJson<RunWorkflowResultWire>('/api/v1/sessions/nope/workflows/run', { args: '' });
    expect(run.body.code).toBe(40401);

    const getRuns = await getJson<ListWorkflowRunsWire>('/api/v1/sessions/nope/workflows/runs');
    expect(getRuns.body.code).toBe(40401);

    const getRun = await getJson<GetWorkflowRunWire>('/api/v1/sessions/nope/workflows/runs/wfrun-xxx');
    expect(getRun.body.code).toBe(40401);

    const cancelRun = await postJson<CancelWorkflowRunWire>('/api/v1/sessions/nope/workflows/runs/wfrun-xxx/cancel');
    expect(cancelRun.body.code).toBe(40401);

    const save = await postJson<SaveWorkflowResultWire>('/api/v1/sessions/nope/workflows/save', {
      script: '---\nname: test\n---\nconsole.log("hi")',
      scope: 'user',
    });
    expect(save.body.code).toBe(40401);

    const reload = await postJson<ReloadWorkflowsResultWire>('/api/v1/sessions/nope/workflows/reload');
    expect(reload.body.code).toBe(40401);
  });

  // -----------------------------------------------------------------------
  // Happy path — empty catalog and runs
  // -----------------------------------------------------------------------

  it('lists the builtin workflow catalog for a new session', async () => {
    const id = await createSession();
    const { body } = await getJson<ListWorkflowsWire>(`/api/v1/sessions/${id}/workflows`);
    expect(body.code).toBe(0);
    // At minimum the builtin 'deep-research' workflow is present
    expect(body.data.items.length).toBeGreaterThanOrEqual(1);
    expect(body.data.items.some((w) => w.name === 'deep-research')).toBe(true);
    expect(body.data.items[0]?.phases.length).toBeGreaterThanOrEqual(1);
  });

  it('returns null for an unknown workflow by name', async () => {
    const id = await createSession();
    const { body } = await getJson<GetWorkflowWire>(`/api/v1/sessions/${id}/workflows/nonexistent`);
    expect(body.code).toBe(0);
    expect(body.data.workflow).toBeNull();
  });

  it('lists an empty runs list for a new session', async () => {
    const id = await createSession();
    const { body } = await getJson<ListWorkflowRunsWire>(`/api/v1/sessions/${id}/workflows/runs`);
    expect(body.code).toBe(0);
    expect(body.data.items).toEqual([]);
  });

  it('returns null for an unknown runId', async () => {
    const id = await createSession();
    const { body } = await getJson<GetWorkflowRunWire>(`/api/v1/sessions/${id}/workflows/runs/wfrun-xxx`);
    expect(body.code).toBe(0);
    expect(body.data.run).toBeNull();
  });

  it('reloads the catalog gracefully', async () => {
    const id = await createSession();
    const { body } = await postJson<ReloadWorkflowsResultWire>(
      `/api/v1/sessions/${id}/workflows/reload`,
    );
    expect(body.code).toBe(0);
    // After reload the builtin workflows are still present
    expect(body.data.workflows.length).toBeGreaterThanOrEqual(1);
    expect(body.data.workflows.some((w) => w.name === 'deep-research')).toBe(true);
    expect(body.data.skipped).toEqual([]);
  });
});
