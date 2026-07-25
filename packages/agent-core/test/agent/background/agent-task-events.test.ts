/**
 * Covers live subagent event streaming into the background task output
 * buffer (https://github.com/MoonshotAI/kimi-code/issues/667): while the
 * subagent is still running, TaskOutput must show its turns, tool calls,
 * and thinking/assistant text instead of a static preview.
 */

import { describe, expect, it, vi } from 'vitest';

import { AgentBackgroundTask } from '../../../src/agent/background';
import type { AgentEvent } from '../../../src/rpc/events';
import type { SubagentHandle } from '../../../src/session/subagent-host';

import { createBackgroundManager, waitForTerminal } from './helpers';

function createEventSource(): {
  readonly subscribe: (callback: (event: AgentEvent) => void) => () => void;
  readonly emit: (event: AgentEvent) => void;
  readonly hasSubscribers: () => boolean;
} {
  const callbacks = new Set<(event: AgentEvent) => void>();
  return {
    subscribe: (callback) => {
      callbacks.add(callback);
      return () => {
        callbacks.delete(callback);
      };
    },
    emit: (event) => {
      for (const callback of callbacks) callback(event);
    },
    hasSubscribers: () => callbacks.size > 0,
  };
}

function createControlledCompletion(): {
  readonly completion: Promise<{ result: string }>;
  readonly resolve: (value: { result: string }) => void;
} {
  let resolve!: (value: { result: string }) => void;
  const completion = new Promise<{ result: string }>((res) => {
    resolve = res;
  });
  return { completion, resolve };
}

async function registerStreamingTask(
  manager: ReturnType<typeof createBackgroundManager>['manager'],
  source: ReturnType<typeof createEventSource>,
  completion: Promise<{ result: string }>,
): Promise<string> {
  const handle: SubagentHandle = {
    agentId: 'agent-child',
    profileName: 'coder',
    resumed: false,
    completion,
    subscribeToEvents: source.subscribe,
  };
  const taskId = manager.registerTask(
    new AgentBackgroundTask(handle, 'inspect repo', { markActiveChildDetached: vi.fn() }, new AbortController()),
  );
  // The task lifecycle (and with it the event subscription) starts async.
  await vi.waitFor(() => {
    expect(source.hasSubscribers()).toBe(true);
  });
  return taskId;
}

describe('AgentBackgroundTask — live event streaming', () => {
  it('streams turns, tool calls, and thinking into the output before completion', async () => {
    const { manager } = createBackgroundManager();
    const source = createEventSource();
    const { completion, resolve } = createControlledCompletion();
    const taskId = await registerStreamingTask(manager, source, completion);

    source.emit({ type: 'turn.started', turnId: 0, origin: { kind: 'user' } });
    source.emit({ type: 'thinking.delta', turnId: 0, delta: 'planning ' });
    source.emit({ type: 'thinking.delta', turnId: 0, delta: 'steps' });
    source.emit({ type: 'assistant.delta', turnId: 0, delta: 'reading files' });
    source.emit({
      type: 'tool.call.started',
      turnId: 0,
      toolCallId: 'call-1',
      name: 'Read',
      args: { path: 'a.ts' },
    });
    source.emit({
      type: 'tool.result',
      turnId: 0,
      toolCallId: 'call-1',
      output: 'file contents',
    });
    source.emit({ type: 'turn.ended', turnId: 0, reason: 'completed' });

    const running = await manager.readOutput(taskId);
    expect(running).toContain('[turn 0 started]');
    expect(running).toContain('[thinking]\nplanning steps');
    expect(running).toContain('[assistant]\nreading files');
    expect(running).toContain('[tool] Read: {"path":"a.ts"}');
    expect(running).toContain('[result]: file contents');
    expect(running).toContain('[turn 0 ended: completed]');
    expect(running).not.toContain('final summary');

    resolve({ result: 'final summary' });
    await waitForTerminal(manager, taskId);
    const done = await manager.readOutput(taskId);
    expect(done).toContain('final summary');
  });

  it('emits the stream marker once per uninterrupted thinking/assistant run', async () => {
    const { manager } = createBackgroundManager();
    const source = createEventSource();
    const { completion, resolve } = createControlledCompletion();
    const taskId = await registerStreamingTask(manager, source, completion);

    source.emit({ type: 'thinking.delta', turnId: 0, delta: 'a' });
    source.emit({ type: 'thinking.delta', turnId: 0, delta: 'b' });
    source.emit({ type: 'tool.call.started', turnId: 0, toolCallId: 'c', name: 'Bash', args: {} });
    source.emit({ type: 'thinking.delta', turnId: 0, delta: 'c' });

    const output = await manager.readOutput(taskId);
    expect(output).toContain('[thinking]\nab');
    expect(output).toContain('[thinking]\nc');
    expect(output.match(/\[thinking\]/g)).toHaveLength(2);

    resolve({ result: 'done' });
    await waitForTerminal(manager, taskId);
  });

  it('marks errored tool results and truncates long previews', async () => {
    const { manager } = createBackgroundManager();
    const source = createEventSource();
    const { completion, resolve } = createControlledCompletion();
    const taskId = await registerStreamingTask(manager, source, completion);

    source.emit({
      type: 'tool.result',
      turnId: 0,
      toolCallId: 'call-1',
      output: 'x'.repeat(500),
      isError: true,
    });

    const output = await manager.readOutput(taskId);
    expect(output).toContain(`[result error]: ${'x'.repeat(200)}…`);
    expect(output).not.toContain('x'.repeat(201));

    resolve({ result: 'done' });
    await waitForTerminal(manager, taskId);
  });

  it('unsubscribes when the task settles', async () => {
    const { manager } = createBackgroundManager();
    const source = createEventSource();
    const { completion, resolve } = createControlledCompletion();
    const taskId = await registerStreamingTask(manager, source, completion);

    resolve({ result: 'done' });
    await waitForTerminal(manager, taskId);
    expect(source.hasSubscribers()).toBe(false);

    const settled = await manager.readOutput(taskId);
    source.emit({ type: 'thinking.delta', turnId: 1, delta: 'late' });
    expect(await manager.readOutput(taskId)).toBe(settled);
  });

  it('unsubscribes when the subagent fails', async () => {
    const { manager } = createBackgroundManager();
    const source = createEventSource();
    let reject!: (error: Error) => void;
    const completion = new Promise<{ result: string }>((_resolve, rej) => {
      reject = rej;
    });
    const taskId = await registerStreamingTask(manager, source, completion);

    reject(new Error('subagent crashed'));
    const info = await waitForTerminal(manager, taskId);
    expect(info?.status).toBe('failed');
    expect(source.hasSubscribers()).toBe(false);

    const settled = await manager.readOutput(taskId);
    source.emit({ type: 'thinking.delta', turnId: 1, delta: 'late' });
    expect(await manager.readOutput(taskId)).toBe(settled);
  });
});
