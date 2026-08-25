import { describe, expect, it } from 'vitest';
import { toAppTask } from '../src/api/daemon/mappers';
import type { WireTask } from '../src/api/daemon/wire';

const backgroundTask: WireTask = {
  id: 'task-9',
  session_id: 's1',
  kind: 'subagent',
  description: 'Explore repo',
  status: 'running',
  created_at: '2026-07-28T00:00:00.000Z',
  run_in_background: true,
};

describe('subagent task identity', () => {
  it('does not treat a REST background-task id as an agent id', () => {
    expect(toAppTask(backgroundTask)).toMatchObject({
      id: 'task-9',
      agentId: undefined,
    });
  });

  it('retains an explicit server agent id', () => {
    expect(toAppTask({ ...backgroundTask, agent_id: 'agent-1' })).toMatchObject({
      id: 'task-9',
      agentId: 'agent-1',
    });
  });

  it('marks snapshot roster ids as known agent ids', () => {
    expect(toAppTask({ ...backgroundTask, id: 'agent-2' }, 'agent-2')).toMatchObject({
      id: 'agent-2',
      agentId: 'agent-2',
    });
  });

  it('carries the bound model alias through (REST rows and snapshot roster alike)', () => {
    expect(toAppTask({ ...backgroundTask, model: 'provider/secondary' })).toMatchObject({
      model: 'provider/secondary',
    });
    expect(toAppTask(backgroundTask).model).toBeUndefined();
  });

  it('carries the thinking effort through', () => {
    expect(
      toAppTask({ ...backgroundTask, model: 'provider/secondary', thinking_effort: 'low' }),
    ).toMatchObject({ model: 'provider/secondary', thinkingEffort: 'low' });
    expect(toAppTask(backgroundTask).thinkingEffort).toBeUndefined();
  });

  it('reads run_in_background straight from the wire (contract-required)', () => {
    expect(toAppTask(backgroundTask).runInBackground).toBe(true);
    expect(toAppTask({ ...backgroundTask, run_in_background: false }).runInBackground).toBe(false);
  });

  it('rejects a wire row missing run_in_background as a protocol error', () => {
    const { run_in_background: _omitted, ...withoutFlag } = backgroundTask;
    expect(() => toAppTask(withoutFlag as unknown as WireTask)).toThrow(
      /missing required run_in_background/,
    );
  });
});
