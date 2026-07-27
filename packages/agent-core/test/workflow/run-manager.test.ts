import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '../../src/rpc/events';
import {
  DEFAULT_WORKFLOW_LIMITS,
  WorkflowRunManager,
  type WorkflowDefinition,
  type WorkflowHost,
} from '../../src/workflow';
import { createBackgroundManager, waitForTerminal } from '../agent/background/helpers';

function definitionFor(script: string): WorkflowDefinition {
  return {
    meta: {
      name: 'demo',
      description: 'Demo workflow.',
      phases: [{ title: 'Phase A' }, { title: 'Phase B' }],
    },
    script,
    path: '',
    source: 'project',
  };
}

const HAPPY_SCRIPT = `export const meta = {
  name: 'demo',
  description: 'Demo workflow.',
  phases: [{ title: 'Phase A' }, { title: 'Phase B' }],
};
phase('Phase A');
log('hello');
const a = await agent('do a', { label: 'worker' });
phase('Phase B');
return { a };
`;

function setup(host: WorkflowHost): {
  runManager: WorkflowRunManager;
  events: AgentEvent[];
  manager: ReturnType<typeof createBackgroundManager>['manager'];
} {
  const { manager } = createBackgroundManager();
  const events: AgentEvent[] = [];
  const runManager = new WorkflowRunManager({
    backgroundManager: () => manager,
    emitEvent: (event) => {
      events.push(event);
    },
    createHost: () => host,
  });
  return { runManager, events, manager };
}

function workflowEvents(events: AgentEvent[]): AgentEvent[] {
  return events.filter((event) => event.type.startsWith('workflow.run.'));
}

describe('WorkflowRunManager', () => {
  it('runs a workflow to completion with ordered events, resultJson, and task info', async () => {
    const host: WorkflowHost = {
      runAgent: async () => ({ status: 'ok', text: 'result-a' }),
    };
    const { runManager, events, manager } = setup(host);

    const { runId, taskId } = runManager.start(definitionFor(HAPPY_SCRIPT), {
      args: '',
      limits: DEFAULT_WORKFLOW_LIMITS,
    });

    expect(runManager.get(runId)?.status).toBe('running');
    expect(runManager.list()).toHaveLength(1);
    const startedInfo = manager.getTask(taskId);
    expect(startedInfo?.kind).toBe('workflow');

    const info = await waitForTerminal(manager, taskId);
    expect(info?.status).toBe('completed');
    if (info?.kind !== 'workflow') throw new Error('expected workflow task info');
    expect(info.workflowName).toBe('demo');
    expect(info.phase).toBe('Phase B');
    expect(info.phaseIndex).toBe(1);
    expect(info.agentCalls).toBe(1);
    expect(info.phases).toEqual([{ title: 'Phase A' }, { title: 'Phase B' }]);

    const record = runManager.get(runId)!;
    expect(record.status).toBe('completed');
    expect(record.resultJson).toBe(JSON.stringify({ a: 'result-a' }));
    expect(record.agentCalls).toBe(1);
    expect(record.endedAt).toBeDefined();
    expect(record.logs).toEqual([
      '[phase] Phase A',
      '[log] hello',
      '[agent#1 worker] started',
      '[agent#1 worker] ok',
      '[phase] Phase B',
    ]);

    const output = await manager.readOutput(taskId);
    expect(output).toContain('[phase] Phase A');
    expect(output).toContain('[result] {"a":"result-a"}');

    expect(workflowEvents(events).map((event) => event.type)).toEqual([
      'workflow.run.started',
      'workflow.run.phase',
      'workflow.run.log',
      'workflow.run.agent_call',
      'workflow.run.agent_call',
      'workflow.run.phase',
      'workflow.run.completed',
    ]);
    expect(events[0]).toEqual({
      type: 'workflow.run.started',
      runId,
      taskId,
      workflowName: 'demo',
      description: 'Demo workflow.',
      phases: [{ title: 'Phase A' }, { title: 'Phase B' }],
    });
    expect(events).toContainEqual({
      type: 'workflow.run.phase',
      runId,
      phase: 'Phase A',
      phaseIndex: 0,
    });
    expect(events).toContainEqual({ type: 'workflow.run.log', runId, message: 'hello' });
    expect(events).toContainEqual({
      type: 'workflow.run.agent_call',
      runId,
      index: 1,
      label: 'worker',
      phase: 'Phase A',
      state: 'ok',
    });
    expect(events.at(-1)).toEqual({
      type: 'workflow.run.completed',
      runId,
      status: 'completed',
      agentCalls: 1,
      error: undefined,
      resultJson: JSON.stringify({ a: 'result-a' }),
    });
  });

  it('propagates a host error as failed with the completed event carrying the error', async () => {
    const host: WorkflowHost = {
      runAgent: async () => ({ status: 'error', message: 'subagent exploded' }),
    };
    const { runManager, events, manager } = setup(host);

    const { runId, taskId } = runManager.start(definitionFor(HAPPY_SCRIPT), {
      args: '',
      limits: DEFAULT_WORKFLOW_LIMITS,
    });

    const info = await waitForTerminal(manager, taskId);
    expect(info?.status).toBe('failed');
    expect(info?.stopReason).toBe('subagent exploded');

    const record = runManager.get(runId)!;
    expect(record.status).toBe('failed');
    expect(record.error).toBe('subagent exploded');
    expect(record.resultJson).toBeUndefined();

    expect(events.at(-1)).toEqual({
      type: 'workflow.run.completed',
      runId,
      status: 'failed',
      agentCalls: 1,
      error: 'subagent exploded',
      resultJson: undefined,
    });
  });

  it('cancel(runId) aborts the run: record cancelled, task terminated, completed event cancelled', async () => {
    const host: WorkflowHost = {
      runAgent: () => new Promise(() => {}),
    };
    const { runManager, events, manager } = setup(host);

    const { runId, taskId } = runManager.start(definitionFor(HAPPY_SCRIPT), {
      args: '',
      limits: DEFAULT_WORKFLOW_LIMITS,
    });

    // Give the run a tick to reach the pending agent call.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(runManager.cancel(runId)).toBe(true);

    const info = await waitForTerminal(manager, taskId);
    expect(info?.status).toBe('killed');

    const record = runManager.get(runId)!;
    expect(record.status).toBe('cancelled');
    expect(events.at(-1)).toMatchObject({
      type: 'workflow.run.completed',
      runId,
      status: 'cancelled',
    });

    // A second cancel on a finished run is a no-op.
    expect(runManager.cancel(runId)).toBe(false);
    expect(runManager.cancel('missing')).toBe(false);
  });

  it('bounds the record log buffer to the most recent 200 entries', async () => {
    const script = `export const meta = {
  name: 'demo',
  description: 'Demo workflow.',
  phases: [{ title: 'Phase A' }, { title: 'Phase B' }],
};
for (let i = 0; i < 250; i += 1) log('line ' + i);
return null;
`;
    const host: WorkflowHost = {
      runAgent: async () => ({ status: 'ok', text: 'unused' }),
    };
    const { runManager, manager } = setup(host);

    const { runId, taskId } = runManager.start(definitionFor(script), {
      args: '',
      limits: DEFAULT_WORKFLOW_LIMITS,
    });
    await waitForTerminal(manager, taskId);

    const record = runManager.get(runId)!;
    expect(record.status).toBe('completed');
    expect(record.logs).toHaveLength(200);
    expect(record.logs[0]).toBe('[log] line 50');
    expect(record.logs.at(-1)).toBe('[log] line 249');
  });
});
