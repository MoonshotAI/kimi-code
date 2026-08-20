import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TestInstantiationService } from '#/_base/di/test';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IAgentFlowService } from '#/features/flow/flow';
import { FlowStartTool } from '#/features/flow/tools/start/startTool';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
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
  let fileText: string | undefined;
  let userFileText: string | undefined;
  let active: boolean;
  let startResult: boolean;
  let start: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ix = new TestInstantiationService();
    fileText = VALID_DEFINITION;
    userFileText = undefined;
    active = false;
    startResult = true;
    start = vi.fn(() => startResult);
    const runtime = {
      identity: { workspaceId: 'w', runtimeId: 'r', generation: 'g1' },
      workspace: { mapRoots: (roots: unknown) => roots },
      path,
      fs: {
        readText: async () => {
          if (fileText === undefined) throw new Error('not found');
          return fileText;
        },
      },
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
      hasPendingActivation: () => false,
    } as unknown as IAgentFlowService);
    ix.stub(IHostFileSystem, {
      readText: async (target: string) => {
        if (userFileText === undefined || !target.startsWith('/home/.kimi-code/flows/')) {
          throw new Error('not found');
        }
        return userFileText;
      },
    } as unknown as IHostFileSystem);
    ix.stub(IBootstrapService, {
      homeDir: '/home/.kimi-code',
    } as unknown as IBootstrapService);
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

  it('falls back to the user-level flows directory when the project file is missing', async () => {
    fileText = undefined;
    userFileText = VALID_DEFINITION;
    const result = await execute('issue-fix');
    expect(result.isError).not.toBe(true);
    expect(result.output).toContain('Flow run started: `issue-fix`');
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ id: 'issue-fix' }), 'fix #1');
  });

  it('names both directories when the definition exists in neither', async () => {
    fileText = undefined;
    const result = await execute('issue-fix');
    expect(result.isError).toBe(true);
    expect(result.output).toContain('.kimi-code/flows');
    expect(result.output).toContain('/home/.kimi-code/flows/issue-fix.md');
    expect(start).not.toHaveBeenCalled();
  });

  it('falls back to a valid user definition when the project file is invalid', async () => {
    fileText = 'not a flow definition';
    userFileText = VALID_DEFINITION;
    const result = await execute('issue-fix');
    expect(result.isError).not.toBe(true);
    expect(result.output).toContain('Flow run started: `issue-fix`');
  });

  it('falls back to the user definition when the project id mismatches, and reports the project error when the user file is missing', async () => {
    fileText = VALID_DEFINITION.replace('id: issue-fix', 'id: other-flow');
    userFileText = VALID_DEFINITION;
    const fallback = await execute('issue-fix');
    expect(fallback.isError).not.toBe(true);
    expect(fallback.output).toContain('Flow run started: `issue-fix`');

    start.mockClear();
    userFileText = undefined;
    active = false;
    const failed = await execute('issue-fix');
    expect(failed.isError).toBe(true);
    expect(failed.output).toContain('does not match');
    expect(start).not.toHaveBeenCalled();
  });
});
