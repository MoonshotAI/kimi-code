import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendContext } from '../../agent/contextMemory/stubs';

import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentTitlePromptSource } from '#/session/sessionTitle/agentTitlePromptSource';

import { createTestAgent, type TestAgentContext } from '../../harness';

describe('title excerpts over the real context memory', () => {
  let ctx: TestAgentContext;

  beforeEach(async () => {
    ctx = createTestAgent();
    await ctx.restorePersisted();
  });

  afterEach(async () => {
    await ctx.dispose();
  });

  it('first_turn pairs the opening prompt with the folded assistant final text', async () => {
    const context = ctx.get(IAgentLoopService);
    appendContext(context,
      {
        role: 'user',
        content: [{ type: 'text', text: '帮我部署这个服务' }],
        origin: { kind: 'user' },
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '先看一下配置' }],
        toolCalls: [{ type: 'function', id: 'c1', name: 'Read', arguments: '{}' }],
      },
      { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'file contents' }] },
      {
        role: 'assistant',
        content: [
          { type: 'think', think: '收尾' },
          { type: 'text', text: '部署完成，服务在 8080 端口' },
        ],
        toolCalls: [],
      },
    );

    const source = ctx.get(IAgentTitlePromptSource);
    await expect(source.firstTurnExcerpt()).resolves.toEqual({
      user: '帮我部署这个服务',
      assistant: '部署完成，服务在 8080 端口',
    });
    await expect(source.digestExcerpt()).resolves.toEqual({
      turns: [{ user: '帮我部署这个服务', assistant: '部署完成，服务在 8080 端口' }],
    });
  });

  it('first_turn reports no assistant text while the turn has not produced any', async () => {
    const context = ctx.get(IAgentLoopService);
    appendContext(context,{
      role: 'user',
      content: [{ type: 'text', text: '刚发的问题' }],
      origin: { kind: 'user' },
    });

    await expect(ctx.get(IAgentTitlePromptSource).firstTurnExcerpt()).resolves.toEqual({
      user: '刚发的问题',
      assistant: undefined,
    });
  });

  it('excludes bundled skill blocks from the excerpt of a bundled prompt', async () => {
    const context = ctx.get(IAgentLoopService);
    appendContext(context,{
      role: 'user',
      content: [
        { type: 'text', text: 'User activated the skill "review". Follow the loaded skill instructions.' },
        { type: 'text', text: 'User activated the skill "security". Follow the loaded skill instructions.' },
        { type: 'text', text: '检查这次改动的正确性' },
      ],
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
