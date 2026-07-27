/**
 * Scenario: public SDK dynamic-workflow surface.
 * Responsibilities: flag gating, listing/saving workflows, running an inline
 * script (no `agent()` calls, so no model provider is needed), run inspection,
 * and receiving `workflow.run.*` events through `session.onEvent`.
 * Wiring: the in-process core and filesystem are real; nothing is mocked.
 * Run: pnpm exec vitest run packages/node-sdk/test/session-workflows.test.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createKimiHarness, type Event, type KimiError, type Session } from '#/index';

import { makeTempDir, removeTempDirs, waitForSDKEvent } from './session-runtime-helpers';
import { TEST_IDENTITY } from './test-identity';

const FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_DYNAMIC_WORKFLOWS';

const tempDirs: string[] = [];

beforeEach(() => {
  vi.stubEnv('KIMI_CODE_EXPERIMENTAL_FLAG', '');
  vi.stubEnv(FLAG_ENV, '1');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await removeTempDirs(tempDirs);
});

function workflowScript(name: string): string {
  return `export const meta = {
  name: '${name}',
  description: 'SDK demo workflow ${name}.',
  phases: [{ title: 'Phase A' }, { title: 'Phase B' }],
};
phase('Phase A');
log('working on ' + args);
phase('Phase B');
return { name: '${name}', args };
`;
}

describe('Session workflows', () => {
  it('rejects workflow methods when the flag is disabled', async () => {
    vi.stubEnv(FLAG_ENV, '');
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-wf-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-wf-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_sdk_wf_flag_off', workDir });
      await expect(session.listWorkflows()).rejects.toMatchObject({
        name: 'KimiError',
        code: 'request.invalid',
      } satisfies Partial<KimiError>);
    } finally {
      await harness.close();
    }
  });

  it('lists project workflows and inspects their script', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-wf-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-wf-work-');
    const dir = join(workDir, '.kimi-code', 'workflows');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'proj-flow.js'), workflowScript('proj-flow'), 'utf8');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_sdk_wf_list', workDir });

      const { workflows, skipped } = await session.listWorkflows();
      expect(skipped).toEqual([]);
      expect(workflows.find((workflow) => workflow.name === 'proj-flow')).toMatchObject({
        name: 'proj-flow',
        description: 'SDK demo workflow proj-flow.',
        source: 'project',
        phases: [{ title: 'Phase A' }, { title: 'Phase B' }],
      });
      expect(JSON.stringify(workflows)).not.toContain('export const meta');

      const { workflow } = await session.getWorkflow('proj-flow');
      expect(workflow?.script).toContain('export const meta');
      await expect(session.getWorkflow('missing')).resolves.toEqual({ workflow: null });
    } finally {
      await harness.close();
    }
  });

  it('runs an inline workflow, emits workflow.run.* events, and exposes the run', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-wf-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-wf-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_sdk_wf_run', workDir });
      const events: Event[] = [];
      const unsubscribe = session.onEvent((event) => {
        events.push(event);
      });
      const completedEvent = waitForSDKEvent(
        session,
        (event) => event.type === 'workflow.run.completed',
      );

      const started = await session.runWorkflow({
        script: workflowScript('inline-flow'),
        args: 'sdk',
      });
      expect(started.workflowName).toBe('inline-flow');
      expect(started.runId).toMatch(/^wfrun-/);

      const completed = await completedEvent;
      unsubscribe();
      expect(completed).toMatchObject({
        type: 'workflow.run.completed',
        runId: started.runId,
        status: 'completed',
        resultJson: JSON.stringify({ name: 'inline-flow', args: 'sdk' }),
      });
      const types = events.map((event) => event.type);
      expect(types).toContain('workflow.run.started');
      expect(types).toContain('workflow.run.phase');
      expect(types).toContain('workflow.run.log');

      const run = await waitForRunSettled(session, started.runId);
      expect(run).toMatchObject({
        runId: started.runId,
        workflowName: 'inline-flow',
        status: 'completed',
        source: 'extra',
        args: 'sdk',
      });
      expect(run.script).toContain('export const meta');
      expect(run.logs).toContain('[log] working on sdk');

      const { runs } = await session.listWorkflowRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0]).not.toHaveProperty('script');

      // Cancel on a settled run is a no-op.
      await expect(session.cancelWorkflowRun(started.runId)).resolves.toEqual({
        cancelled: false,
      });
    } finally {
      await harness.close();
    }
  });

  it('saves a workflow to the project scope and lists it after the implicit reload', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-wf-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-wf-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_sdk_wf_save', workDir });

      const saved = await session.saveWorkflow({
        script: workflowScript('saved-flow'),
        scope: 'project',
      });
      expect(saved.name).toBe('saved-flow');
      expect(saved.path).toBe(join(workDir, '.kimi-code', 'workflows', 'saved-flow.js'));

      const { workflows } = await session.listWorkflows();
      expect(workflows.some((workflow) => workflow.name === 'saved-flow')).toBe(true);

      const started = await session.runWorkflow({ name: 'saved-flow' });
      const run = await waitForRunSettled(session, started.runId);
      expect(run).toMatchObject({ status: 'completed', source: 'project' });
    } finally {
      await harness.close();
    }
  });

  it('full lifecycle: generate → review → approve → monitor → conclude → save → reuse', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-wf-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-wf-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_sdk_wf_cycle', workDir });

      // 1. GENERATE: a script drafted (by the model or the user) is proposed.
      const script = workflowScript('cycle-flow');

      // 2. REVIEW: the caller inspects metadata/phases and the raw script
      //    before anything executes (no run exists yet).
      const reviewed = await session.saveWorkflow({ script, scope: 'project' });
      const { workflow: inspected } = await session.getWorkflow(reviewed.name);
      expect(inspected).toMatchObject({
        name: 'cycle-flow',
        source: 'project',
        phases: [{ title: 'Phase A' }, { title: 'Phase B' }],
      });
      expect(inspected?.script).toBe(script);
      await expect(session.listWorkflowRuns()).resolves.toEqual({ runs: [] });

      // 3. APPROVE: execution happens only through an explicit run call.
      // 4. MONITOR: phase/log events stream while the run is live.
      const phases: string[] = [];
      const unsubscribe = session.onEvent((event) => {
        if (event.type === 'workflow.run.phase') phases.push(event.phase);
      });
      const completedEvent = waitForSDKEvent(
        session,
        (event) => event.type === 'workflow.run.completed',
      );
      const started = await session.runWorkflow({ name: 'cycle-flow', args: 'cycle' });

      // 5. CONCLUDE: terminal event carries the truthful status and result.
      const completed = await completedEvent;
      unsubscribe();
      expect(completed).toMatchObject({
        type: 'workflow.run.completed',
        runId: started.runId,
        status: 'completed',
      });
      expect(phases).toEqual(['Phase A', 'Phase B']);
      const run = await waitForRunSettled(session, started.runId);
      expect(run.resultJson).toBe(JSON.stringify({ name: 'cycle-flow', args: 'cycle' }));

      // 6. SAVE: already persisted by the review step — visible with its path.
      const { workflows } = await session.listWorkflows();
      const saved = workflows.find((workflow) => workflow.name === 'cycle-flow');
      expect(saved?.path).toBe(join(workDir, '.kimi-code', 'workflows', 'cycle-flow.js'));

      // 7. REUSE: run the saved definition again by name.
      const rerun = await session.runWorkflow({ name: 'cycle-flow', args: 'again' });
      const rerunResult = await waitForRunSettled(session, rerun.runId);
      expect(rerunResult).toMatchObject({ status: 'completed', source: 'project' });
      expect(rerunResult.resultJson).toBe(JSON.stringify({ name: 'cycle-flow', args: 'again' }));

      const { runs } = await session.listWorkflowRuns();
      expect(runs).toHaveLength(2);
    } finally {
      await harness.close();
    }
  });
});

async function waitForRunSettled(
  session: Session,
  runId: string,
): Promise<NonNullable<Awaited<ReturnType<Session['getWorkflowRun']>>['run']>> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const { run } = await session.getWorkflowRun(runId);
    if (run !== null && run.status !== 'running') return run;
    await delay(10);
  }
  throw new Error(`Timed out waiting for workflow run ${runId} to settle`);
}
