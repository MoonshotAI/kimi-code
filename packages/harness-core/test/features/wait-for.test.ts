import { describe, expect, it } from 'vitest';

import { createFeature, type Feature } from '@moonshot-ai/agent-core/app/index';
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

import {
  createHarness,
  harnessInternals,
  memoryHarnessSpace,
  useAgentTools,
  type Harness,
} from '#/runtime/index';
import { waitFor } from '#/features/wait-for/index';

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
      return textOutcome('dispatching', [{ type: 'function', id: 'bg-1', name: 'bg_tool', arguments: '{}' }]);
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

function backgroundProbe(): { feature: Feature<void>; release: () => void } {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const feature = createFeature('bg-probe', {
    agent: () => {
      useAgentTools({
        name: 'bg_tool',
        description: 'background probe',
        parameters: { type: 'object' },
        execute: async ({ detach }) => {
          detach?.('bg running');
          await gate;
          return { content: [{ type: 'text', text: 'bg-result' }] };
        },
      });
    },
  });
  return { feature, release };
}

function user(text: string) {
  return createUserEntry(createUserMessage(text), { source: 'input' });
}

function setRequester(harness: Harness, sessionId: string, agentId: string, requester: LoopLlmRequester): void {
  const session = harness.app.sessions.get(sessionId);
  const runtime = session !== undefined ? harnessInternals(harness.app).agents.get(session)?.get(agentId) : undefined;
  if (runtime === undefined) throw new Error(`no runtime for agent '${agentId}'`);
  runtime.requester = requester;
}

describe('wait-for feature', () => {
  it('waits for a detached tool inside the same turn and reports its completion', async () => {
    const harness = createHarness({ space: memoryHarnessSpace() });
    const bg = backgroundProbe();
    await harness.app.features.add(waitFor);
    await harness.app.features.add(bg.feature);
    const session = await harness.app.create({ sessionId: 's1' });
    const agent = await harness.ensureAgent(session, 'main');
    setRequester(harness, 's1', 'main', detachThenWaitRequester());
    agent.loop.subscribe((event) => {
      if (event.type === 'tool.started' && event.toolCall.name === 'WaitFor') {
        setTimeout(() => bg.release(), 0);
      }
    });

    const outcome = await agent.loop.runTurn(user('go'));
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
  });
});
