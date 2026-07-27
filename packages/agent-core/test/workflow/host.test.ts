import { describe, expect, it, vi } from 'vitest';

import type { SpawnSubagentOptions, SubagentHandle } from '../../src/session/subagent-host';
import { buildWorkflowAgentPrompt, SubagentWorkflowHost } from '../../src/workflow';

function handleFor(result: Promise<{ result: string }>): SubagentHandle {
  return {
    agentId: 'agent-1',
    profileName: 'coder',
    resumed: false,
    completion: result as SubagentHandle['completion'],
  };
}

describe('SubagentWorkflowHost', () => {
  it('maps a completed subagent to an ok outcome and passes spawn options', async () => {
    const spawn = vi.fn(async (_options: SpawnSubagentOptions) =>
      handleFor(Promise.resolve({ result: 'agent says hi' })),
    );
    const host = new SubagentWorkflowHost({ spawn, runId: 'wfrun-abc' });

    const outcome = await host.runAgent(
      { prompt: 'do the thing', label: 'worker' },
      new AbortController().signal,
    );

    expect(outcome).toEqual({ status: 'ok', text: 'agent says hi' });
    expect(spawn).toHaveBeenCalledTimes(1);
    const options = spawn.mock.calls[0]![0];
    expect(options.parentToolCallId).toBe('workflow:wfrun-abc:1');
    expect(options.prompt).toBe('do the thing');
    expect(options.description).toBe('worker');
    expect(options.runInBackground).toBe(false);
    expect(options.profileName).toBe('coder');
  });

  it('increments the synthetic tool call id per call and defaults the description', async () => {
    const spawn = vi.fn(async (_options: SpawnSubagentOptions) =>
      handleFor(Promise.resolve({ result: 'ok' })),
    );
    const host = new SubagentWorkflowHost({ spawn, runId: 'wfrun-abc' });

    await host.runAgent({ prompt: 'first' }, new AbortController().signal);
    await host.runAgent({ prompt: 'second' }, new AbortController().signal);

    expect(spawn.mock.calls[0]![0].parentToolCallId).toBe('workflow:wfrun-abc:1');
    expect(spawn.mock.calls[1]![0].parentToolCallId).toBe('workflow:wfrun-abc:2');
    expect(spawn.mock.calls[0]![0].description).toBe('workflow agent');
  });

  it('appends structured-output instructions when schemaJson is present', async () => {
    const spawn = vi.fn(async (_options: SpawnSubagentOptions) =>
      handleFor(Promise.resolve({ result: '{"a":1}' })),
    );
    const host = new SubagentWorkflowHost({ spawn, runId: 'wfrun-abc' });
    const schemaJson = '{"type":"object"}';

    await host.runAgent({ prompt: 'analyze', schemaJson }, new AbortController().signal);

    const prompt = spawn.mock.calls[0]![0].prompt;
    expect(prompt).toContain('analyze');
    expect(prompt).toContain('STRUCTURED OUTPUT REQUIRED');
    expect(prompt).toContain(schemaJson);
    expect(buildWorkflowAgentPrompt({ prompt: 'p' })).toBe('p');
  });

  it('maps spawn/completion errors to error outcomes without throwing', async () => {
    const spawnFailure = new SubagentWorkflowHost({
      spawn: vi.fn(async () => {
        throw new Error('too many subagents');
      }),
      runId: 'wfrun-x',
    });
    await expect(
      spawnFailure.runAgent({ prompt: 'p' }, new AbortController().signal),
    ).resolves.toEqual({ status: 'error', message: 'too many subagents' });

    const completionFailure = new SubagentWorkflowHost({
      spawn: vi.fn(async () => handleFor(Promise.reject(new Error('turn failed')))),
      runId: 'wfrun-x',
    });
    await expect(
      completionFailure.runAgent({ prompt: 'p' }, new AbortController().signal),
    ).resolves.toEqual({ status: 'error', message: 'turn failed' });
  });

  it('maps an abort with a live run signal to refused', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    const host = new SubagentWorkflowHost({
      spawn: vi.fn(async () => handleFor(Promise.reject(abortError))),
      runId: 'wfrun-x',
    });

    await expect(host.runAgent({ prompt: 'p' }, new AbortController().signal)).resolves.toEqual({
      status: 'refused',
    });
  });

  it('maps an abort caused by the run signal to error (runtime converts to cancelled)', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    const controller = new AbortController();
    controller.abort(abortError);
    const host = new SubagentWorkflowHost({
      spawn: vi.fn(async () => handleFor(Promise.reject(abortError))),
      runId: 'wfrun-x',
    });

    const outcome = await host.runAgent({ prompt: 'p' }, controller.signal);
    expect(outcome.status).toBe('error');
  });
});
