import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentTitlePromptSource } from '#/session/sessionTitle/agentTitlePromptSource';

import { createTestAgent, type TestAgentContext } from '../../harness';

describe('title excerpts over the real context memory', () => {
  let ctx: TestAgentContext;

  beforeEach(() => {
    ctx = createTestAgent();
  });

  afterEach(async () => {
    await ctx.dispose();
  });

  it('first_turn pairs the opening prompt with the folded assistant final text', async () => {
    const context = ctx.get(IAgentContextMemoryService);
    context.append({
      role: 'user',
      content: [{ type: 'text', text: '帮我部署这个服务' }],
      toolCalls: [],
      origin: { kind: 'user' },
    });
    context.appendLoopEvent({ type: 'step.begin', uuid: 's1' });
    context.appendLoopEvent({
      type: 'content.part',
      stepUuid: 's1',
      part: { type: 'text', text: '先看一下配置' },
    });
    context.appendLoopEvent({
      type: 'tool.call',
      stepUuid: 's1',
      toolCallId: 'c1',
      name: 'Read',
      args: {},
    });
    context.appendLoopEvent({
      type: 'tool.result',
      toolCallId: 'c1',
      result: { output: 'file contents', isError: false },
    });
    context.appendLoopEvent({ type: 'step.end', uuid: 's1' });
    context.appendLoopEvent({ type: 'step.begin', uuid: 's2' });
    context.appendLoopEvent({
      type: 'content.part',
      stepUuid: 's2',
      part: { type: 'think', think: '收尾' },
    });
    context.appendLoopEvent({
      type: 'content.part',
      stepUuid: 's2',
      part: { type: 'text', text: '部署完成，服务在 8080 端口' },
    });
    context.appendLoopEvent({ type: 'step.end', uuid: 's2' });

    const source = ctx.get(IAgentTitlePromptSource);
    await expect(source.firstTurnExcerpt()).resolves.toEqual({
      user: '帮我部署这个服务',
      assistant: '部署完成，服务在 8080 端口',
    });
    await expect(source.digestExcerpt()).resolves.toEqual({
      firstUser: '帮我部署这个服务',
      lastUser: undefined,
      assistant: '部署完成，服务在 8080 端口',
    });
  });

  it('first_turn reports no assistant text while the turn has not produced any', async () => {
    const context = ctx.get(IAgentContextMemoryService);
    context.append({
      role: 'user',
      content: [{ type: 'text', text: '刚发的问题' }],
      toolCalls: [],
      origin: { kind: 'user' },
    });

    await expect(ctx.get(IAgentTitlePromptSource).firstTurnExcerpt()).resolves.toEqual({
      user: '刚发的问题',
      assistant: undefined,
    });
  });

  it('excludes bundled skill blocks from the excerpt of a bundled prompt', async () => {
    const context = ctx.get(IAgentContextMemoryService);
    context.append({
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

    const source = ctx.get(IAgentTitlePromptSource);
    await expect(source.firstTurnExcerpt()).resolves.toEqual({
      user: '检查这次改动的正确性',
      assistant: undefined,
    });
    await expect(source.firstUserPrompts(5)).resolves.toEqual(['检查这次改动的正确性']);
  });
});
