import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ServicesAccessor } from '#/_base/di/instantiation';
import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { getAgentToolContributions } from '#/agent/toolRegistry/toolContribution';
import type { ExecutableToolContext, RunnableToolExecution } from '#/tool/toolContract';
import { IConfigService } from '#/app/config/config';
import { DEFAULT_WORKFLOWS_CONFIG, WORKFLOWS_SECTION } from '#/app/workflow/configSection';
import { IFlagService } from '#/app/flag/flag';
import { DYNAMIC_WORKFLOWS_FLAG_ID } from '#/app/workflow/flag';
import { WORKFLOW_TOOL_NAME } from '#/app/workflow/workflow.types';
import type { WorkflowDefinition } from '#/app/workflow/runtime/types';
import { IWorkflowCatalogService } from '#/app/workflow/workflowCatalog';
import {
  IWorkflowRunService,
  type StartWorkflowRunInput,
} from '#/session/workflow/sessionWorkflowRun';

import { IWorkflowTool, WORKFLOW_NAME_OR_SCRIPT_REQUIRED } from '#/agent/tools/workflow/workflow';
import { WorkflowTool } from '#/agent/tools/workflow/workflowTool';

const INLINE_SCRIPT = `export const meta = {
  name: 'inline-flow',
  description: 'Inline workflow.',
  phases: [{ title: 'Main' }],
};
return 'done';
`;

function ctx(): ExecutableToolContext {
  return { turnId: 1, toolCallId: 'call_1', signal: new AbortController().signal };
}

describe('WorkflowTool', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let flagEnabled: boolean;
  let started: StartWorkflowRunInput[];

  beforeEach(() => {
    disposables = new DisposableStore();
    flagEnabled = true;
    started = [];
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.definePartialInstance(IWorkflowRunService, {
          start: (input: StartWorkflowRunInput) => {
            started.push(input);
            return Promise.resolve({ runId: 'wfrun-test', taskId: 'task-1' });
          },
        });
        reg.definePartialInstance(IWorkflowCatalogService, {
          ready: Promise.resolve(),
          list: () => [] as readonly WorkflowDefinition[],
          get: () => undefined,
        });
        reg.definePartialInstance(IFlagService, { enabled: () => flagEnabled });
        reg.definePartialInstance(IConfigService, {
          get: <T = unknown>(domain: string): T =>
            (domain === WORKFLOWS_SECTION ? DEFAULT_WORKFLOWS_CONFIG : undefined) as T,
        });
        reg.defineInstance(IAgentScopeContext, makeAgentScopeContext({ agentId: 'main', agentScope: 'agents/main' }));
        reg.define(IWorkflowTool, WorkflowTool);
      },
    });
  });
  afterEach(() => disposables.dispose());

  it('is gated by the dynamic-workflows flag through the contribution when-predicate', () => {
    const contribution = getAgentToolContributions().find(
      (entry) => entry.options.name === WORKFLOW_TOOL_NAME,
    );
    expect(contribution).toBeDefined();
    const accessor = {
      get: () => ({ enabled: (id: string) => id === DYNAMIC_WORKFLOWS_FLAG_ID && flagEnabled }),
    } as unknown as ServicesAccessor;
    flagEnabled = false;
    expect(contribution!.options.when?.(accessor)).toBe(false);
    flagEnabled = true;
    expect(contribution!.options.when?.(accessor)).toBe(true);
  });

  it('rejects input with both or neither of name and script', async () => {
    const tool = ix.get(IWorkflowTool);
    for (const input of [
      { name: 'deep-research', script: INLINE_SCRIPT },
      {},
    ]) {
      const execution = await tool.resolveExecution(input);
      expect('execute' in execution).toBe(false);
      if (!('execute' in execution)) {
        expect(execution.output).toBe(WORKFLOW_NAME_OR_SCRIPT_REQUIRED);
      }
    }
    expect(started).toEqual([]);
  });

  it('starts a run by name and returns the run/task ids without blocking', async () => {
    const tool = ix.get(IWorkflowTool);
    const execution = await tool.resolveExecution({ name: 'deep-research', args: 'topic' });
    expect('isError' in execution).toBe(false);
    const result = await (execution as RunnableToolExecution).execute(ctx());

    expect(result.isError).toBeUndefined();
    expect(started).toEqual([
      { name: 'deep-research', script: undefined, args: 'topic', callerAgentId: 'main' },
    ]);
    expect(result.output).toContain('run_id: wfrun-test');
    expect(result.output).toContain('task_id: task-1');
    expect(result.output).toContain('status: running');
  });

  it('starts a run with an inline script', async () => {
    const tool = ix.get(IWorkflowTool);
    const execution = await tool.resolveExecution({ script: INLINE_SCRIPT, args: '' });
    const result = await (execution as RunnableToolExecution).execute(ctx());

    expect(result.isError).toBeUndefined();
    expect(started[0]?.script).toBe(INLINE_SCRIPT);
    expect(started[0]?.name).toBeUndefined();
  });

  it('refuses to run when the flag is off at execution time', async () => {
    flagEnabled = false;
    const tool = ix.get(IWorkflowTool);
    const execution = await tool.resolveExecution({ name: 'deep-research' });
    const result = await (execution as RunnableToolExecution).execute(ctx());

    expect(result.isError).toBe(true);
    expect(result.output).toContain('disabled');
    expect(started).toEqual([]);
  });

  it('surfaces run-service errors as tool errors', async () => {
    const tool = ix.get(IWorkflowTool);
    ix.stub(IWorkflowRunService, 'start', () => Promise.reject(new Error('Workflow "x" not found')));
    const execution = await tool.resolveExecution({ name: 'x' });
    const result = await (execution as RunnableToolExecution).execute(ctx());

    expect(result.isError).toBe(true);
    expect(result.output).toContain('not found');
  });
});
