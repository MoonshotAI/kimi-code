import { describe, expect, it } from 'vitest';

import { createFeature, type Feature, createApp, type App, useAgentTools } from '#/app/index';
import { createUserEntry } from '@moonshot-ai/agent-core/history/index';
import {
  createAssistantMessage,
  createUserMessage,
  extractText,
  type ToolCall,
} from '@moonshot-ai/agent-core/llm/message';
import type { LlmRequest } from '@moonshot-ai/agent-core/llm/request';
import type { LlmOutcome } from '@moonshot-ai/agent-core/llm/response';
import type { LoopLlmRequester } from '@moonshot-ai/agent-core/loop/index';
import { memorySessionSpace } from '@moonshot-ai/agent-core/session/index';

import { waitFor } from '#/todo-features/wait-for/index';

type GenerateRest = Parameters<LoopLlmRequester['generate']>[0];

function textOutcome(text: string, toolCalls: ToolCall[] = []): LlmOutcome {
  return { type: 'done', message: createAssistantMessage([{ type: 'text', text }], toolCalls) };
}

function scriptedRequester(next: (rest: GenerateRest) => LlmOutcome | Promise<LlmOutcome>): LoopLlmRequester {
  const self: LoopLlmRequester = {
    with: () => self,
    request: (part) => part as unknown as LlmRequest,
    generate: async (rest, _control) => next(rest),
  };
  return self;
}

function detachThenWaitRequester(): LoopLlmRequester {
  let step = 0;
  return scriptedRequester(() => {
    step += 1;
    if (step === 1) {
      return textOutcome('dispatching', [
        { type: 'function', id: 'bg-1', name: 'bg_tool', arguments: '{}' },
        { type: 'function', id: 'bg-2', name: 'bg_tool', arguments: '{}' },
      ]);
    }
    if (step === 2) {
      return textOutcome('waiting', [
        {
          type: 'function',
          id: 'w-1',
          name: 'WaitFor',
          arguments: JSON.stringify({ task_id: 'bg-1', timeout: 10 }),
        },
      ]);
    }
    return textOutcome('done');
  });
}

function backgroundProbe(): { feature: Feature<void>; release: (taskId: string) => void } {
  const gates = new Map<string, Promise<void>>();
  const releases = new Map<string, () => void>();
  const gate = (taskId: string): Promise<void> => {
    const current = gates.get(taskId);
    if (current !== undefined) return current;
    const pending = new Promise<void>((resolve) => {
      releases.set(taskId, resolve);
    });
    gates.set(taskId, pending);
    return pending;
  };
  const feature = createFeature('bg-probe', {
    agent: () => {
      useAgentTools({
        name: 'bg_tool',
        description: 'background probe',
        parameters: { type: 'object' },
        execute: async ({ toolCall, detach }) => {
          detach?.('bg running');
          await gate(toolCall.id);
          return { content: [{ type: 'text', text: 'bg-result' }] };
        },
      });
    },
  });
  return {
    feature,
    release: (taskId) => {
      releases.get(taskId)?.();
    },
  };
}

function user(text: string) {
  return createUserEntry(createUserMessage(text), { source: 'input' });
}

function setRequester(harness: App, sessionId: string, agentId: string, requester: LoopLlmRequester): void {
  const session = harness.sessions.get(sessionId);
  const agent = session !== undefined ? session.liveAgents.get(agentId) : undefined;
  if (agent === undefined) throw new Error(`no live agent '${agentId}'`);
  agent.loop.setRequester(requester);
}

describe('wait-for feature', () => {
  it('waits for a detached tool inside the same turn and reports its completion', async () => {
    const harness = createApp({ space: memorySessionSpace() });
    const bg = backgroundProbe();
    harness.features.add(waitFor);
    harness.features.add(bg.feature);
    const session = await harness.open('s1');
    const { agent } = await session.ensureAgent('main');
    setRequester(harness, 's1', 'main', detachThenWaitRequester());
    agent.loop.subscribe((event) => {
      if (event.type === 'tool.started' && event.toolCall.name === 'WaitFor') {
        setTimeout(() => bg.release('bg-1'), 0);
      }
    });

    const secondDetached = agent.loop.wait('tool.ended', {
      match: (event) => event.detached && event.toolCallId === 'bg-2',
    });
    const running = agent.loop.runTurn(user('go'));
    await secondDetached;
    await expect(agent.loop.waitForTasks({ taskId: 'missing', timeoutMs: 1 })).resolves.toEqual({
      completed: [],
      running: [],
      unknown: ['missing'],
      timedOut: false,
    });
    const any = agent.loop.waitForTasks({ timeoutMs: 1000 });
    await expect(agent.loop.waitForTasks({ taskId: 'bg-2', timeoutMs: 1 })).resolves.toEqual({
      completed: [],
      running: ['bg-2'],
      unknown: [],
      timedOut: true,
    });
    await expect(any).resolves.toEqual({ completed: ['bg-1'], running: ['bg-2'], unknown: [], timedOut: false });
    const outcome = await running;
    expect(outcome.type).toBe('done');
    await agent.flush();

    const messages = agent.view.getState().messages;
    const detached = messages.find(
      (entry) => entry.message.role === 'tool' && entry.message.toolCallId === 'bg-1',
    );
    expect(detached !== undefined && extractText(detached.message)).toBe('bg running');
    expect(detached?.meta?.detached).toBe(true);

    const waited = messages.find(
      (entry) => entry.message.role === 'tool' && entry.message.toolCallId === 'w-1',
    );
    expect(waited !== undefined && extractText(waited.message)).toBe('completed: bg-1');
    expect(waited?.meta?.isError).toBeUndefined();

    const completion = messages.find(
      (entry) => entry.message.role === 'user' && entry.meta?.source === 'async-tool',
    );
    const completionText = completion !== undefined ? extractText(completion.message) : '';
    expect(completionText).toContain('[async tool completed] bg_tool (tool_call_id=bg-1)');
    expect(completionText).toContain('bg-result');
    await harness.close();
    await expect(agent.loop.waitForTasks({ taskId: 'bg-2', timeoutMs: 1 })).resolves.toEqual({
      completed: [],
      running: [],
      unknown: ['bg-2'],
      timedOut: false,
    });
  });
});
