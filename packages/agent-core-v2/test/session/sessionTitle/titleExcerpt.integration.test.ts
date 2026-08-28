import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentContextMemory } from '#/features/contextMemory/contextMemoryAgentRuntime';
import { ContextAppendLoopEvent } from '#/features/contextMemory/contextEvents';
import type { LoopRecordedEvent } from '#/features/contextMemory/loopEventFold';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import type { IAgentTitlePromptSource } from '#/session/sessionTitle/agentTitlePromptSource';
import { AgentTitlePromptSourceService } from '#/session/sessionTitle/agentTitlePromptSourceService';

import { createTestAgent, type TestAgentContext } from '../../harness';

describe('title excerpts over the real context memory', () => {
  let ctx: TestAgentContext;

  beforeEach(() => {
    ctx = createTestAgent();
  });

  afterEach(async () => {
    await ctx.dispose();
  });

  function titlePromptSource(): IAgentTitlePromptSource {
    return new AgentTitlePromptSourceService(
      ctx.get(IAgentLifecycleService),
      ctx.scopeContext,
    );
  }

  function appendLoopEvent(event: LoopRecordedEvent): void {
    void ctx.dispatcher.dispatch(new ContextAppendLoopEvent({ agentId: 'main', event }));
  }

  it('first_turn pairs the opening prompt with the folded assistant final text', async () => {
    const context = ctx.resolve(AgentContextMemory);
    void context.append({
      role: 'user',
      content: [{ type: 'text', text: '帮我部署这个服务' }],
      toolCalls: [],
      origin: { kind: 'user' },
    });
    appendLoopEvent({ type: 'step.begin', uuid: 's1' });
    appendLoopEvent({
      type: 'content.part',
      stepUuid: 's1',
      part: { type: 'text', text: '先看一下配置' },
    });
    appendLoopEvent({
      type: 'tool.call',
      stepUuid: 's1',
      toolCallId: 'c1',
      name: 'Read',
      args: {},
    });
    appendLoopEvent({
      type: 'tool.result',
      toolCallId: 'c1',
      result: { output: 'file contents', isError: false },
    });
    appendLoopEvent({ type: 'step.end', uuid: 's1' });
    appendLoopEvent({ type: 'step.begin', uuid: 's2' });
    appendLoopEvent({
      type: 'content.part',
      stepUuid: 's2',
      part: { type: 'think', think: '收尾' },
    });
    appendLoopEvent({
      type: 'content.part',
      stepUuid: 's2',
      part: { type: 'text', text: '部署完成，服务在 8080 端口' },
    });
    appendLoopEvent({ type: 'step.end', uuid: 's2' });

    const source = titlePromptSource();
    await expect(source.firstTurnExcerpt()).resolves.toEqual({
      user: '帮我部署这个服务',
      assistant: '部署完成，服务在 8080 端口',
    });
    await expect(source.digestExcerpt()).resolves.toEqual({
      turns: [{ user: '帮我部署这个服务', assistant: '部署完成，服务在 8080 端口' }],
    });
  });

  it('first_turn reports no assistant text while the turn has not produced any', async () => {
    const context = ctx.resolve(AgentContextMemory);
    void context.append({
      role: 'user',
      content: [{ type: 'text', text: '刚发的问题' }],
      toolCalls: [],
      origin: { kind: 'user' },
    });

    await expect(titlePromptSource().firstTurnExcerpt()).resolves.toEqual({
      user: '刚发的问题',
      assistant: undefined,
    });
  });

  it('excludes bundled skill blocks from the excerpt of a bundled prompt', async () => {
    const context = ctx.resolve(AgentContextMemory);
    void context.append({
      role: 'user',
      content: [
        { type: 'text', text: 'User activated the skill "review". Follow the loaded skill instructions.' },
        { type: 'text', text: 'User activated the skill "security". Follow the loaded skill instructions.' },
        { type: 'text', text: '检查这次改动的正确性' },
      ],
      toolCalls: [],
      origin: {
        kind: 'user',
        skillActivations: [
          { activationId: 'act-1', skillName: 'review' },
          { activationId: 'act-2', skillName: 'security' },
        ],
      },
    });

    const source = titlePromptSource();
    await expect(source.firstTurnExcerpt()).resolves.toEqual({
      user: '检查这次改动的正确性',
      assistant: undefined,
    });
    await expect(source.firstUserPrompts(5)).resolves.toEqual(['检查这次改动的正确性']);
  });
});
