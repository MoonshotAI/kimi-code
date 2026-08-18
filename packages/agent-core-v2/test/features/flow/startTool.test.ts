import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TestInstantiationService } from '#/_base/di/test';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { IAgentFlowService } from '#/features/flow/flow';
import { FlowStartTool } from '#/features/flow/tools/start/startTool';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import type { ExecutableToolContext, RunnableToolExecution, ToolExecution } from '#/tool/toolContract';

const CTX: ExecutableToolContext = {
  turnId: 0,
  toolCallId: 'call_start',
  signal: new AbortController().signal,
};

const VALID_DEFINITION = `---
id: issue-fix
stages:
  - id: triage
    objective: find it
    completion: found
---
`;

function runnable(execution: ToolExecution): RunnableToolExecution {
  if (!('execute' in execution)) throw new Error('expected a runnable execution');
  return execution;
}

describe('FlowStartTool', () => {
  let ix: TestInstantiationService;
  let tool: FlowStartTool;
  let fileText: string;
  let active: boolean;
  let startResult: boolean;
  let start: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ix = new TestInstantiationService();
    fileText = VALID_DEFINITION;
    active = false;
    startResult = true;
    start = vi.fn(() => startResult);
    const runtime = {
      identity: { workspaceId: 'w', runtimeId: 'r', generation: 'g1' },
      workspace: { mapRoots: (roots: unknown) => roots },
      path,
      fs: { readText: async () => fileText },
    };
    ix.stub(IAgentRuntimeService, {
      inspect: () => runtime,
      acquire: () => ({ runtime, dispose: () => {} }),
    } as unknown as IAgentRuntimeService);
    ix.stub(ISessionWorkspaceContext, {
      workDir: '/ws',
      additionalDirs: [],
    } as unknown as ISessionWorkspaceContext);
    ix.stub(IAgentFlowService, {
      run: () => ({ active }),
      start,
    } as unknown as IAgentFlowService);
    tool = ix.createInstance(FlowStartTool);
  });

  function execute(flow: string) {
    return runnable(tool.resolveExecution({ flow, task: 'fix #1' })).execute(CTX);
  }

  it('starts a run whose definition id matches the requested flow', async () => {
    const result = await execute('issue-fix');
    expect(result.isError).not.toBe(true);
    expect(result.output).toContain('Flow run started: `issue-fix`');
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ id: 'issue-fix' }), 'fix #1');
  });

  it('rejects a definition whose id differs from the requested flow', async () => {
    fileText = VALID_DEFINITION.replace('id: issue-fix', 'id: other-flow');
    const result = await execute('issue-fix');
    expect(result.isError).toBe(true);
    expect(result.output).toContain('does not match');
    expect(start).not.toHaveBeenCalled();
  });

  it('reports an error when the service did not start the run', async () => {
    startResult = false;
    const result = await execute('issue-fix');
    expect(result.isError).toBe(true);
    expect(result.output).toContain('disabled');
  });

  it('reports an active-run race, not a disabled flag, when start loses', async () => {
    start.mockImplementationOnce(() => {
      active = true;
      return false;
    });
    const result = await execute('issue-fix');
    expect(result.isError).toBe(true);
    expect(result.output).toContain('became active');
    expect(result.output).not.toContain('disabled');
  });

  it('refuses to start while a run is already active', async () => {
    active = true;
    const result = await execute('issue-fix');
    expect(result.isError).toBe(true);
    expect(result.output).toContain('already active');
    expect(start).not.toHaveBeenCalled();
  });
});
