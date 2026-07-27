/**
 * Scenario: dynamic-workflow RPC surface (SessionAPI via KimiCore).
 * Responsibilities: flag gating, discovery/list/get/reload, inline runs,
 * run snapshots, cancel semantics, and saveWorkflow persistence.
 * Wiring: real in-process core + filesystem; no model provider is needed
 * because the workflow scripts under test never call `agent()`.
 * Run: pnpm exec vitest run packages/agent-core/test/rpc/workflows-rpc.test.ts
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createRPC,
  KimiCore,
  type ApprovalResponse,
  type CoreAPI,
  type CoreRPC,
  type Event,
  type SDKAPI,
} from '../../src';

const FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_DYNAMIC_WORKFLOWS';

function workflowScript(name: string): string {
  return `export const meta = {
  name: '${name}',
  description: 'Demo workflow ${name}.',
  whenToUse: 'For tests.',
  argumentHint: '${name} <input>',
  phases: [{ title: 'Phase A', detail: 'first' }, { title: 'Phase B' }],
};
phase('Phase A');
log('args: ' + args);
phase('Phase B');
return { done: true, args };
`;
}

describe('workflow RPC surface', () => {
  let tmp: string;
  let homeDir: string;
  let workDir: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'kimi-workflow-rpc-'));
    homeDir = join(tmp, 'home');
    workDir = join(tmp, 'work');
    await mkdir(workDir, { recursive: true });
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_FLAG', '');
    vi.stubEnv(FLAG_ENV, '1');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(tmp, { recursive: true, force: true });
  });

  it('rejects every workflow method when the flag is disabled', async () => {
    vi.stubEnv(FLAG_ENV, '');
    const { rpc } = await createTestRpc();
    const created = await rpc.createSession({ id: 'ses_wf_flag_off', workDir });
    const sessionId = created.id;

    await expect(rpc.listWorkflows({ sessionId })).rejects.toMatchObject({
      code: 'request.invalid',
      message: expect.stringContaining('dynamic-workflows'),
    });
    await expect(rpc.runWorkflow({ sessionId, script: workflowScript('x') })).rejects.toMatchObject(
      { code: 'request.invalid' },
    );
    await expect(rpc.listWorkflowRuns({ sessionId })).rejects.toMatchObject({
      code: 'request.invalid',
    });
    await expect(
      rpc.saveWorkflow({ sessionId, script: workflowScript('x'), scope: 'project' }),
    ).rejects.toMatchObject({ code: 'request.invalid' });
  });

  it('lists, gets, and reloads project workflows', async () => {
    await writeProjectWorkflow('proj-flow');
    const { rpc } = await createTestRpc();
    const created = await rpc.createSession({ id: 'ses_wf_list', workDir });
    const sessionId = created.id;

    const listed = await rpc.listWorkflows({ sessionId });
    const flow = listed.workflows.find((workflow) => workflow.name === 'proj-flow');
    expect(flow).toMatchObject({
      name: 'proj-flow',
      description: 'Demo workflow proj-flow.',
      whenToUse: 'For tests.',
      argumentHint: 'proj-flow <input>',
      source: 'project',
      phases: [{ title: 'Phase A', detail: 'first' }, { title: 'Phase B' }],
    });
    expect(flow?.path.endsWith('/proj-flow.js')).toBe(true);
    // The list payload never carries script text.
    expect(JSON.stringify(listed)).not.toContain('export const meta');

    const detail = await rpc.getWorkflow({ sessionId, name: 'proj-flow' });
    expect(detail.workflow?.script).toContain('export const meta');
    await expect(rpc.getWorkflow({ sessionId, name: 'missing' })).resolves.toEqual({
      workflow: null,
    });

    // A workflow added after the first load appears only after reload.
    await writeProjectWorkflow('late-flow');
    expect(
      (await rpc.listWorkflows({ sessionId })).workflows.some((w) => w.name === 'late-flow'),
    ).toBe(false);
    const reloaded = await rpc.reloadWorkflows({ sessionId });
    expect(reloaded.workflows.some((w) => w.name === 'late-flow')).toBe(true);
  });

  it('reports skipped workflows with reasons', async () => {
    const dir = join(workDir, '.kimi-code', 'workflows');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'broken.js'), 'not a workflow at all', 'utf8');
    const { rpc } = await createTestRpc();
    const created = await rpc.createSession({ id: 'ses_wf_skipped', workDir });

    const listed = await rpc.listWorkflows({ sessionId: created.id });
    expect(listed.skipped).toHaveLength(1);
    expect(listed.skipped[0]!.path.endsWith('/broken.js')).toBe(true);
    expect(listed.skipped[0]!.reason.length).toBeGreaterThan(0);
  });

  it('runs an inline script to completion with events and run snapshots', async () => {
    const { rpc, events } = await createTestRpc();
    const created = await rpc.createSession({ id: 'ses_wf_run_inline', workDir });
    const sessionId = created.id;

    const started = await rpc.runWorkflow({
      sessionId,
      script: workflowScript('inline-flow'),
      args: 'hello',
    });
    expect(started.workflowName).toBe('inline-flow');
    expect(started.runId).toMatch(/^wfrun-/);
    expect(started.taskId.length).toBeGreaterThan(0);

    const run = await waitForRunSettled(rpc, sessionId, started.runId);
    expect(run).toMatchObject({
      runId: started.runId,
      workflowName: 'inline-flow',
      status: 'completed',
      source: 'extra',
      args: 'hello',
      resultJson: JSON.stringify({ done: true, args: 'hello' }),
    });
    expect(run.scriptPath).toBeUndefined();
    expect(run.script).toContain('export const meta');
    expect(run.logs).toContain('[log] args: hello');

    const list = await rpc.listWorkflowRuns({ sessionId });
    expect(list.runs).toHaveLength(1);
    expect(list.runs[0]).toMatchObject({ runId: started.runId, status: 'completed' });
    // List snapshots are lightweight: no script field.
    expect(list.runs[0]).not.toHaveProperty('script');

    const types = events.map((event) => event.type);
    expect(types).toContain('workflow.run.started');
    expect(types).toContain('workflow.run.phase');
    expect(types).toContain('workflow.run.log');
    expect(types).toContain('workflow.run.completed');
    await expect(rpc.getWorkflowRun({ sessionId, runId: 'missing' })).resolves.toEqual({
      run: null,
    });
  });

  it('runs a discovered workflow by name and rejects unknown names', async () => {
    await writeProjectWorkflow('named-flow');
    const { rpc } = await createTestRpc();
    const created = await rpc.createSession({ id: 'ses_wf_run_named', workDir });
    const sessionId = created.id;

    const started = await rpc.runWorkflow({ sessionId, name: 'named-flow' });
    const run = await waitForRunSettled(rpc, sessionId, started.runId);
    expect(run).toMatchObject({ status: 'completed', source: 'project' });
    expect(run.scriptPath?.endsWith('/named-flow.js')).toBe(true);

    await expect(rpc.runWorkflow({ sessionId, name: 'nope' })).rejects.toMatchObject({
      code: 'request.invalid',
      message: expect.stringContaining('nope'),
    });
    await expect(rpc.runWorkflow({ sessionId })).rejects.toMatchObject({
      code: 'request.invalid',
    });
  });

  it('propagates inline validation errors with a clear message', async () => {
    const { rpc } = await createTestRpc();
    const created = await rpc.createSession({ id: 'ses_wf_run_invalid', workDir });

    await expect(
      rpc.runWorkflow({ sessionId: created.id, script: 'return 1;' }),
    ).rejects.toMatchObject({
      code: 'request.invalid',
      message: expect.stringContaining('export const meta'),
    });
  });

  // Cancel on a live run is covered by the unit suite
  // (test/workflow/run-manager.test.ts) with a hangable stub host; over the
  // real RPC there is no way to hold a run open without spawning a real
  // subagent, so here we only pin the no-op semantics on settled/unknown runs.
  it('cancelWorkflowRun is a no-op on settled or unknown runs', async () => {
    const { rpc } = await createTestRpc();
    const created = await rpc.createSession({ id: 'ses_wf_cancel', workDir });
    const sessionId = created.id;

    const started = await rpc.runWorkflow({ sessionId, script: workflowScript('cancel-flow') });
    await waitForRunSettled(rpc, sessionId, started.runId);

    await expect(rpc.cancelWorkflowRun({ sessionId, runId: started.runId })).resolves.toEqual({
      cancelled: false,
    });
    await expect(rpc.cancelWorkflowRun({ sessionId, runId: 'missing' })).resolves.toEqual({
      cancelled: false,
    });
  });

  it('saveWorkflow persists to the project scope and reloads the registry', async () => {
    const { rpc } = await createTestRpc();
    const created = await rpc.createSession({ id: 'ses_wf_save', workDir });
    const sessionId = created.id;

    const saved = await rpc.saveWorkflow({
      sessionId,
      script: workflowScript('saved-flow'),
      scope: 'project',
    });
    expect(saved.name).toBe('saved-flow');
    expect(saved.path).toBe(join(workDir, '.kimi-code', 'workflows', 'saved-flow.js'));
    expect(await readFile(saved.path, 'utf8')).toContain(`name: 'saved-flow'`);

    // The save already reloaded the registry: no explicit reload needed.
    const listed = await rpc.listWorkflows({ sessionId });
    expect(listed.workflows.some((workflow) => workflow.name === 'saved-flow')).toBe(true);

    await expect(
      rpc.saveWorkflow({ sessionId, script: workflowScript('saved-flow'), scope: 'project' }),
    ).rejects.toThrow(/already exists/);
    await expect(
      rpc.saveWorkflow({
        sessionId,
        script: workflowScript('saved-flow'),
        scope: 'project',
        overwrite: true,
      }),
    ).resolves.toMatchObject({ name: 'saved-flow' });

    await expect(
      rpc.saveWorkflow({ sessionId, script: 'return 1;', scope: 'project' }),
    ).rejects.toMatchObject({ code: 'request.invalid' });
  });

  async function writeProjectWorkflow(name: string): Promise<void> {
    const dir = join(workDir, '.kimi-code', 'workflows');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${name}.js`), workflowScript(name), 'utf8');
  }

  async function waitForRunSettled(
    rpc: CoreRPC,
    sessionId: string,
    runId: string,
  ): Promise<NonNullable<Awaited<ReturnType<CoreRPC['getWorkflowRun']>>['run']>> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const { run } = await rpc.getWorkflowRun({ sessionId, runId });
      if (run !== null && run.status !== 'running') return run;
      await delay(10);
    }
    throw new Error(`Timed out waiting for workflow run ${runId} to settle`);
  }

  async function createTestRpc(): Promise<{
    core: KimiCore;
    events: Event[];
    rpc: CoreRPC;
  }> {
    const [coreRpc, sdkRpc] = createRPC<CoreAPI, SDKAPI>();
    const events: Event[] = [];
    const core = new KimiCore(coreRpc, { homeDir });
    const rpc = await sdkRpc({
      emitEvent: (event) => {
        events.push(event);
      },
      requestApproval: vi.fn(async (): Promise<ApprovalResponse> => ({ decision: 'rejected' })),
      requestQuestion: vi.fn(async () => null),
      toolCall: vi.fn(async () => ({ output: '' })),
    });
    return { core, events, rpc };
  }
});
