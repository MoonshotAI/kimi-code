import type { ModelCapability, ProviderConfig, ToolCall } from '@moonshot-ai/kosong';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IAgentProfileService, type ResolvedAgentProfile } from '#/agent/profile';
import { AGENT_WIRE_PROTOCOL_VERSION } from '#/agent/wireRecord';
import { createTestAgent, type TestAgentContext } from '../harness';
import { DEFAULT_TEST_SYSTEM_PROMPT } from '../harness/snapshots';

// Historical `osEnv` shape carried by `useProfile` context — the test only
// exercises the profile-service pass-through; the exact fields don't matter to
// the assertions, so we keep a minimal literal instead of importing an
// external type.
const TEST_OS_ENV = {
  osKind: 'Linux',
  osArch: 'x86_64',
  osVersion: 'test',
  shellName: 'bash',
  shellPath: '/bin/bash',
} as const;

describe('Agent config', () => {
  let ctx: TestAgentContext;
  let profile: IAgentProfileService;

  beforeEach(() => {
    ctx = createTestAgent();
    profile = ctx.get(IAgentProfileService);
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('exposes provider, system prompt, thinking level, and model capability updates', async () => {
    const initialProvider: ProviderConfig = {
      type: 'openai',
      apiKey: 'sk-initial',
      baseUrl: 'https://initial.example/v1',
      model: 'gpt-initial',
    };
    const initialCapability: ModelCapability = {
      image_in: true,
      video_in: false,
      audio_in: false,
      thinking: false,
      tool_use: true,
      max_context_tokens: 128000,
    };
    ctx.configureRuntimeModel(initialProvider, initialCapability);

    await expect(ctx.rpc.getConfig({})).resolves.toMatchObject({
      provider: initialProvider,
      systemPrompt: DEFAULT_TEST_SYSTEM_PROMPT,
      thinkingLevel: 'off',
      modelCapabilities: initialCapability,
    });

    const nextProvider: ProviderConfig = {
      type: 'kimi',
      apiKey: 'sk-next',
      baseUrl: 'https://next.example/v1',
      model: 'kimi-next',
    };
    const nextCapability: ModelCapability = {
      image_in: true,
      video_in: true,
      audio_in: false,
      thinking: true,
      tool_use: true,
      max_context_tokens: 262144,
    };
    ctx.configureRuntimeModel(nextProvider, nextCapability);
    profile.update({
      systemPrompt: 'Changed profile prompt.',
      thinkingLevel: 'high',
    });

    await expect(ctx.rpc.getConfig({})).resolves.toMatchObject({
      provider: nextProvider,
      systemPrompt: 'Changed profile prompt.',
      thinkingLevel: 'high',
      modelCapabilities: nextCapability,
    });
  });

  it('useProfile emits the rendered system prompt and active tools', async () => {
    const resolvedProfile: ResolvedAgentProfile = {
      name: 'test-profile',
      systemPrompt: () => 'Profile system prompt.',
      tools: ['Read'],
    };

    profile.useProfile(resolvedProfile, {
      osEnv: TEST_OS_ENV,
      cwd: process.cwd(),
    });

    expect(ctx.newEvents()).toMatchInlineSnapshot(`
      [wire] config.update            { "profileName": "test-profile", "systemPrompt": "Profile system prompt.", "time": "<time>" }
      [emit] agent.status.updated     { "model": "mock-model", "maxContextTokens": 1000000 }
      [wire] tools.set_active_tools   { "names": [ "Read" ], "time": "<time>" }
    `);
  });

  it('useProfile passes additionalDirsInfo to profile system prompts', async () => {
    const resolvedProfile: ResolvedAgentProfile = {
      name: 'context-profile',
      systemPrompt: (context) =>
        `Prompt with additional dirs: ${context['additionalDirsInfo'] ?? 'none'}`,
      tools: ['Read'],
    };

    profile.useProfile(resolvedProfile, {
      osEnv: TEST_OS_ENV,
      cwd: process.cwd(),
      cwdListing: 'cwd listing',
      agentsMd: 'agents md',
      additionalDirsInfo: '### /extra\nextra-file.txt',
    });

    expect(profile.data().systemPrompt).toBe(
      'Prompt with additional dirs: ### /extra\nextra-file.txt',
    );

    profile.useProfile(resolvedProfile, {
      osEnv: TEST_OS_ENV,
      cwd: process.cwd(),
    });

    expect(profile.data().systemPrompt).toBe('Prompt with additional dirs: none');
  });

  it('restores config and active tools through activated handlers', async () => {
    await ctx.restore([
      {
        type: 'metadata',
        protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
        created_at: 1,
      },
      {
        type: 'config.update',
        cwd: '/restored-cwd',
        modelAlias: 'restored-model',
        profileName: 'restored-profile',
        systemPrompt: 'Restored prompt.',
      },
      {
        type: 'tools.set_active_tools',
        names: ['Read'],
      },
    ]);

    expect(profile.data()).toMatchObject({
      cwd: '/restored-cwd',
      modelAlias: 'restored-model',
      profileName: 'restored-profile',
      systemPrompt: 'Restored prompt.',
      activeToolNames: ['Read'],
    });
  });

  it('config.update with cwd initializes builtin tools', async () => {
    const tools = await ctx.rpc.getTools({});

    expect(toolNames(tools)).toEqual(
      expect.arrayContaining(['Read', 'Write', 'Edit', 'Grep', 'Glob']),
    );
  });

  it('keeps turn-start config for later steps and applies updates to the next turn', async () => {
    const lookupCall: ToolCall = {
      type: 'function',
      id: 'call_lookup',
      name: 'Lookup',
      arguments: '{"query":"original"}',
    };
    profile.update({ activeToolNames: ['Lookup'] });
    await ctx.rpc.registerTool({
      name: 'Lookup',
      description: 'Look up a short test value.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    });
    ctx.newEvents();

    ctx.mockNextResponse({ type: 'text', text: 'I will look it up.' }, lookupCall);
    await ctx.rpc.prompt({
      input: [{ type: 'text', text: 'Look up before config changes' }],
    });
    expect(await ctx.untilApproval(true)).toMatchInlineSnapshot(`
      [wire] context.splice         { "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Look up before config changes" } ], "toolCalls": [], "id": "<msg-1>" } ], "time": "<time>" }
      [wire] turn.launch            { "turnId": 0, "origin": { "kind": "user" }, "promptMessageId": "<msg-1>", "time": "<time>" }
      [emit] turn.started           { "turnId": 0, "origin": { "kind": "user" }, "promptMessageId": "<msg-1>" }
      [emit] turn.step.started      { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [emit] assistant.delta        { "turnId": 0, "delta": "I will look it up." }
      [emit] tool.call.delta        { "turnId": 0, "toolCallId": "call_lookup", "name": "Lookup", "argumentsPart": "{\\"query\\":\\"original\\"}" }
      [wire] usage.record           { "model": "mock-model", "usage": { "inputOther": 9, "output": 17, "inputCacheRead": 0, "inputCacheCreation": 0 }, "context": { "type": "turn", "turnId": 0 }, "time": "<time>" }
      [emit] agent.status.updated   { "usage": { "byModel": { "mock-model": { "inputOther": 9, "output": 17, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 9, "output": 17, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 9, "output": 17, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] context.splice         { "start": 1, "deleteCount": 0, "messages": [ { "id": "<msg-2>", "role": "assistant", "content": [ { "type": "text", "text": "I will look it up." } ], "toolCalls": [] } ], "time": "<time>" }
      [emit] requestApproval        { "turnId": 0, "toolCallId": "call_lookup", "toolName": "Lookup", "action": "Approve Lookup", "display": { "kind": "generic", "summary": "Approve Lookup", "detail": { "query": "original" } } }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: Lookup
      messages:
        user: text "Look up before config changes"
    `);

    ctx.configureRuntimeModel({
      type: 'kimi',
      apiKey: 'test-key',
      model: 'changed-model',
    });
    profile.update({ systemPrompt: 'Changed system prompt.' });
    await ctx.rpc.setActiveTools({ names: [] });

    const toolCallEvents = ctx.untilToolCall({
      content: 'original-result',
      output: 'original-result',
    });
    ctx.mockNextResponse({ type: 'text', text: 'Still using the original turn config.' });
    await toolCallEvents;
    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] context.splice          { "start": 2, "deleteCount": 0, "messages": [ { "role": "tool", "content": [ { "type": "text", "text": "original-result" } ], "toolCalls": [], "toolCallId": "call_lookup", "id": "<msg-3>" } ], "time": "<time>" }
      [emit] tool.result             { "turnId": 0, "toolCallId": "call_lookup", "output": "original-result" }
      [wire] context.splice          { "start": 1, "deleteCount": 1, "messages": [ { "id": "<msg-2>", "role": "assistant", "content": [ { "type": "text", "text": "I will look it up." } ], "toolCalls": [ { "type": "function", "id": "call_lookup", "name": "Lookup", "arguments": "{\\"query\\":\\"original\\"}" } ], "providerMessageId": "mock-1" } ], "time": "<time>" }
      [emit] agent.status.updated    { "contextTokens": 0 }
      [emit] turn.step.completed     { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 9, "output": 17, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use" }
      [emit] turn.step.started       { "turnId": 0, "step": 2, "stepId": "<uuid-2>" }
      [emit] assistant.delta         { "turnId": 0, "delta": "Still using the original turn config." }
      [wire] usage.record            { "model": "changed-model", "usage": { "inputOther": 31, "output": 13, "inputCacheRead": 0, "inputCacheCreation": 0 }, "context": { "type": "turn", "turnId": 0 }, "time": "<time>" }
      [emit] agent.status.updated    { "usage": { "byModel": { "mock-model": { "inputOther": 9, "output": 17, "inputCacheRead": 0, "inputCacheCreation": 0 }, "changed-model": { "inputOther": 31, "output": 13, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 40, "output": 30, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 40, "output": 30, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] context.splice          { "start": 3, "deleteCount": 0, "messages": [ { "id": "<msg-4>", "role": "assistant", "content": [ { "type": "text", "text": "Still using the original turn config." } ], "toolCalls": [] } ], "time": "<time>" }
      [wire] context_size.measured   { "length": 4, "tokens": 44, "time": "<time>" }
      [emit] agent.status.updated    { "contextTokens": 44 }
      [wire] context.splice          { "start": 3, "deleteCount": 1, "messages": [ { "id": "<msg-4>", "role": "assistant", "content": [ { "type": "text", "text": "Still using the original turn config." } ], "toolCalls": [], "providerMessageId": "mock-2" } ], "time": "<time>" }
      [emit] agent.status.updated    { "contextTokens": 0 }
      [emit] turn.step.completed     { "turnId": 0, "step": 2, "stepId": "<uuid-2>", "usage": { "inputOther": 31, "output": 13, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }
      [emit] turn.ended              { "turnId": 0, "reason": "completed" }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: "Changed system prompt."
      messages:
        <last>
        assistant: text "I will look it up."  calls call_lookup:Lookup { "query": "original" }
        tool[call_lookup]: text "original-result"
    `);

    ctx.mockNextResponse({ type: 'text', text: 'Now the changed config is active.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Start a fresh turn' }] });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] context.splice          { "start": 4, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Start a fresh turn" } ], "toolCalls": [], "id": "<msg-5>" } ], "time": "<time>" }
      [wire] turn.launch             { "turnId": 1, "origin": { "kind": "user" }, "promptMessageId": "<msg-5>", "time": "<time>" }
      [emit] turn.started            { "turnId": 1, "origin": { "kind": "user" }, "promptMessageId": "<msg-5>" }
      [emit] turn.step.started       { "turnId": 1, "step": 1, "stepId": "<uuid-3>" }
      [emit] assistant.delta         { "turnId": 1, "delta": "Now the changed config is active." }
      [wire] usage.record            { "model": "changed-model", "usage": { "inputOther": 50, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "context": { "type": "turn", "turnId": 1 }, "time": "<time>" }
      [emit] agent.status.updated    { "usage": { "byModel": { "mock-model": { "inputOther": 9, "output": 17, "inputCacheRead": 0, "inputCacheCreation": 0 }, "changed-model": { "inputOther": 81, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 90, "output": 42, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 50, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] context.splice          { "start": 5, "deleteCount": 0, "messages": [ { "id": "<msg-6>", "role": "assistant", "content": [ { "type": "text", "text": "Now the changed config is active." } ], "toolCalls": [] } ], "time": "<time>" }
      [wire] context_size.measured   { "length": 6, "tokens": 62, "time": "<time>" }
      [emit] agent.status.updated    { "contextTokens": 62 }
      [wire] context.splice          { "start": 5, "deleteCount": 1, "messages": [ { "id": "<msg-6>", "role": "assistant", "content": [ { "type": "text", "text": "Now the changed config is active." } ], "toolCalls": [], "providerMessageId": "mock-3" } ], "time": "<time>" }
      [emit] agent.status.updated    { "contextTokens": 0 }
      [emit] turn.step.completed     { "turnId": 1, "step": 1, "stepId": "<uuid-3>", "usage": { "inputOther": 50, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }
      [emit] turn.ended              { "turnId": 1, "reason": "completed" }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      tools: []
      messages:
        <last>
        assistant: text "Still using the original turn config."
        user: text "Start a fresh turn"
    `);
  });
});

function toolNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (item === null || typeof item !== 'object') return null;
      const record = item as Record<string, unknown>;
      return typeof record['name'] === 'string' ? record['name'] : null;
    })
    .filter((name): name is string => name !== null);
}
