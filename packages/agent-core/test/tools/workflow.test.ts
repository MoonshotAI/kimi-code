import { describe, expect, it, vi } from 'vitest';

import { WorkflowTool } from '../../src/tools/builtin/collaboration/workflow';
import type { SessionWorkflowRegistry } from '../../src/workflow/registry';
import type { WorkflowRunManager } from '../../src/workflow/run-manager';
import type { WorkflowDefinition } from '../../src/workflow/types';

const SCRIPT = `export const meta = {
  name: 'demo-flow',
  description: 'Demo workflow.',
  phases: [{ title: 'One', detail: 'first' }, { title: 'Two' }],
};
phase('One');
return { ok: true };
`;

function savedDefinition(name = 'saved-flow'): WorkflowDefinition {
  return {
    meta: { name, description: `Saved ${name}.`, phases: [{ title: 'Only' }] },
    script: SCRIPT.replace('demo-flow', name),
    path: `/tmp/${name}.js`,
    source: 'project',
  };
}

function fakeAgent(options: {
  workflows?: Partial<SessionWorkflowRegistry>;
  workflowRuns?: Partial<WorkflowRunManager>;
}) {
  return {
    kimiConfig: undefined,
    workflows: options.workflows,
    workflowRuns: options.workflowRuns,
  } as never;
}

function workflowRegistry(list: WorkflowDefinition[] = [savedDefinition()]): SessionWorkflowRegistry {
  return {
    load: vi.fn(async () => {}),
    get: (name: string) => list.find((workflow) => workflow.meta.name === name),
    list: () => list,
  } as unknown as SessionWorkflowRegistry;
}

function runManager(): WorkflowRunManager & { start: ReturnType<typeof vi.fn> } {
  return {
    start: vi.fn(() => ({ runId: 'wfrun-test', taskId: 'workflow-test' })),
  } as unknown as WorkflowRunManager & { start: ReturnType<typeof vi.fn> };
}

describe('WorkflowTool', () => {
  it('rejects input with neither name nor script, and with both', async () => {
    const tool = new WorkflowTool(fakeAgent({}));
    const neither = await tool.resolveExecution({});
    expect(neither).toMatchObject({ isError: true });
    const both = await tool.resolveExecution({ name: 'x', script: 'y' });
    expect(both).toMatchObject({ isError: true });
  });

  it('rejects an invalid inline script with a validation message', async () => {
    const tool = new WorkflowTool(fakeAgent({}));
    const result = await tool.resolveExecution({ script: 'return 1;' });
    expect(result).toMatchObject({ isError: true });
    if ('output' in result) expect(String(result.output)).toContain('Invalid workflow script');
  });

  it('builds a workflow_run display for an inline script and starts the run on execute', async () => {
    const runs = runManager();
    const tool = new WorkflowTool(fakeAgent({ workflowRuns: runs }));
    const execution = await tool.resolveExecution({ script: SCRIPT, args: 'topic' });
    expect('isError' in execution && execution.isError).toBe(false);
    expect(execution).toMatchObject({
      approvalRule: 'Workflow',
      display: {
        kind: 'workflow_run',
        workflow_name: 'demo-flow',
        description: 'Demo workflow.',
        phases: [{ title: 'One', detail: 'first' }, { title: 'Two' }],
        args: 'topic',
        source: 'inline',
        limits: { max_concurrency: 4, max_agent_calls: 50, max_duration_ms: 1_800_000 },
      },
    });
    if (!('display' in execution) || execution.display?.kind !== 'workflow_run') {
      throw new Error('expected workflow_run display');
    }
    expect(execution.display.script).toBe(SCRIPT);
    expect(execution.display.consumption_warning).toContain('tokens');

    if (!('execute' in execution)) throw new Error('expected runnable execution');
    const result = await execution.execute({
      turnId: '0',
      toolCallId: 'call_workflow',
      signal: new AbortController().signal,
    });
    expect(runs.start).toHaveBeenCalledOnce();
    expect(result.isError).toBeUndefined();
    expect(String(result.output)).toContain('wfrun-test');
  });

  it('resolves a saved workflow by name through the registry', async () => {
    const registry = workflowRegistry();
    const runs = runManager();
    const tool = new WorkflowTool(fakeAgent({ workflows: registry, workflowRuns: runs }));
    const execution = await tool.resolveExecution({ name: 'saved-flow' });
    expect(registry.load).toHaveBeenCalledOnce();
    expect('isError' in execution && execution.isError).toBe(false);
    expect(execution).toMatchObject({
      display: { kind: 'workflow_run', workflow_name: 'saved-flow', source: 'project' },
    });
  });

  it('returns an error listing available workflows when the name is unknown', async () => {
    const tool = new WorkflowTool(fakeAgent({ workflows: workflowRegistry() }));
    const result = await tool.resolveExecution({ name: 'missing' });
    expect(result).toMatchObject({ isError: true });
    if ('output' in result) expect(String(result.output)).toContain('saved-flow');
  });

  it('matches approval rules against the workflow name', async () => {
    const tool = new WorkflowTool(fakeAgent({ workflowRuns: runManager() }));
    const execution = await tool.resolveExecution({ script: SCRIPT });
    if (!('matchesRule' in execution) || execution.matchesRule === undefined) {
      throw new Error('expected matchesRule');
    }
    expect(execution.matchesRule('demo-flow')).toBe(true);
    expect(execution.matchesRule('other')).toBe(false);
  });
});
