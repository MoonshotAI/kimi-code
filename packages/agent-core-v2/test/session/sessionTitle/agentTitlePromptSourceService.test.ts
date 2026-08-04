/**
 * Scenario: the Agent-scoped title prompt projection reads the live context
 * window and includes prompts still waiting in the live prompt queue. Wiring:
 * the real source with contract-level fakes for context and prompt queue.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentPromptService } from '#/agent/prompt/prompt';
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
});
