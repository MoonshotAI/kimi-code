import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import type { ContentPart } from '#/kosong/contract/message';
import { IAgentTitlePromptSource } from '#/session/sessionTitle/agentTitlePromptSource';
import { AgentTitlePromptSourceService } from '#/session/sessionTitle/agentTitlePromptSourceService';

const USER_ORIGIN: ContextMessage['origin'] = { kind: 'user' };

function userMessage(
  id: string,
  text: string,
  origin: ContextMessage['origin'] = USER_ORIGIN,
): ContextMessage {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    toolCalls: [],
    origin,
  };
}

function assistantMessage(id: string, parts: ContentPart[]): ContextMessage {
  return { id, role: 'assistant', content: parts, toolCalls: [] };
}

function toolMessage(id: string, text: string): ContextMessage {
  return { id, role: 'tool', content: [{ type: 'text', text }], toolCalls: [] };
}

describe('AgentTitlePromptSource', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let liveMessages: readonly ContextMessage[];
  let queue: ReturnType<IAgentPromptService['list']>;

  beforeEach(() => {
    liveMessages = [];
    queue = { active: undefined, pending: [] };
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.definePartialInstance(IAgentContextMemoryService, { get: () => liveMessages });
        reg.definePartialInstance(IAgentPromptService, { list: () => queue });
        reg.define(IAgentTitlePromptSource, AgentTitlePromptSourceService);
      },
    });
  });

  afterEach(() => {
    disposables.dispose();
  });

  it('returns the first three prompts from the live context and queue in order', async () => {
    liveMessages = [userMessage('one', '第一条')];
    queue = {
      active: undefined,
      pending: [
        {
          id: 'two',
          userMessageId: 'two',
          createdAt: '2026-01-01T00:00:00.000Z',
          state: 'pending',
          message: userMessage('two', '第二条'),
        },
        {
          id: 'three',
          userMessageId: 'three',
          createdAt: '2026-01-01T00:00:01.000Z',
          state: 'pending',
          message: userMessage('three', '第三条'),
        },
      ],
    };

    await expect(ix.get(IAgentTitlePromptSource).firstUserPrompts(3)).resolves.toEqual([
      '第一条',
      '第二条',
      '第三条',
    ]);
  });

  it('keeps the head user messages of a compacted window, skipping elision and summary', async () => {
    liveMessages = [
      userMessage('head', '开场提问'),
      userMessage('elision', '... omitted ...', { kind: 'injection', variant: 'compaction_elision' }),
      userMessage('tail', '最近的追问'),
      userMessage('summary', ' compaction summary ', { kind: 'compaction_summary' }),
    ];

    await expect(ix.get(IAgentTitlePromptSource).firstUserPrompts(3)).resolves.toEqual([
      '开场提问',
      '最近的追问',
    ]);
  });

  it('returns no title prompts when history contains only slash activations', async () => {
    liveMessages = [
      userMessage('skill', 'expanded skill instructions', {
        kind: 'skill_activation',
        activationId: 'skill-1',
        skillName: 'compact',
        trigger: 'user-slash',
      }),
      userMessage('plugin', 'expanded plugin instructions', {
        kind: 'plugin_command',
        activationId: 'plugin-1',
        pluginId: 'example-plugin',
        commandName: 'run',
        trigger: 'user-slash',
      }),
    ];

    await expect(ix.get(IAgentTitlePromptSource).firstUserPrompts(3)).resolves.toEqual([]);
  });

  it('counts a queued prompt already appended to the context only once', async () => {
    liveMessages = [userMessage('one', '同一条')];
    queue = {
      active: {
        id: 'one',
        userMessageId: 'one',
        createdAt: '2026-01-01T00:00:00.000Z',
        state: 'running',
        message: userMessage('one', '同一条'),
      },
      pending: [],
    };

    await expect(ix.get(IAgentTitlePromptSource).firstUserPrompts(3)).resolves.toEqual(['同一条']);
  });

  it('firstTurnExcerpt pairs the opening prompt with the turn’s final assistant text', async () => {
    liveMessages = [
      userMessage('u1', '帮我写一个快排'),
      assistantMessage('a1-think', [{ type: 'think', think: '让我想想' }]),
      assistantMessage('a1-text', [{ type: 'text', text: '好的，先写一版' }]),
      toolMessage('t1', 'tool output'),
      assistantMessage('a2', [
        { type: 'text', text: '这是最终版实现' },
        { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
      ]),
      userMessage('u2', '再加个单测'),
      assistantMessage('a3', [{ type: 'text', text: '第二轮的回复' }]),
    ];

    await expect(ix.get(IAgentTitlePromptSource).firstTurnExcerpt()).resolves.toEqual({
      user: '帮我写一个快排',
      assistant: '这是最终版实现',
    });
  });

  it('firstTurnExcerpt reports a missing assistant reply until the turn ends', async () => {
    liveMessages = [userMessage('u1', '刚发的问题')];

    await expect(ix.get(IAgentTitlePromptSource).firstTurnExcerpt()).resolves.toEqual({
      user: '刚发的问题',
      assistant: undefined,
    });
  });

  it('digestExcerpt anchors the first prompt and lands on the latest turn', async () => {
    liveMessages = [
      userMessage('u1', '最初的目标'),
      assistantMessage('a1', [{ type: 'text', text: '第一轮回答' }]),
      userMessage('u2', '中途追问'),
      assistantMessage('a2', [{ type: 'text', text: '中间回答' }]),
      userMessage('u3', '最近的要求'),
      assistantMessage('a3', [{ type: 'think', think: '思考中' }]),
      assistantMessage('a4', [{ type: 'text', text: '最新正文' }]),
    ];

    await expect(ix.get(IAgentTitlePromptSource).digestExcerpt()).resolves.toEqual({
      firstUser: '最初的目标',
      lastUser: '最近的要求',
      assistant: '最新正文',
    });
  });

  it('digestExcerpt collapses a single-prompt conversation and skips dangling questions', async () => {
    liveMessages = [
      userMessage('u1', '唯一的问题'),
      assistantMessage('a1', [{ type: 'text', text: '唯一的回答' }]),
      userMessage('u2', '还没得到回复的新问题'),
    ];

    await expect(ix.get(IAgentTitlePromptSource).digestExcerpt()).resolves.toEqual({
      firstUser: '唯一的问题',
      lastUser: '还没得到回复的新问题',
      assistant: '唯一的回答',
    });

    liveMessages = [userMessage('u1', '唯一的问题')];
    await expect(ix.get(IAgentTitlePromptSource).digestExcerpt()).resolves.toEqual({
      firstUser: '唯一的问题',
      lastUser: undefined,
      assistant: undefined,
    });
  });
});
