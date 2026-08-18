import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ensureMainAgent,
  getLiveSessionById,
  IAgentFlowService,
  type FlowDefinition,
} from '@moonshot-ai/agent-core-v2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import type { FlowStateResponse } from '../src/protocol/rest-flow';
import { readLegacyStatus } from '../src/services/legacyStatus/legacyStatus';
import { authHeaders } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

const FLOW_ENV = 'KIMI_CODE_EXPERIMENTAL_FLOW';

const DEFINITION: FlowDefinition = {
  id: 'issue-fix',
  stages: [
    { id: 'triage', objective: 'find it', completion: 'found', gate: 'human' },
    { id: 'implement', objective: 'fix it', completion: 'fixed', gate: 'ai' },
  ],
};

describe('server-v2 /api/v1/sessions/{sid}/flow', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;
  const inheritedFlowEnv = process.env[FLOW_ENV];

  beforeEach(async () => {
    delete process.env[FLOW_ENV];
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-flow-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    if (inheritedFlowEnv === undefined) delete process.env[FLOW_ENV];
    else process.env[FLOW_ENV] = inheritedFlowEnv;
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  async function postJson<T>(
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const hasBody = body !== undefined;
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: authHeaders(
        server as RunningServer,
        hasBody ? { 'content-type': 'application/json' } : {},
      ),
      body: hasBody ? JSON.stringify(body) : undefined,
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function getFlow(
    sessionId: string,
  ): Promise<{ status: number; body: Envelope<FlowStateResponse> }> {
    const res = await fetch(`${base}/api/v1/sessions/${sessionId}/flow`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<FlowStateResponse> };
  }

  async function createSession(): Promise<string> {
    const { body } = await postJson<{ id: string }>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });
    expect(body.code).toBe(0);
    return body.data.id;
  }

  async function startRun(sessionId: string): Promise<void> {
    const handle = getLiveSessionById(server!.core.accessor, sessionId);
    expect(handle).toBeDefined();
    const main = await ensureMainAgent(handle!);
    expect(main.accessor.get(IAgentFlowService).start(DEFINITION, 'fix the paste bug')).toBe(true);
  }

  it('serves the empty state while the flow flag is off', async () => {
    const sessionId = await createSession();
    const { body } = await getFlow(sessionId);
    expect(body.code).toBe(0);
    expect(body.data).toEqual({ run: { active: false }, gates: [] });
  });

  it('serves the run snapshot and gate records while the flag is on', async () => {
    process.env[FLOW_ENV] = 'true';
    const sessionId = await createSession();
    await startRun(sessionId);

    const { body } = await getFlow(sessionId);
    expect(body.code).toBe(0);
    expect(body.data.run.active).toBe(true);
    expect(body.data.run.flow_id).toBe('issue-fix');
    expect(body.data.run.task).toBe('fix the paste bug');
    expect(body.data.run.current_stage_index).toBe(0);
    expect(body.data.run.stages?.map((stage) => stage.id)).toEqual(['triage', 'implement']);
    expect(body.data.gates).toEqual([]);
    expect(body.data.gates_flow_id).toBe('issue-fix');
    expect(body.data.gates_task).toBe('fix the paste bug');
  });

  it('reports the termination outcome of an ended run', async () => {
    process.env[FLOW_ENV] = 'true';
    const sessionId = await createSession();
    await startRun(sessionId);
    const handle = getLiveSessionById(server!.core.accessor, sessionId);
    const main = await ensureMainAgent(handle!);
    main.accessor.get(IAgentFlowService).abort('changed direction');

    const { body } = await getFlow(sessionId);
    expect(body.code).toBe(0);
    expect(body.data.run.active).toBe(false);
    expect(body.data.run.flow_id).toBe('issue-fix');
    expect(body.data.run.ended_reason).toBe('aborted');
    expect(body.data.run.ended_note).toBe('changed direction');
  });

  it('hides a leftover run behind the empty state after the flag is turned off', async () => {
    process.env[FLOW_ENV] = 'true';
    const sessionId = await createSession();
    await startRun(sessionId);

    delete process.env[FLOW_ENV];
    const { body } = await getFlow(sessionId);
    expect(body.code).toBe(0);
    expect(body.data).toEqual({ run: { active: false }, gates: [] });
  });

  it('carries the live flow run in the legacy status snapshot of the main agent', async () => {
    process.env[FLOW_ENV] = 'true';
    const sessionId = await createSession();
    await startRun(sessionId);

    const handle = getLiveSessionById(server!.core.accessor, sessionId);
    const main = await ensureMainAgent(handle!);
    expect(readLegacyStatus(main)?.flowRun).toEqual({
      flowId: 'issue-fix',
      stageId: 'triage',
      stageIndex: 0,
      stageTotal: 2,
      gate: 'human',
    });

    delete process.env[FLOW_ENV];
    expect(readLegacyStatus(main)?.flowRun).toBeNull();
  });
});
