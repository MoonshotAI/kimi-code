/**
 * Scenario: agent-facing config projection, owner-registered sections, and env overlays.
 *
 * Exercises the public profile/config surfaces and resolves the real
 * `ConfigService` with TOML document storage while stubbing host and model
 * boundaries. Run with `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/app/config/config.test.ts`.
 */

import type { ModelCapability } from '#/kosong/contract/capability';
import type { ToolCall } from '#/kosong/contract/message';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IAgentProfileService, type ResolvedAgentProfile } from '#/agent/profile/profile';
import { normalizeAgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { Error2, ErrorCodes, toErrorPayload } from '#/errors';
import { WIRE_PROTOCOL_VERSION } from '#/wire/migration/migration';
import { createTestAgent, type TestAgentContext } from '../../harness';
import { DEFAULT_TEST_SYSTEM_PROMPT } from '../../harness/snapshots';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { ConfigTarget, IConfigRegistry, IConfigService } from '#/app/config/config';
import { ConfigRegistry, ConfigService } from '#/app/config/configService';
import { SECONDARY_MODEL_FLAG_ID } from '#/session/subagent/flag';
import '#/app/cron/configSection';
import type { CronConfig } from '#/app/cron/configSection';
import '#/app/skillCatalog/configSection';
import {
  EXTRA_SKILL_DIRS_SECTION,
  MERGE_ALL_AVAILABLE_SKILLS_SECTION,
} from '#/app/skillCatalog/configSection';
import '#/agent/permissionMode/configSection';
import { DEFAULT_PERMISSION_MODE_SECTION } from '#/agent/permissionMode/configSection';
import '#/agent/media/configSection';
import { IMAGE_SECTION, type ImageConfig } from '#/agent/media/configSection';
import '#/agent/tokenCounting/configSection';
import {
  TOKEN_COUNTING_SECTION,
  TOKEN_COUNTING_STRATEGY_ENV,
  type TokenCountingConfig,
} from '#/agent/tokenCounting/configSection';
import '#/agent/loop/configSection';
import {
  LOOP_CONTROL_SECTION,
  LOOP_MAX_ATTEMPTS_PER_STEP_ENV,
  LOOP_MAX_RETRIES_PER_STEP_ENV,
  LOOP_MAX_STEPS_PER_TURN_ENV,
  type LoopControl,
} from '#/agent/loop/configSection';
import {
  DEFAULT_MODEL_SECTION,
  MODELS_SECTION,
  PROVIDERS_SECTION,
  SECONDARY_MODEL_EFFORT_ENV,
  SECONDARY_MODEL_ENV,
  SECONDARY_MODEL_SECTION,
  THINKING_SECTION,
} from '#/app/kosongConfig/configSection';
import { type ThinkingConfig } from '#/kosong/model/thinking';
import {
  KEEP_ALIVE_ON_EXIT_ENV,
  MAX_RUNNING_TASKS_ENV,
  resolveAgentTaskConfig,
  resolvePrintBackgroundMode,
  type AgentTaskConfig,
} from '#/agent/task/configSection';
import { applyPrintModeConfigDefaults } from '#/agent/task/printDefaults';
import '#/session/subagent/configSection';
import {
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  resolveSecondaryModel,
  resolveSubagentBinding,
  resolveSubagentTimeoutMs,
  SUBAGENT_SECTION,
  SUBAGENT_TIMEOUT_ENV,
  type SubagentConfig,
  wrapSubagentModelError,
} from '#/session/subagent/configSection';
import {
  SERVICES_SECTION,
  WEB_FETCH_API_KEY_ENV,
  WEB_FETCH_BASE_URL_ENV,
  WEB_SEARCH_API_KEY_ENV,
  WEB_SEARCH_BASE_URL_ENV,
  type ServicesConfig,
} from '#/app/auth/configSection';
import { SECONDARY_DERIVED_MODEL_ID } from '#/app/kosongConfig/secondaryModelOverlay';
import { type SecondaryModelConfig } from '#/app/kosongConfig/configSection';
import '#/app/mcpConfig/configSection';
import {
  MCP_SECTION,
  MCP_STARTUP_TIMEOUT_ENV,
  MCP_TOOL_TIMEOUT_ENV,
  McpSectionSchema,
  type McpSection,
} from '#/app/mcpConfig/configSection';
import { ILogService } from '#/_base/log/log';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { TomlAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { stubBootstrap } from '../bootstrap/stubs';
import { stubFlag } from '../flag/stubs';
import { stubLog } from '../../_base/log/stubs';

const TEST_OS_ENV = {
  osKind: 'Linux',
  osArch: 'x86_64',
  osVersion: 'test',
  shellName: 'bash',
  shellPath: '/bin/bash',
} as const;

function secondaryModelFlags(enabled = true) {
  return stubFlag((id) => enabled && id === SECONDARY_MODEL_FLAG_ID);
}

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

  it('exposes system prompt, thinking level, and model capability updates', async () => {
    const initialCapability: ModelCapability = {
      image_in: true,
      video_in: false,
      audio_in: false,
      thinking: false,
      tool_use: true,
      max_context_tokens: 128000,
    };
    ctx.configureRuntimeModel(
      {
        type: 'openai',
        apiKey: 'sk-initial',
        baseUrl: 'https://initial.example/v1',
        model: 'gpt-initial',
      },
      initialCapability,
    );

    await expect(ctx.rpc.getConfig({})).resolves.toMatchObject({
      systemPrompt: DEFAULT_TEST_SYSTEM_PROMPT,
      thinkingLevel: 'off',
      modelCapabilities: initialCapability,
    });

    const nextCapability: ModelCapability = {
      image_in: true,
      video_in: true,
      audio_in: false,
      thinking: true,
      tool_use: true,
      max_context_tokens: 262144,
    };
    ctx.configureRuntimeModel(
      {
        type: 'kimi',
        apiKey: 'sk-next',
        baseUrl: 'https://next.example/v1',
        model: 'kimi-next',
      },
      nextCapability,
    );
    profile.update({
      systemPrompt: 'Changed profile prompt.',
      thinkingLevel: 'high',
    });

    await expect(ctx.rpc.getConfig({})).resolves.toMatchObject({
      systemPrompt: 'Changed profile prompt.',
      thinkingLevel: 'on',
      modelCapabilities: nextCapability,
    });
  });

  it('useProfile emits the rendered system prompt and active tools', async () => {
    const resolvedProfile: ResolvedAgentProfile = normalizeAgentProfile({
      name: 'test-profile',
      systemPrompt: () => 'Profile system prompt.',
      tools: ['Read'],
    });

    profile.useProfile(resolvedProfile, {
      osEnv: TEST_OS_ENV,
      cwd: process.cwd(),
    });

    expect(ctx.newEvents()).toMatchInlineSnapshot(`
      [wire] config.update            { "profileName": "test-profile", "systemPrompt": "Profile system prompt.", "environmentDisclosure": { "cwd": "<cwd>", "date": { "disclosed": false } }, "agentsMdPaths": [], "disallowedTools": [], "time": "<time>" }
      [emit] agent.status.updated     { "model": "mock-model", "maxContextTokens": 1000000 }
      [wire] tools.set_active_tools   { "names": [ "Read" ], "time": "<time>" }
    `);
  });

  it('useProfile passes additionalDirsInfo to profile system prompts', async () => {
    const resolvedProfile: ResolvedAgentProfile = normalizeAgentProfile({
      name: 'context-profile',
      systemPrompt: (context) =>
        `Prompt with additional dirs: ${context['additionalDirsInfo'] ?? 'none'}`,
      tools: ['Read'],
    });

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
        protocol_version: WIRE_PROTOCOL_VERSION,
        created_at: 1,
      },
      {
        type: 'profile.bind',
        cwd: '/restored-cwd',
        modelAlias: 'restored-model',
        profileName: 'restored-profile',
        thinkingEffort: 'off',
        systemPrompt: 'Restored prompt.',
        disallowedTools: [],
      },
      {
        type: 'tools.set_active_tools',
        names: ['Read'],
      },
    ]);

    expect(profile.data()).toMatchObject({
      modelAlias: 'restored-model',
      profileName: 'restored-profile',
      systemPrompt: 'Restored prompt.',
      activeToolNames: ['Read'],
    });
  });

  it('config.update initializes builtin tools', async () => {
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
      [wire] turn.prompt                     { "input": [ { "type": "text", "text": "Look up before config changes" } ], "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started                    { "turnId": 0, "origin": { "kind": "user" }, "prompt": "Look up before config changes" }
      [emit] agent.activity.updated          { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 0, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [emit] context.spliced                 { "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Look up before config changes" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-1>" } ] }
      [wire] context.append_message          { "message": { "role": "user", "content": [ { "type": "text", "text": "Look up before config changes" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-1>" }, "time": "<time>" }
      [emit] turn.step.started               { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [emit] agent.activity.updated          { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [wire] context.append_loop_event       { "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
      [wire] llm.tools_snapshot              { "hash": "3bfeb22e61431247933e79f6ab94e7ca14a127f899bc87e7bbd22594ba9cdb66", "tools": [ { "name": "Lookup", "description": "Look up a short test value.", "parameters": { "type": "object", "properties": { "query": { "type": "string" } }, "required": [ "query" ], "additionalProperties": false } } ], "time": "<time>" }
      [wire] llm.request                     { "kind": "loop", "provider": "openai", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 1000000, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "3bfeb22e61431247933e79f6ab94e7ca14a127f899bc87e7bbd22594ba9cdb66", "messageCount": 1, "turnStep": "0.1", "time": "<time>" }
      [emit] assistant.delta                 { "turnId": 0, "delta": "I will look it up." }
      [emit] agent.activity.updated          { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "streaming", "stream": "assistant", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [emit] tool.call.delta                 { "turnId": 0, "toolCallId": "call_lookup", "name": "Lookup", "argumentsPart": "{\\"query\\":\\"original\\"}" }
      [emit] agent.activity.updated          { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "streaming", "stream": "tool_call", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [wire] usage.record                    { "model": "mock-model", "usage": { "inputOther": 9, "output": 17, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated            { "usage": { "byModel": { "mock-model": { "inputOther": 9, "output": 17, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 9, "output": 17, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 9, "output": 17, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [emit] agent.status.updated            { "contextTokens": 26 }
      [wire] context.append_loop_event       { "event": { "type": "content.part", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "I will look it up." } }, "time": "<time>" }
      [emit] permission.approval.requested   { "sessionId": "test-session", "agentId": "main", "turnId": 0, "toolCallId": "call_lookup", "toolName": "Lookup", "action": "Approve Lookup", "display": { "kind": "generic", "summary": "Approve Lookup", "detail": { "query": "original" } }, "toolInput": { "query": "original" } }
      [emit] agent.activity.updated          { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "streaming", "stream": "tool_call", "step": 1, "ending": false, "pendingApprovals": [ { "approvalId": "call_lookup", "toolCallId": "call_lookup", "since": "<time>" } ], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [emit] requestApproval                 { "turnId": 0, "toolCallId": "call_lookup", "toolName": "Lookup", "action": "Approve Lookup", "display": { "kind": "generic", "summary": "Approve Lookup", "detail": { "query": "original" } } }
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
      baseUrl: 'https://changed.example.test/v1',
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
      [wire] context.append_loop_event   { "event": { "type": "tool.call", "uuid": "<uuid-3>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "toolCallId": "call_lookup", "name": "Lookup", "args": { "query": "original" } }, "time": "<time>" }
      [emit] tool.result                 { "turnId": 0, "toolCallId": "call_lookup", "output": "original-result" }
      [emit] agent.activity.updated      { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [wire] context.append_loop_event   { "event": { "type": "tool.result", "parentUuid": "<uuid-3>", "toolCallId": "call_lookup", "result": { "output": "original-result" } }, "time": "<time>" }
      [emit] turn.step.completed         { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 9, "output": 17, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use", "providerFinishReason": "tool_calls", "rawFinishReason": "tool_calls" }
      [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-1>", "turnId": "0", "step": 1, "finishReason": "tool_use", "usage": { "inputOther": 9, "output": 17, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-1", "providerFinishReason": "tool_calls", "rawFinishReason": "tool_calls" }, "time": "<time>" }
      [emit] turn.step.started           { "turnId": 0, "step": 2, "stepId": "<uuid-4>" }
      [emit] agent.activity.updated      { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 2, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-4>", "turnId": "0", "step": 2 }, "time": "<time>" }
      [wire] llm.tools_snapshot          { "hash": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", "tools": [], "time": "<time>" }
      [wire] llm.request                 { "kind": "loop", "provider": "openai", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 1000000, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "systemPrompt": "You are a deterministic test agent.", "toolsHash": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", "messageCount": 3, "turnStep": "0.2", "time": "<time>" }
      [emit] assistant.delta             { "turnId": 0, "delta": "Still using the original turn config." }
      [emit] agent.activity.updated      { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "streaming", "stream": "assistant", "step": 2, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 31, "output": 13, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated        { "usage": { "byModel": { "mock-model": { "inputOther": 40, "output": 30, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 40, "output": 30, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 40, "output": 30, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [emit] agent.status.updated        { "contextTokens": 44 }
      [emit] turn.step.completed         { "turnId": 0, "step": 2, "stepId": "<uuid-4>", "usage": { "inputOther": 31, "output": 13, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn", "providerFinishReason": "completed", "rawFinishReason": "stop" }
      [emit] agent.activity.updated      { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 2, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-5>", "turnId": "0", "step": 2, "stepUuid": "<uuid-4>", "part": { "type": "text", "text": "Still using the original turn config." } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-4>", "turnId": "0", "step": 2, "finishReason": "end_turn", "usage": { "inputOther": 31, "output": 13, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-2", "providerFinishReason": "completed", "rawFinishReason": "stop" }, "time": "<time>" }
      [wire] turn.ended                  { "turnId": 0, "reason": "completed", "time": "<time>" }
      [emit] turn.ended                  { "turnId": 0, "reason": "completed" }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      tools: []
      messages:
        <last>
        assistant: text "I will look it up."  calls call_lookup:Lookup { "query": "original" }
        tool[call_lookup]: text "original-result"
    `);

    ctx.mockNextResponse({ type: 'text', text: 'Now the changed config is active.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Start a fresh turn' }] });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [emit] agent.activity.updated      { "lifecycle": "ready", "lastTurn": { "turnId": 0, "reason": "completed", "at": "<time>" }, "background": [] }
      [emit] prompt.completed            { "promptId": "<msg-1>", "finishedAt": "<time>", "reason": "completed" }
      [wire] turn.prompt                 { "input": [ { "type": "text", "text": "Start a fresh turn" } ], "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started                { "turnId": 1, "origin": { "kind": "user" }, "prompt": "Start a fresh turn" }
      [emit] agent.activity.updated      { "lifecycle": "ready", "turn": { "turnId": 1, "origin": { "kind": "user" }, "phase": "running", "step": 0, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [emit] context.spliced             { "start": 4, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Start a fresh turn" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-2>" } ] }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Start a fresh turn" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-2>" }, "time": "<time>" }
      [emit] turn.step.started           { "turnId": 1, "step": 1, "stepId": "<uuid-6>" }
      [emit] agent.activity.updated      { "lifecycle": "ready", "turn": { "turnId": 1, "origin": { "kind": "user" }, "phase": "running", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-6>", "turnId": "1", "step": 1 }, "time": "<time>" }
      [wire] llm.request                 { "kind": "loop", "provider": "openai", "model": "changed-model", "modelAlias": "changed-model", "thinkingEffort": "off", "maxTokens": 1000000, "toolSelect": false, "systemPromptHash": "7617cb8b42659214c397a1d7505fce204b673b078a10de8bcccc697d88dcda56", "toolsHash": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", "messageCount": 5, "turnStep": "1.1", "time": "<time>" }
      [emit] assistant.delta             { "turnId": 1, "delta": "Now the changed config is active." }
      [emit] agent.activity.updated      { "lifecycle": "ready", "turn": { "turnId": 1, "origin": { "kind": "user" }, "phase": "streaming", "stream": "assistant", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [wire] usage.record                { "model": "changed-model", "usage": { "inputOther": 50, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated        { "usage": { "byModel": { "mock-model": { "inputOther": 40, "output": 30, "inputCacheRead": 0, "inputCacheCreation": 0 }, "changed-model": { "inputOther": 50, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 90, "output": 42, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 50, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [emit] agent.status.updated        { "contextTokens": 62 }
      [emit] turn.step.completed         { "turnId": 1, "step": 1, "stepId": "<uuid-6>", "usage": { "inputOther": 50, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn", "providerFinishReason": "completed", "rawFinishReason": "stop" }
      [emit] agent.activity.updated      { "lifecycle": "ready", "turn": { "turnId": 1, "origin": { "kind": "user" }, "phase": "running", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-7>", "turnId": "1", "step": 1, "stepUuid": "<uuid-6>", "part": { "type": "text", "text": "Now the changed config is active." } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-6>", "turnId": "1", "step": 1, "finishReason": "end_turn", "usage": { "inputOther": 50, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-3", "providerFinishReason": "completed", "rawFinishReason": "stop" }, "time": "<time>" }
      [wire] turn.ended                  { "turnId": 1, "reason": "completed", "time": "<time>" }
      [emit] turn.ended                  { "turnId": 1, "reason": "completed" }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: "Changed system prompt."
      messages:
        <last>
        assistant: text "Still using the original turn config."
        user: text "Start a fresh turn"
    `);
  });
});

describe('ConfigService env overlay (live)', () => {
  it('re-applies env bindings on every get()', async () => {
    const env: Record<string, string> = { KIMI_DISABLE_CRON: '0' };
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;

    expect(config.get<CronConfig>('cron').disabled).toBe(false);
    env['KIMI_DISABLE_CRON'] = '1';
    expect(config.get<CronConfig>('cron').disabled).toBe(true);
    env['KIMI_DISABLE_CRON'] = '0';
    expect(config.get<CronConfig>('cron').disabled).toBe(false);

    disposables.dispose();
  });

  it('keeps the Kimi effort force separate from the configured effort', async () => {
    const env: Record<string, string> = { KIMI_MODEL_THINKING_EFFORT: 'max' };
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;
    await config.set(THINKING_SECTION, { effort: 'low' });

    expect(config.get<ThinkingConfig>(THINKING_SECTION)).toEqual({
      effort: 'low',
      forcedEffort: 'max',
    });

    disposables.dispose();
  });

  it('strips the Kimi effort force before persisting thinking config', async () => {
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg'));
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;

    await config.set(THINKING_SECTION, { effort: 'low', forcedEffort: 'max' });

    expect(config.inspect<ThinkingConfig>(THINKING_SECTION).userValue).toEqual({
      effort: 'low',
    });

    disposables.dispose();
  });

  it('deletes a scalar section on replace(undefined) — set(undefined) cannot', async () => {
    // Contract the refresh host relies on: an explicit undefined in a refresh
    // patch must DELETE the section. `set()` deep-merges, so an undefined
    // scalar patch resolves back to the base value; only `replace()` deletes.
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg'));
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;

    await config.replace('defaultModel', 'kimi-code/kimi-k2');
    expect(config.get<string>('defaultModel')).toBe('kimi-code/kimi-k2');

    await config.set('defaultModel', undefined);
    expect(config.get<string>('defaultModel')).toBe('kimi-code/kimi-k2');

    await config.replace('defaultModel', undefined);
    expect(config.get<string>('defaultModel')).toBeUndefined();

    disposables.dispose();
  });
});

describe('services config section env bindings', () => {
  function createConfig(env: Record<string, string>): {
    config: IConfigService;
    disposables: DisposableStore;
  } {
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    return { config: ix.get(IConfigService), disposables };
  }

  it('resolves moonshot_search / moonshot_fetch fields from KIMI_WEB_* env vars', async () => {
    const { config, disposables } = createConfig({
      [WEB_SEARCH_BASE_URL_ENV]: 'https://search-env.example/search',
      [WEB_SEARCH_API_KEY_ENV]: 'env-search-key',
      [WEB_FETCH_BASE_URL_ENV]: 'https://fetch-env.example/fetch',
      [WEB_FETCH_API_KEY_ENV]: 'env-fetch-key',
    });
    await config.ready;

    expect(config.get<ServicesConfig>(SERVICES_SECTION)).toEqual({
      moonshotSearch: { baseUrl: 'https://search-env.example/search', apiKey: 'env-search-key' },
      moonshotFetch: { baseUrl: 'https://fetch-env.example/fetch', apiKey: 'env-fetch-key' },
    });

    disposables.dispose();
  });

  it('does not inherit persisted credentials when env selects a service endpoint', async () => {
    const env: Record<string, string> = {};
    const { config, disposables } = createConfig(env);
    await config.ready;
    await config.set(SERVICES_SECTION, {
      moonshotSearch: {
        baseUrl: 'https://file.example/search',
        apiKey: 'file-search-key',
        oauth: { storage: 'file', key: 'oauth/search' },
        customHeaders: { Authorization: 'Bearer configured-search-secret' },
      },
      moonshotFetch: {
        baseUrl: 'https://file.example/fetch',
        apiKey: 'file-fetch-key',
        oauth: { storage: 'file', key: 'oauth/fetch' },
        customHeaders: { Authorization: 'Bearer configured-fetch-secret' },
      },
    });
    Object.assign(env, {
      [WEB_SEARCH_BASE_URL_ENV]: 'https://search-env.example/search',
      [WEB_SEARCH_API_KEY_ENV]: 'env-search-key',
      [WEB_FETCH_BASE_URL_ENV]: 'https://fetch-env.example/fetch',
      [WEB_FETCH_API_KEY_ENV]: 'env-fetch-key',
    });

    expect(config.get<ServicesConfig>(SERVICES_SECTION)).toEqual({
      moonshotSearch: {
        baseUrl: 'https://search-env.example/search',
        apiKey: 'env-search-key',
      },
      moonshotFetch: {
        baseUrl: 'https://fetch-env.example/fetch',
        apiKey: 'env-fetch-key',
      },
    });

    disposables.dispose();
  });

  it('uses an env API key instead of persisted OAuth for a configured endpoint', async () => {
    const env: Record<string, string> = {};
    const { config, disposables } = createConfig(env);
    await config.ready;
    await config.set(SERVICES_SECTION, {
      moonshotSearch: {
        baseUrl: 'https://file.example/search',
        oauth: { storage: 'file', key: 'oauth/search' },
        customHeaders: { 'X-Service': 'search' },
      },
    });
    env[WEB_SEARCH_API_KEY_ENV] = 'env-search-key';

    expect(config.get<ServicesConfig>(SERVICES_SECTION)?.moonshotSearch).toEqual({
      baseUrl: 'https://file.example/search',
      apiKey: 'env-search-key',
      customHeaders: { 'X-Service': 'search' },
    });

    disposables.dispose();
  });

  it('ignores blank env values instead of masking the file value', async () => {
    const { config, disposables } = createConfig({ [WEB_SEARCH_BASE_URL_ENV]: '   ' });
    await config.ready;
    await config.set(SERVICES_SECTION, {
      moonshotSearch: { baseUrl: 'https://file.example/search' },
    });

    expect(config.get<ServicesConfig>(SERVICES_SECTION)?.moonshotSearch).toEqual({
      baseUrl: 'https://file.example/search',
    });

    disposables.dispose();
  });

  it('strips env-derived fields before persisting a round-tripped effective value', async () => {
    const { config, disposables } = createConfig({
      [WEB_FETCH_BASE_URL_ENV]: 'https://fetch-env.example/fetch',
      [WEB_FETCH_API_KEY_ENV]: 'env-fetch-key',
    });
    await config.ready;
    await config.set(SERVICES_SECTION, {
      moonshotSearch: { baseUrl: 'https://file.example/search' },
    });

    const effective = config.get<ServicesConfig>(SERVICES_SECTION);
    expect(effective?.moonshotFetch).toEqual({
      baseUrl: 'https://fetch-env.example/fetch',
      apiKey: 'env-fetch-key',
    });

    await config.replace(SERVICES_SECTION, effective);
    expect(config.inspect<ServicesConfig>(SERVICES_SECTION).userValue).toEqual({
      moonshotSearch: { baseUrl: 'https://file.example/search' },
    });

    disposables.dispose();
  });

  it('clears the section on replace(undefined) even with env vars set', async () => {
    const { config, disposables } = createConfig({
      [WEB_SEARCH_BASE_URL_ENV]: 'https://search-env.example/search',
    });
    await config.ready;
    await config.set(SERVICES_SECTION, {
      moonshotSearch: { baseUrl: 'https://file.example/search' },
    });

    await config.replace(SERVICES_SECTION, undefined);

    expect(config.inspect<ServicesConfig>(SERVICES_SECTION).userValue).toBeUndefined();
    expect(config.get<ServicesConfig>(SERVICES_SECTION)?.moonshotSearch?.baseUrl).toBe(
      'https://search-env.example/search',
    );

    disposables.dispose();
  });
});

describe('skill config sections', () => {
  it('registers defaults for extraSkillDirs and mergeAllAvailableSkills', () => {
    const registry = new ConfigRegistry();

    expect(registry.getSection(EXTRA_SKILL_DIRS_SECTION)?.defaultValue).toEqual([]);
    expect(registry.getSection(MERGE_ALL_AVAILABLE_SKILLS_SECTION)?.defaultValue).toBe(true);
  });
});

describe('defaultPermissionMode config section', () => {
  it('registers the defaultPermissionMode section and not a yolo domain', () => {
    const registry = new ConfigRegistry();

    const section = registry.getSection(DEFAULT_PERMISSION_MODE_SECTION);
    expect(section).toBeDefined();
    expect(registry.validate(DEFAULT_PERMISSION_MODE_SECTION, 'auto')).toBe('auto');
    expect(registry.validate(DEFAULT_PERMISSION_MODE_SECTION, 'yolo')).toBe('yolo');
    expect(() => registry.validate(DEFAULT_PERMISSION_MODE_SECTION, 'bogus')).toThrow();

    expect(registry.getSection('yolo')).toBeUndefined();
  });
});

describe('image config section', () => {
  it('registers the image section with an empty default and a positive-int schema', () => {
    const registry = new ConfigRegistry();

    const section = registry.getSection(IMAGE_SECTION);
    expect(section).toBeDefined();
    expect(section?.defaultValue).toEqual({});

    expect(registry.validate(IMAGE_SECTION, {})).toEqual({});
    expect(
      registry.validate(IMAGE_SECTION, { maxEdgePx: 1500, readByteBudget: 131072 }),
    ).toEqual({ maxEdgePx: 1500, readByteBudget: 131072 });
    expect(registry.validate(IMAGE_SECTION, { maxEdgePx: 1500 })).toEqual({ maxEdgePx: 1500 });
    expect(() => registry.validate(IMAGE_SECTION, { maxEdgePx: 0 })).toThrow();
    expect(() => registry.validate(IMAGE_SECTION, { readByteBudget: 1.5 })).toThrow();
  });

  it('re-applies image env bindings on every get() and ignores invalid env', async () => {
    const env: Record<string, string> = {};
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;

    expect(config.get<ImageConfig>(IMAGE_SECTION)).toEqual({});

    env['KIMI_IMAGE_MAX_EDGE_PX'] = 'abc';
    env['KIMI_IMAGE_READ_BYTE_BUDGET'] = '-1';
    expect(config.get<ImageConfig>(IMAGE_SECTION)).toEqual({});

    env['KIMI_IMAGE_MAX_EDGE_PX'] = '1500';
    env['KIMI_IMAGE_READ_BYTE_BUDGET'] = '131072';
    expect(config.get<ImageConfig>(IMAGE_SECTION)).toEqual({
      maxEdgePx: 1500,
      readByteBudget: 131072,
    });

    env['KIMI_IMAGE_MAX_EDGE_PX'] = '2500';
    expect(config.get<ImageConfig>(IMAGE_SECTION).maxEdgePx).toBe(2500);

    disposables.dispose();
  });

  it('restores env-owned fields to the raw value on set() while the env var is set', async () => {
    const env: Record<string, string> = { 'KIMI_IMAGE_MAX_EDGE_PX': '1500' };
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    await storage.write(
      '',
      'config.toml',
      new TextEncoder().encode('[image]\nread_byte_budget = 131072\n'),
    );
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;

    // A client echoing the env-overlaid section back (plus a genuine edit).
    await config.set(IMAGE_SECTION, { maxEdgePx: 1500, readByteBudget: 262144 });

    // Runtime resolution still lets the env win…
    expect(config.get<ImageConfig>(IMAGE_SECTION)).toEqual({
      maxEdgePx: 1500,
      readByteBudget: 262144,
    });
    // …but persistence drops the env-owned field and keeps the genuine edit.
    expect(config.inspect<ImageConfig>(IMAGE_SECTION).userValue).toEqual({
      readByteBudget: 262144,
    });

    disposables.dispose();
  });
});

describe('tokenCounting config section', () => {
  it('registers the tokenCounting section with the mixed strategy as default', () => {
    const registry = new ConfigRegistry();

    const section = registry.getSection(TOKEN_COUNTING_SECTION);
    expect(section).toBeDefined();
    expect(section?.defaultValue).toEqual({ strategy: 'measured+estimated' });

    expect(registry.validate(TOKEN_COUNTING_SECTION, { strategy: 'measured' })).toEqual({
      strategy: 'measured',
    });
    expect(registry.validate(TOKEN_COUNTING_SECTION, { strategy: 'estimated' })).toEqual({
      strategy: 'estimated',
    });
    expect(() => registry.validate(TOKEN_COUNTING_SECTION, { strategy: 'bogus' })).toThrow();
    expect(() => registry.validate(TOKEN_COUNTING_SECTION, {})).toThrow();
  });

  it('re-applies the env override on every get() and ignores invalid values', async () => {
    const env: Record<string, string> = {};
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;

    expect(config.get<TokenCountingConfig>(TOKEN_COUNTING_SECTION)).toEqual({
      strategy: 'measured+estimated',
    });

    env[TOKEN_COUNTING_STRATEGY_ENV] = 'bogus';
    expect(config.get<TokenCountingConfig>(TOKEN_COUNTING_SECTION)).toEqual({
      strategy: 'measured+estimated',
    });

    env[TOKEN_COUNTING_STRATEGY_ENV] = 'measured';
    expect(config.get<TokenCountingConfig>(TOKEN_COUNTING_SECTION)).toEqual({
      strategy: 'measured',
    });

    env[TOKEN_COUNTING_STRATEGY_ENV] = 'estimated';
    expect(config.get<TokenCountingConfig>(TOKEN_COUNTING_SECTION)).toEqual({
      strategy: 'estimated',
    });

    disposables.dispose();
  });
});

describe('loopControl config section', () => {
  it('registers the loopControl section with a non-negative-int schema', () => {
    const registry = new ConfigRegistry();

    const section = registry.getSection(LOOP_CONTROL_SECTION);
    expect(section).toBeDefined();

    expect(registry.validate(LOOP_CONTROL_SECTION, {})).toEqual({});
    expect(
      registry.validate(LOOP_CONTROL_SECTION, { maxStepsPerTurn: 100, maxAttemptsPerStep: 3 }),
    ).toEqual({ maxStepsPerTurn: 100, maxAttemptsPerStep: 3 });
    expect(() => registry.validate(LOOP_CONTROL_SECTION, { maxStepsPerTurn: -1 })).toThrow();
    expect(() => registry.validate(LOOP_CONTROL_SECTION, { maxAttemptsPerStep: 1.5 })).toThrow();
  });

  it('re-applies loopControl env bindings on every get() and ignores invalid env', async () => {
    const env: Record<string, string> = {};
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;

    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION)).toEqual({});

    env[LOOP_MAX_STEPS_PER_TURN_ENV] = 'abc';
    env[LOOP_MAX_ATTEMPTS_PER_STEP_ENV] = '-1';
    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION)).toEqual({});

    env[LOOP_MAX_STEPS_PER_TURN_ENV] = '100';
    env[LOOP_MAX_ATTEMPTS_PER_STEP_ENV] = '3';
    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION)).toEqual({
      maxStepsPerTurn: 100,
      maxAttemptsPerStep: 3,
    });

    env[LOOP_MAX_STEPS_PER_TURN_ENV] = '50';
    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION).maxStepsPerTurn).toBe(50);

    disposables.dispose();
  });

  it('restores env-owned fields to the raw value on set() while the env var is set', async () => {
    const env: Record<string, string> = {
      [LOOP_MAX_STEPS_PER_TURN_ENV]: '7',
      [LOOP_MAX_ATTEMPTS_PER_STEP_ENV]: '2',
    };
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    await storage.write(
      '',
      'config.toml',
      new TextEncoder().encode('[loop_control]\nmax_steps_per_turn = 100\n'),
    );
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;

    // A client echoing the env-overlaid section back (plus a genuine edit).
    await config.set(LOOP_CONTROL_SECTION, {
      maxStepsPerTurn: 7,
      maxAttemptsPerStep: 2,
      reservedContextSize: 5000,
    });

    // Runtime resolution still lets the env win…
    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION)).toEqual({
      maxStepsPerTurn: 7,
      maxAttemptsPerStep: 2,
      reservedContextSize: 5000,
    });
    // …but persistence keeps the raw value and drops the env-only field.
    expect(config.inspect<LoopControl>(LOOP_CONTROL_SECTION).userValue).toEqual({
      maxStepsPerTurn: 100,
      reservedContextSize: 5000,
    });
    const onDisk = new TextDecoder().decode(await storage.read('', 'config.toml'));
    expect(onDisk).toContain('max_steps_per_turn = 100');
    expect(onDisk).toContain('reserved_context_size = 5000');
    expect(onDisk).not.toContain('max_attempts_per_step');

    disposables.dispose();
  });

  it('persists env-bound fields normally when no env var is set', async () => {
    const env: Record<string, string> = {};
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;

    await config.set(LOOP_CONTROL_SECTION, { maxStepsPerTurn: 50 });

    expect(config.inspect<LoopControl>(LOOP_CONTROL_SECTION).userValue).toEqual({
      maxStepsPerTurn: 50,
    });

    disposables.dispose();
  });

  it('does not strip a field whose env value fails to parse', async () => {
    const env: Record<string, string> = { [LOOP_MAX_STEPS_PER_TURN_ENV]: 'abc' };
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;

    await config.set(LOOP_CONTROL_SECTION, { maxStepsPerTurn: 50 });

    // The invalid env value is ignored on both the read and the write path.
    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION).maxStepsPerTurn).toBe(50);
    expect(config.inspect<LoopControl>(LOOP_CONTROL_SECTION).userValue).toEqual({
      maxStepsPerTurn: 50,
    });

    disposables.dispose();
  });

  it('recomputes env bindings from the env-free base when the env value degrades or is unset', async () => {
    const env: Record<string, string> = {};
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    await storage.write(
      '',
      'config.toml',
      new TextEncoder().encode('[loop_control]\nmax_steps_per_turn = 100\n'),
    );
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;

    env[LOOP_MAX_STEPS_PER_TURN_ENV] = '7';
    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION).maxStepsPerTurn).toBe(7);

    // A degraded env value falls back to the file, not to the previous override.
    env[LOOP_MAX_STEPS_PER_TURN_ENV] = 'abc';
    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION).maxStepsPerTurn).toBe(100);

    env[LOOP_MAX_STEPS_PER_TURN_ENV] = '9';
    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION).maxStepsPerTurn).toBe(9);

    // Unsetting falls back to the file as well, on both get() and getAll().
    delete env[LOOP_MAX_STEPS_PER_TURN_ENV];
    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION).maxStepsPerTurn).toBe(100);

    env[LOOP_MAX_STEPS_PER_TURN_ENV] = '7';
    expect(config.getAll()[LOOP_CONTROL_SECTION]).toEqual({ maxStepsPerTurn: 7 });
    delete env[LOOP_MAX_STEPS_PER_TURN_ENV];
    expect(config.getAll()[LOOP_CONTROL_SECTION]).toEqual({ maxStepsPerTurn: 100 });

    disposables.dispose();
  });

  it('warns and ignores the deprecated max_steps_per_run key without rewriting the file', async () => {
    const env: Record<string, string> = { [LOOP_MAX_STEPS_PER_TURN_ENV]: '7' };
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    await storage.write(
      '',
      'config.toml',
      new TextEncoder().encode('[loop_control]\nmax_steps_per_run = 100\n'),
    );
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;

    // The deprecated key no longer maps onto maxStepsPerTurn: the resolved
    // section carries only the env override, and the raw user value is the
    // un-normalized echo of the file (preserved, not applied).
    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION)).toEqual({ maxStepsPerTurn: 7 });
    expect(config.inspect<LoopControl>(LOOP_CONTROL_SECTION).userValue).toEqual({
      maxStepsPerRun: 100,
    });
    // …its presence is reported as a deprecation warning…
    expect(config.diagnostics()).toContainEqual({
      domain: LOOP_CONTROL_SECTION,
      severity: 'warning',
      message:
        "[loop_control] 'max_steps_per_run' is deprecated and no longer used; rename it to 'max_steps_per_turn'. Run /update-config to fix it.",
    });
    // …and a stripped write leaves the on-disk legacy key untouched.
    await config.set(LOOP_CONTROL_SECTION, { maxStepsPerTurn: 7 });
    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION).maxStepsPerTurn).toBe(7);
    const onDisk = new TextDecoder().decode(await storage.read('', 'config.toml'));
    expect(onDisk).toContain('max_steps_per_run = 100');

    disposables.dispose();
  });

  it('preserves unknown on-disk fields across repeated stripped writes', async () => {
    const env: Record<string, string> = { [LOOP_MAX_STEPS_PER_TURN_ENV]: '7' };
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    await storage.write(
      '',
      'config.toml',
      new TextEncoder().encode('[loop_control]\nfuture_field = 1\n'),
    );
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;

    await config.set(LOOP_CONTROL_SECTION, { maxStepsPerTurn: 7 });
    await config.set(LOOP_CONTROL_SECTION, { maxStepsPerTurn: 7 });

    const onDisk = new TextDecoder().decode(await storage.read('', 'config.toml'));
    expect(onDisk).toContain('future_field = 1');
    expect(onDisk).not.toContain('max_steps_per_turn');
    expect(config.inspect<LoopControl>(LOOP_CONTROL_SECTION).userValue).toEqual({
      futureField: 1,
    });

    disposables.dispose();
  });

  it('rejects the write when the env-masked on-disk value is invalid', async () => {
    const env: Record<string, string> = { [LOOP_MAX_STEPS_PER_TURN_ENV]: '7' };
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    await storage.write(
      '',
      'config.toml',
      new TextEncoder().encode('[loop_control]\nmax_steps_per_turn = -1\n'),
    );
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;

    await expect(
      config.set(LOOP_CONTROL_SECTION, { maxStepsPerTurn: 7, reservedContextSize: 5000 }),
    ).rejects.toThrow();

    // Nothing is persisted: the invalid value stays quarantined on disk and
    // the accompanying valid edit is not written either.
    const onDisk = new TextDecoder().decode(await storage.read('', 'config.toml'));
    expect(onDisk).toContain('max_steps_per_turn = -1');
    expect(onDisk).not.toContain('reserved_context_size');

    disposables.dispose();
  });
});

describe('config deprecations', () => {
  async function createConfig(env: Record<string, string>, toml?: string) {
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    if (toml !== undefined) {
      await storage.write('', 'config.toml', new TextEncoder().encode(toml));
    }
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;
    return { config, disposables, storage };
  }

  it('warns and ignores a deprecated TOML key whose value no longer applies', async () => {
    const { config, disposables } = await createConfig(
      {},
      '[loop_control]\nmax_retries_per_step = 3\n',
    );

    // The old value is NOT mapped onto the new field…
    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION)).toEqual({});
    // …and the file is left untouched — the warning is the migration guide.
    expect(config.diagnostics()).toContainEqual({
      domain: LOOP_CONTROL_SECTION,
      severity: 'warning',
      message:
        "[loop_control] 'max_retries_per_step' is deprecated and no longer used; rename it to 'max_attempts_per_step'. Run /update-config to fix it.",
    });

    disposables.dispose();
  });

  it('lets the replacement key win when both are present, still warning', async () => {
    const { config, disposables } = await createConfig(
      {},
      '[loop_control]\nmax_retries_per_step = 3\nmax_attempts_per_step = 2\n',
    );

    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION)).toEqual({ maxAttemptsPerStep: 2 });
    expect(config.diagnostics()).toContainEqual({
      domain: LOOP_CONTROL_SECTION,
      severity: 'warning',
      message:
        "[loop_control] 'max_retries_per_step' is deprecated and no longer used; rename it to 'max_attempts_per_step'. Run /update-config to fix it.",
    });

    disposables.dispose();
  });

  it('resolves a deprecated env var as a fallback with a warning, new var first', async () => {
    const env: Record<string, string> = { [LOOP_MAX_RETRIES_PER_STEP_ENV]: '4' };
    const { config, disposables } = await createConfig(env);

    // The deprecated var still supplies the value…
    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION)).toEqual({ maxAttemptsPerStep: 4 });
    // …with a deprecation warning…
    expect(config.diagnostics()).toContainEqual({
      domain: LOOP_CONTROL_SECTION,
      severity: 'warning',
      message: `Environment variable ${LOOP_MAX_RETRIES_PER_STEP_ENV} is deprecated; use ${LOOP_MAX_ATTEMPTS_PER_STEP_ENV} instead.`,
    });
    // …and the replacement var wins as soon as it appears.
    env[LOOP_MAX_ATTEMPTS_PER_STEP_ENV] = '2';
    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION)).toEqual({ maxAttemptsPerStep: 2 });

    disposables.dispose();
  });

  it('reports no env deprecation when only the replacement var is set', async () => {
    const env: Record<string, string> = { [LOOP_MAX_ATTEMPTS_PER_STEP_ENV]: '4' };
    const { config, disposables } = await createConfig(env);

    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION)).toEqual({ maxAttemptsPerStep: 4 });
    expect(config.diagnostics()).toEqual([]);

    disposables.dispose();
  });

  it('keeps the deprecated env warning across a no-op reload', async () => {
    const env: Record<string, string> = { [LOOP_MAX_RETRIES_PER_STEP_ENV]: '4' };
    const { config, disposables } = await createConfig(env);

    const warning = {
      domain: LOOP_CONTROL_SECTION,
      severity: 'warning' as const,
      message: `Environment variable ${LOOP_MAX_RETRIES_PER_STEP_ENV} is deprecated; use ${LOOP_MAX_ATTEMPTS_PER_STEP_ENV} instead.`,
    };
    expect(config.diagnostics()).toContainEqual(warning);

    // The file never changed, so reload takes the unchanged early return —
    // the env-derived warning must survive it.
    await config.reload();

    expect(config.diagnostics()).toContainEqual(warning);
    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION)).toEqual({ maxAttemptsPerStep: 4 });

    disposables.dispose();
  });

  it('restores the env-owned field on set() when only the deprecated env var is set', async () => {
    const env: Record<string, string> = { [LOOP_MAX_RETRIES_PER_STEP_ENV]: '2' };
    const { config, disposables, storage } = await createConfig(
      env,
      '[loop_control]\nmax_attempts_per_step = 9\n',
    );

    // A client echoing the env-overlaid section back (plus a genuine edit).
    await config.set(LOOP_CONTROL_SECTION, { maxAttemptsPerStep: 2, reservedContextSize: 5000 });

    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION)).toEqual({
      maxAttemptsPerStep: 2,
      reservedContextSize: 5000,
    });
    // The deprecated env still owns the field: persistence restores the raw
    // value instead of leaking the echoed env value.
    expect(config.inspect<LoopControl>(LOOP_CONTROL_SECTION).userValue).toEqual({
      maxAttemptsPerStep: 9,
      reservedContextSize: 5000,
    });
    const onDisk = new TextDecoder().decode(await storage.read('', 'config.toml'));
    expect(onDisk).toContain('max_attempts_per_step = 9');

    disposables.dispose();
  });

  it('emits onDidChangeDiagnostics on load and again when the warning clears', async () => {
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    await storage.write(
      '',
      'config.toml',
      new TextEncoder().encode('[loop_control]\nmax_retries_per_step = 3\n'),
    );
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', {}));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    const emissions: Array<readonly unknown[]> = [];
    config.onDidChangeDiagnostics((diagnostics) => {
      emissions.push(diagnostics);
    });
    await config.ready;

    expect(emissions).toHaveLength(1);
    expect(emissions[0]).toContainEqual({
      domain: LOOP_CONTROL_SECTION,
      severity: 'warning',
      message:
        "[loop_control] 'max_retries_per_step' is deprecated and no longer used; rename it to 'max_attempts_per_step'. Run /update-config to fix it.",
    });

    // Renaming the key on disk clears the warning on the next reload.
    await storage.write(
      '',
      'config.toml',
      new TextEncoder().encode('[loop_control]\nmax_attempts_per_step = 3\n'),
    );
    await config.reload();

    expect(emissions).toHaveLength(2);
    expect(emissions[1]).toEqual([]);
    expect(config.diagnostics()).toEqual([]);
    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION)).toEqual({ maxAttemptsPerStep: 3 });

    disposables.dispose();
  });
});

describe('task config section', () => {
  it('re-applies the keepAliveOnExit env binding on every get()', async () => {
    const env: Record<string, string> = {};
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;

    expect(config.get<AgentTaskConfig>('task')?.keepAliveOnExit).toBeUndefined();

    env[KEEP_ALIVE_ON_EXIT_ENV] = '1';
    expect(config.get<AgentTaskConfig>('task')?.keepAliveOnExit).toBe(true);
    env[KEEP_ALIVE_ON_EXIT_ENV] = '0';
    expect(config.get<AgentTaskConfig>('task')?.keepAliveOnExit).toBe(false);

    env[KEEP_ALIVE_ON_EXIT_ENV] = 'true';
    expect(config.get<AgentTaskConfig>('background')?.keepAliveOnExit).toBe(true);

    disposables.dispose();
  });

  it('preserves legacy task limits when the env binding creates a task overlay', async () => {
    const env: Record<string, string> = { [KEEP_ALIVE_ON_EXIT_ENV]: 'true' };
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    await storage.write(
      '',
      'config.toml',
      new TextEncoder().encode(
        '[background]\nmax_running_tasks = 3\nkill_grace_period_ms = 25\n',
      ),
    );
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;

    expect(resolveAgentTaskConfig(config)).toEqual({
      maxRunningTasks: 3,
      killGracePeriodMs: 25,
      keepAliveOnExit: true,
    });

    disposables.dispose();
  });

  it('re-applies the maxRunningTasks env binding on every get() and ignores invalid env', async () => {
    const env: Record<string, string> = {};
    const { config, disposables } = await createTaskConfig(env);

    expect(config.get<AgentTaskConfig>('task')?.maxRunningTasks).toBeUndefined();

    env[MAX_RUNNING_TASKS_ENV] = 'abc';
    expect(config.get<AgentTaskConfig>('task')?.maxRunningTasks).toBeUndefined();
    env[MAX_RUNNING_TASKS_ENV] = '0';
    expect(config.get<AgentTaskConfig>('task')?.maxRunningTasks).toBeUndefined();

    env[MAX_RUNNING_TASKS_ENV] = '4';
    expect(config.get<AgentTaskConfig>('task')?.maxRunningTasks).toBe(4);
    expect(config.get<AgentTaskConfig>('background')?.maxRunningTasks).toBe(4);

    env[MAX_RUNNING_TASKS_ENV] = '2';
    expect(config.get<AgentTaskConfig>('task')?.maxRunningTasks).toBe(2);

    disposables.dispose();
  });

  it('lets the maxRunningTasks env binding override the config value', async () => {
    const env: Record<string, string> = { [MAX_RUNNING_TASKS_ENV]: '8' };
    const { config, disposables } = await createTaskConfig(
      env,
      '[background]\nmax_running_tasks = 3\n',
    );

    expect(resolveAgentTaskConfig(config)?.maxRunningTasks).toBe(8);

    disposables.dispose();
  });

  it('restores env-owned fields to the raw value on set() while the env var is set', async () => {
    const env: Record<string, string> = {
      [KEEP_ALIVE_ON_EXIT_ENV]: 'true',
      [MAX_RUNNING_TASKS_ENV]: '8',
    };
    const { config, disposables } = await createTaskConfig(
      env,
      '[background]\nmax_running_tasks = 3\n',
    );

    // A client echoing the env-overlaid section back (plus a genuine edit).
    await config.set('background', {
      keepAliveOnExit: true,
      maxRunningTasks: 8,
      killGracePeriodMs: 25,
    });

    // Runtime resolution still lets the env win…
    expect(config.get<AgentTaskConfig>('background')).toEqual({
      keepAliveOnExit: true,
      maxRunningTasks: 8,
      killGracePeriodMs: 25,
    });
    // …but persistence keeps the raw value and drops the env-only field.
    expect(config.inspect<AgentTaskConfig>('background').userValue).toEqual({
      maxRunningTasks: 3,
      killGracePeriodMs: 25,
    });

    disposables.dispose();
  });

  it('does not strip a field whose env value fails to parse', async () => {
    const env: Record<string, string> = { [KEEP_ALIVE_ON_EXIT_ENV]: 'abc' };
    const { config, disposables } = await createTaskConfig(env);

    await config.set('background', { keepAliveOnExit: true });

    // The invalid env value is ignored on both the read and the write path.
    expect(config.get<AgentTaskConfig>('background')?.keepAliveOnExit).toBe(true);
    expect(config.inspect<AgentTaskConfig>('background').userValue).toEqual({
      keepAliveOnExit: true,
    });

    disposables.dispose();
  });

  async function createTaskConfig(env: Record<string, string>, toml?: string) {
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    if (toml !== undefined) {
      await storage.write('', 'config.toml', new TextEncoder().encode(toml));
    }
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;
    return { config, disposables };
  }

  it('parses print policy fields and merges legacy background with task overrides', async () => {
    const { config, disposables } = await createTaskConfig(
      {},
      '[background]\nprint_background_mode = "steer"\nprint_wait_ceiling_s = 60\n\n' +
        '[task]\nprint_max_turns = 5\n',
    );

    expect(resolveAgentTaskConfig(config)).toEqual({
      printBackgroundMode: 'steer',
      printWaitCeilingS: 60,
      printMaxTurns: 5,
    });

    disposables.dispose();
  });

  it('drops the task section with a warning when a print policy value is invalid', async () => {
    const { config, disposables } = await createTaskConfig(
      {},
      '[task]\nprint_background_mode = "wait"\n',
    );
    expect(config.get<AgentTaskConfig>('task')?.printBackgroundMode).toBeUndefined();
    expect(
      config
        .diagnostics()
        .some((d) => d.message.includes("Ignored invalid config section 'task'")),
    ).toBe(true);
    disposables.dispose();
  });

  it('resolvePrintBackgroundMode prefers the explicit mode over keepAliveOnExit', async () => {
    const { config, disposables } = await createTaskConfig(
      {},
      '[task]\nprint_background_mode = "exit"\nkeep_alive_on_exit = true\n',
    );
    expect(resolvePrintBackgroundMode(config)).toBe('exit');
    disposables.dispose();
  });

  it('resolvePrintBackgroundMode falls back to keepAliveOnExit then steer', async () => {
    const env: Record<string, string> = {};
    const { config, disposables } = await createTaskConfig(env);

    expect(resolvePrintBackgroundMode(config)).toBe('steer');

    env[KEEP_ALIVE_ON_EXIT_ENV] = 'true';
    expect(resolvePrintBackgroundMode(config)).toBe('drain');

    disposables.dispose();
  });
});

describe('applyPrintModeConfigDefaults', () => {
  async function createConfig(env: Record<string, string>, toml?: string) {
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    if (toml !== undefined) {
      await storage.write('', 'config.toml', new TextEncoder().encode(toml));
    }
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;
    return { config, disposables };
  }

  it('fills unset keys into the memory layer with effectively unbounded values', async () => {
    const { config, disposables } = await createConfig({});

    await applyPrintModeConfigDefaults(config);

    expect(resolveAgentTaskConfig(config)?.bashTaskTimeoutS).toBe(0);
    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION)?.maxStepsPerTurn).toBe(0);
    expect(resolveSubagentTimeoutMs(config)).toBe(0);
    expect(config.inspect('task').memoryValue).toMatchObject({ bashTaskTimeoutS: 0 });
    expect(config.inspect(LOOP_CONTROL_SECTION).memoryValue).toMatchObject({
      maxStepsPerTurn: 0,
    });
    expect(config.inspect('subagent').memoryValue).toMatchObject({ timeoutMs: 0 });

    disposables.dispose();
  });

  it('does not override keys the user set explicitly', async () => {
    const { config, disposables } = await createConfig(
      {},
      '[task]\nbash_task_timeout_s = 30\n\n' +
        '[loop_control]\nmax_steps_per_turn = 7\n\n' +
        '[subagent]\ntimeout_ms = 5000\n',
    );

    await applyPrintModeConfigDefaults(config);

    expect(resolveAgentTaskConfig(config)?.bashTaskTimeoutS).toBe(30);
    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION)?.maxStepsPerTurn).toBe(7);
    expect(resolveSubagentTimeoutMs(config)).toBe(5000);
    expect(config.inspect('task').memoryValue).toBeUndefined();
    expect(config.inspect(LOOP_CONTROL_SECTION).memoryValue).toBeUndefined();
    expect(config.inspect('subagent').memoryValue).toBeUndefined();

    disposables.dispose();
  });

  it('treats a legacy [background] bash_task_timeout_s as user-set', async () => {
    const { config, disposables } = await createConfig(
      {},
      '[background]\nbash_task_timeout_s = 15\n',
    );

    await applyPrintModeConfigDefaults(config);

    expect(resolveAgentTaskConfig(config)?.bashTaskTimeoutS).toBe(15);

    disposables.dispose();
  });

  it('keeps sibling user keys of a filled section visible', async () => {
    const { config, disposables } = await createConfig(
      {},
      '[task]\nprint_background_mode = "drain"\n\n[loop_control]\nmax_attempts_per_step = 5\n',
    );

    await applyPrintModeConfigDefaults(config);

    expect(resolvePrintBackgroundMode(config)).toBe('drain');
    expect(resolveAgentTaskConfig(config)?.bashTaskTimeoutS).toBe(0);
    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION)).toMatchObject({
      maxAttemptsPerStep: 5,
      maxStepsPerTurn: 0,
    });

    disposables.dispose();
  });

  it('does not override the subagent timeout env override', async () => {
    const env: Record<string, string> = { [SUBAGENT_TIMEOUT_ENV]: '3000' };
    const { config, disposables } = await createConfig(env);

    await applyPrintModeConfigDefaults(config);

    expect(resolveSubagentTimeoutMs(config)).toBe(3000);

    disposables.dispose();
  });
});

describe('subagent config section', () => {
  async function createConfig(env: Record<string, string>, toml?: string) {
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    if (toml !== undefined) {
      await storage.write('', 'config.toml', new TextEncoder().encode(toml));
    }
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;
    return { config, disposables };
  }

  it('defaults to two hours and honours the env override', async () => {
    const env: Record<string, string> = {};
    const { config, disposables } = await createConfig(env);

    expect(resolveSubagentTimeoutMs(config)).toBe(DEFAULT_SUBAGENT_TIMEOUT_MS);

    env[SUBAGENT_TIMEOUT_ENV] = 'abc';
    expect(resolveSubagentTimeoutMs(config)).toBe(DEFAULT_SUBAGENT_TIMEOUT_MS);

    env[SUBAGENT_TIMEOUT_ENV] = '3000';
    expect(resolveSubagentTimeoutMs(config)).toBe(3000);

    disposables.dispose();
  });

  it('reads timeout_ms from config.toml and lets the env var win', async () => {
    const env: Record<string, string> = {};
    const { config, disposables } = await createConfig(env, '[subagent]\ntimeout_ms = 5000\n');
    expect(resolveSubagentTimeoutMs(config)).toBe(5000);

    env[SUBAGENT_TIMEOUT_ENV] = '7000';
    expect(resolveSubagentTimeoutMs(config)).toBe(7000);

    disposables.dispose();
  });

  it('restores the env-owned timeout to the raw value on set() while the env var is set', async () => {
    const env: Record<string, string> = { [SUBAGENT_TIMEOUT_ENV]: '7000' };
    const { config, disposables } = await createConfig(env, '[subagent]\ntimeout_ms = 5000\n');

    // A client echoing the env-overlaid section back.
    await config.set(SUBAGENT_SECTION, { timeoutMs: 7000 });

    // Runtime resolution still lets the env win…
    expect(resolveSubagentTimeoutMs(config)).toBe(7000);
    // …but persistence keeps the raw value.
    expect(config.inspect<SubagentConfig>(SUBAGENT_SECTION).userValue).toEqual({
      timeoutMs: 5000,
    });

    disposables.dispose();
  });

  it('clears the raw section when stripping removes the last persisted field', async () => {
    const env: Record<string, string> = { [SUBAGENT_TIMEOUT_ENV]: '7000' };
    const { config, disposables } = await createConfig(env);

    // A client echoing the env-overlaid section back: nothing persistable
    // remains, so the raw section is cleared instead of shadowing the default
    // with an empty object.
    await config.set(SUBAGENT_SECTION, { timeoutMs: 7000 });

    expect(resolveSubagentTimeoutMs(config)).toBe(7000);
    expect(config.inspect<SubagentConfig>(SUBAGENT_SECTION).userValue).toBeUndefined();

    delete env[SUBAGENT_TIMEOUT_ENV];
    expect(config.get<SubagentConfig>(SUBAGENT_SECTION)).toEqual({
      timeoutMs: DEFAULT_SUBAGENT_TIMEOUT_MS,
    });

    disposables.dispose();
  });

  it('resolves the spawn binding: secondary by default, primary on request, inherit otherwise', async () => {
    const own = { modelAlias: 'provider/main', thinkingLevel: 'medium' };

    const noModel = await createConfig({});
    expect(resolveSubagentBinding(noModel.config, secondaryModelFlags(), own)).toEqual({
      model: 'provider/main',
      thinking: 'medium',
    });
    expect(resolveSubagentBinding(noModel.config, secondaryModelFlags(), own, 'secondary')).toEqual({
      model: 'provider/main',
      thinking: 'medium',
    });
    noModel.disposables.dispose();

    const withModel = await createConfig({}, '[secondary_model]\nmodel = "provider/secondary"\n');
    // Pointer-only recipe: bind the pointed entry directly; thinking resolves
    // naturally (no inheriting the caller's level).
    expect(resolveSubagentBinding(withModel.config, secondaryModelFlags(), own)).toEqual({
      model: 'provider/secondary',
      thinking: undefined,
    });
    expect(resolveSubagentBinding(withModel.config, secondaryModelFlags(), own, 'primary')).toEqual({
      model: 'provider/main',
      thinking: 'medium',
    });
    withModel.disposables.dispose();

    const withEffort = await createConfig(
      {},
      '[secondary_model]\nmodel = "provider/secondary"\ndefault_effort = "low"\n',
    );
    // Patch fields bind the synthesized derived entry; default_effort is the
    // explicit subagent thinking.
    expect(resolveSubagentBinding(withEffort.config, secondaryModelFlags(), own)).toEqual({
      model: SECONDARY_DERIVED_MODEL_ID,
      thinking: 'low',
    });
    // default_effort only applies together with the secondary model.
    expect(resolveSubagentBinding(withEffort.config, secondaryModelFlags(), own, 'primary')).toEqual({
      model: 'provider/main',
      thinking: 'medium',
    });
    withEffort.disposables.dispose();

    const withFactPatch = await createConfig(
      {},
      '[secondary_model]\nmodel = "provider/secondary"\nmax_output_size = 8192\n',
    );
    expect(resolveSubagentBinding(withFactPatch.config, secondaryModelFlags(), own)).toEqual({
      model: SECONDARY_DERIVED_MODEL_ID,
      thinking: undefined,
    });
    withFactPatch.disposables.dispose();
  });

  it('inherits the caller binding when the secondary-model experiment is disabled', async () => {
    const own = { modelAlias: 'provider/main', thinkingLevel: 'medium' };
    const { config, disposables } = await createConfig(
      {},
      '[secondary_model]\nmodel = "provider/secondary"\ndefault_effort = "low"\n',
    );

    expect(resolveSubagentBinding(config, secondaryModelFlags(false), own)).toEqual({
      model: 'provider/main',
      thinking: 'medium',
    });

    disposables.dispose();
  });

  it('preserves the coded error contract when adding secondary-model guidance', () => {
    const cause = new Error2(
      ErrorCodes.CONFIG_INVALID,
      'Model "provider/bad" is not configured in config.toml.',
      { details: { model: 'provider/bad' } },
    );

    const result = wrapSubagentModelError(cause, 'provider/bad', 'provider/main');

    expect(toErrorPayload(result)).toMatchObject({
      code: ErrorCodes.CONFIG_INVALID,
      message: expect.stringContaining('comes from [secondary_model].model / KIMI_SECONDARY_MODEL'),
      details: {
        model: 'provider/bad',
        secondaryModel: 'provider/bad',
        secondaryModelConfig: {
          section: 'secondaryModel.model',
          environment: SECONDARY_MODEL_ENV,
        },
      },
      cause: {
        code: ErrorCodes.CONFIG_INVALID,
        details: { model: 'provider/bad' },
      },
    });
  });

  it('passes through config-invalid failures that are not a missing bound alias', () => {
    // A malformed [models.*] entry fails without details.model.
    const malformed = new Error2(
      ErrorCodes.CONFIG_INVALID,
      'Model "provider/secondary" must declare a wire protocol (config: models.<id>.protocol).',
    );
    expect(wrapSubagentModelError(malformed, 'provider/secondary', 'provider/main')).toBe(malformed);

    // A missing alias that is not the bound model.
    const unrelated = new Error2(
      ErrorCodes.CONFIG_INVALID,
      'Model "provider/other" is not configured in config.toml.',
      { details: { model: 'provider/other' } },
    );
    expect(wrapSubagentModelError(unrelated, 'provider/secondary', 'provider/main')).toBe(unrelated);
  });
});

describe('secondaryModel config section', () => {
  async function createConfig(env: Record<string, string>, toml?: string) {
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    if (toml !== undefined) {
      await storage.write('', 'config.toml', new TextEncoder().encode(toml));
    }
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;
    return { config, disposables };
  }

  it('reads model/default_effort from config.toml and lets the env vars win', async () => {
    const env: Record<string, string> = {};
    const { config, disposables } = await createConfig(
      env,
      '[secondary_model]\nmodel = "provider/secondary"\ndefault_effort = "low"\n',
    );
    expect(resolveSecondaryModel(config, secondaryModelFlags())?.model).toBe('provider/secondary');
    expect(resolveSecondaryModel(config, secondaryModelFlags())?.defaultEffort).toBe('low');

    env[SECONDARY_MODEL_ENV] = 'provider/env-secondary';
    env[SECONDARY_MODEL_EFFORT_ENV] = 'high';
    expect(resolveSecondaryModel(config, secondaryModelFlags())?.model).toBe('provider/env-secondary');
    expect(resolveSecondaryModel(config, secondaryModelFlags())?.defaultEffort).toBe('high');

    // Blank env values are ignored.
    env[SECONDARY_MODEL_ENV] = '  ';
    expect(resolveSecondaryModel(config, secondaryModelFlags())?.model).toBe('provider/secondary');

    disposables.dispose();
  });

  it('restores the env-owned model to the raw value on set() while the env var is set', async () => {
    const env: Record<string, string> = { [SECONDARY_MODEL_ENV]: 'provider/env-secondary' };
    const { config, disposables } = await createConfig(
      env,
      '[secondary_model]\nmodel = "provider/raw-secondary"\n',
    );

    // A client echoing the env-overlaid section back.
    await config.set(SECONDARY_MODEL_SECTION, { model: 'provider/env-secondary' });

    expect(resolveSecondaryModel(config, secondaryModelFlags())?.model).toBe('provider/env-secondary');
    expect(config.inspect<SecondaryModelConfig>(SECONDARY_MODEL_SECTION).userValue).toEqual({
      model: 'provider/raw-secondary',
    });

    disposables.dispose();
  });

  it('propagates overlay-induced models changes to section events on runtime set', async () => {
    const { config, disposables } = await createConfig(
      {},
      '[models.k2]\nprovider = "kimi"\nmodel = "kimi-k2"\n',
    );
    const domains: string[] = [];
    config.onDidSectionChange((e) => domains.push(e.domain));

    // Runtime set with patch fields: the derived entry appears in the
    // effective models view AND the models section event fires — the
    // persistence bridge re-hydrates the registry from that event.
    await config.set(SECONDARY_MODEL_SECTION, { model: 'k2', maxOutputSize: 8192 });
    const models = config.get<Record<string, unknown>>(MODELS_SECTION) ?? {};
    expect(models[SECONDARY_DERIVED_MODEL_ID]).toBeDefined();
    expect(domains).toContain(SECONDARY_MODEL_SECTION);
    expect(domains).toContain(MODELS_SECTION);

    // Removing the patch retracts the derived entry and fires again.
    domains.length = 0;
    await config.replace(SECONDARY_MODEL_SECTION, { model: 'k2' });
    const after = config.get<Record<string, unknown>>(MODELS_SECTION) ?? {};
    expect(after[SECONDARY_DERIVED_MODEL_ID]).toBeUndefined();
    expect(domains).toContain(MODELS_SECTION);

    disposables.dispose();
  });
});

describe('mcp config section', () => {
  async function createConfig(env: Record<string, string>, toml?: string) {
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    if (toml !== undefined) {
      await storage.write('', 'config.toml', new TextEncoder().encode(toml));
    }
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;
    return { config, disposables };
  }

  it('is unset by default and honours the env override', async () => {
    const env: Record<string, string> = {};
    const { config, disposables } = await createConfig(env);

    expect(config.get<McpSection | undefined>(MCP_SECTION)?.startupTimeoutMs).toBeUndefined();

    env[MCP_STARTUP_TIMEOUT_ENV] = 'abc';
    expect(config.get<McpSection | undefined>(MCP_SECTION)?.startupTimeoutMs).toBeUndefined();

    env[MCP_STARTUP_TIMEOUT_ENV] = '60000';
    expect(config.get<McpSection | undefined>(MCP_SECTION)?.startupTimeoutMs).toBe(60000);

    disposables.dispose();
  });

  it('accepts the Node.js timer upper boundary', () => {
    expect(
      McpSectionSchema.safeParse({
        startupTimeoutMs: 2_147_483_647,
        toolTimeoutMs: 2_147_483_647,
      }).success,
    ).toBe(true);
  });

  it('rejects config timeouts above the Node.js timer limit', () => {
    expect(
      McpSectionSchema.safeParse({
        startupTimeoutMs: 2_147_483_648,
        toolTimeoutMs: 2_147_483_648,
      }).success,
    ).toBe(false);
  });

  it('falls back to config when env timeouts exceed the Node.js timer limit', async () => {
    const env: Record<string, string> = {
      [MCP_STARTUP_TIMEOUT_ENV]: '2147483648',
      [MCP_TOOL_TIMEOUT_ENV]: '2147483648',
    };
    const { config, disposables } = await createConfig(
      env,
      '[mcp]\nstartup_timeout_ms = 5000\ntool_timeout_ms = 60000\n',
    );
    try {
      expect(config.get<McpSection | undefined>(MCP_SECTION)).toEqual({
        startupTimeoutMs: 5000,
        toolTimeoutMs: 60000,
      });
    } finally {
      disposables.dispose();
    }
  });

  it('reads startup_timeout_ms from config.toml and lets the env var win', async () => {
    const env: Record<string, string> = {};
    const { config, disposables } = await createConfig(env, '[mcp]\nstartup_timeout_ms = 5000\n');
    expect(config.get<McpSection | undefined>(MCP_SECTION)?.startupTimeoutMs).toBe(5000);

    env[MCP_STARTUP_TIMEOUT_ENV] = '7000';
    expect(config.get<McpSection | undefined>(MCP_SECTION)?.startupTimeoutMs).toBe(7000);

    disposables.dispose();
  });

  it('reads tool_timeout_ms from config.toml and lets the env var win', async () => {
    const env: Record<string, string> = {};
    const { config, disposables } = await createConfig(env, '[mcp]\ntool_timeout_ms = 60000\n');
    expect(config.get<McpSection | undefined>(MCP_SECTION)?.toolTimeoutMs).toBe(60000);

    env[MCP_TOOL_TIMEOUT_ENV] = 'abc';
    expect(config.get<McpSection | undefined>(MCP_SECTION)?.toolTimeoutMs).toBe(60000);

    env[MCP_TOOL_TIMEOUT_ENV] = '90000';
    expect(config.get<McpSection | undefined>(MCP_SECTION)?.toolTimeoutMs).toBe(90000);

    disposables.dispose();
  });

  it('restores the env-owned timeout to the raw value on set() while the env var is set', async () => {
    const env: Record<string, string> = { [MCP_STARTUP_TIMEOUT_ENV]: '7000' };
    const { config, disposables } = await createConfig(env, '[mcp]\nstartup_timeout_ms = 5000\n');

    // A client echoing the env-overlaid section back.
    await config.set(MCP_SECTION, { startupTimeoutMs: 7000 });

    // Runtime resolution still lets the env win…
    expect(config.get<McpSection | undefined>(MCP_SECTION)?.startupTimeoutMs).toBe(7000);
    // …but persistence keeps the raw value.
    expect(config.inspect<McpSection>(MCP_SECTION).userValue).toEqual({
      startupTimeoutMs: 5000,
    });

    disposables.dispose();
  });
});

describe('get() freshness for overlay-written domains', () => {
  it('recomputes overlay values on every get()', async () => {
    const env: Record<string, string> = {};
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;

    ix.get(IConfigRegistry).registerEffectiveOverlay({
      apply(effective, getEnv) {
        if (getEnv('SMOKE_OVERLAY_FLAG') !== '1') return [];
        effective['overlayDomain'] = { flag: true };
        return ['overlayDomain'];
      },
    });

    expect(config.get('overlayDomain')).toBeUndefined();
    env['SMOKE_OVERLAY_FLAG'] = '1';
    expect(config.get('overlayDomain')).toEqual({ flag: true });
    delete env['SMOKE_OVERLAY_FLAG'];
    expect(config.get('overlayDomain')).toBeUndefined();

    disposables.dispose();
  });
});

describe('nested env bindings', () => {
  it('does not mutate the env-free base when applying nested bindings', async () => {
    const env: Record<string, string> = {};
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    await storage.write(
      '',
      'config.toml',
      new TextEncoder().encode('[nested_demo.inner]\nvalue = "file"\n'),
    );
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;

    const nestedSchema = { parse: (value: unknown) => value as { inner?: { value?: string } } };
    ix.get(IConfigRegistry).registerSection('nestedDemo', nestedSchema, {
      env: { inner: { value: 'SMOKE_NESTED_ENV' } },
    });

    env['SMOKE_NESTED_ENV'] = 'env-value';
    expect(config.get<{ inner?: { value?: string } }>('nestedDemo')).toEqual({
      inner: { value: 'env-value' },
    });

    delete env['SMOKE_NESTED_ENV'];
    expect(config.get<{ inner?: { value?: string } }>('nestedDemo')).toEqual({
      inner: { value: 'file' },
    });

    disposables.dispose();
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

describe('ConfigService thinking effort max migration', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'kimi-v2-cfg-migrate-'));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  async function createMigratingConfig(toml: string) {
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    await storage.write('', 'config.toml', new TextEncoder().encode(toml));
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap(homeDir));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;
    return { config, disposables };
  }

  function readMarkers(): Record<string, string> {
    return JSON.parse(readFileSync(join(homeDir, 'migrations-effort.json'), 'utf-8')) as Record<
      string,
      string
    >;
  }

  it('rewrites a persisted max to high on first load and records the marker', async () => {
    const { config, disposables } = await createMigratingConfig(
      '[thinking]\nenabled = true\neffort = "max"\n',
    );

    expect(config.get<ThinkingConfig>(THINKING_SECTION)).toEqual({
      enabled: true,
      effort: 'high',
    });
    expect(readMarkers()['thinking-effort-max-to-high']).toBeDefined();

    disposables.dispose();
  });

  it('honors a hand-set max once the marker exists', async () => {
    writeFileSync(
      join(homeDir, 'migrations-effort.json'),
      JSON.stringify({ 'thinking-effort-max-to-high': new Date().toISOString() }),
    );
    const { config, disposables } = await createMigratingConfig('[thinking]\neffort = "max"\n');

    expect(config.get<ThinkingConfig>(THINKING_SECTION)).toEqual({ effort: 'max' });

    disposables.dispose();
  });

  it('records the marker even when nothing needs migrating', async () => {
    const { config, disposables } = await createMigratingConfig('[thinking]\neffort = "low"\n');

    expect(config.get<ThinkingConfig>(THINKING_SECTION)).toEqual({ effort: 'low' });
    expect(readMarkers()['thinking-effort-max-to-high']).toBeDefined();

    disposables.dispose();
  });
});

describe('ConfigService replaceSections', () => {
  // Top-level keys must precede every [table] header in TOML.
  const SEED_TOML = [
    'default_model = "acme/m1"',
    '',
    '[providers.acme]',
    'type = "openai"',
    'api_key = "sk-acme"',
    '',
    '[models."acme/m1"]',
    'provider = "acme"',
    'model = "m1"',
    'max_context_size = 1000',
    '',
    '[thinking]',
    'enabled = true',
    '',
  ].join('\n');

  async function createSectionsConfig(toml = SEED_TOML) {
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    await storage.write('', 'config.toml', new TextEncoder().encode(toml));
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg-replace-sections'));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;
    const store = ix.get(IAtomicTomlDocumentStore);
    return { config, disposables, store, storage };
  }

  it('applies every domain in one transition with a single disk write, clearing undefined domains', async () => {
    const { config, disposables, store } = await createSectionsConfig();
    const setSpy = vi.spyOn(store, 'set');

    await config.replaceSections({
      [PROVIDERS_SECTION]: { acme: { type: 'openai', apiKey: 'sk-acme-2' } },
      [MODELS_SECTION]: { 'acme/m2': { provider: 'acme', model: 'm2', maxContextSize: 2000 } },
      [DEFAULT_MODEL_SECTION]: undefined,
      [THINKING_SECTION]: undefined,
    });

    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(config.get<Record<string, unknown>>(PROVIDERS_SECTION)).toEqual({
      acme: { type: 'openai', apiKey: 'sk-acme-2' },
    });
    expect(config.get<Record<string, unknown>>(MODELS_SECTION)).toEqual({
      'acme/m2': { provider: 'acme', model: 'm2', maxContextSize: 2000 },
    });
    expect(config.get(DEFAULT_MODEL_SECTION)).toBeUndefined();
    expect(config.get(THINKING_SECTION)).toEqual({});
    expect(config.inspect(DEFAULT_MODEL_SECTION).userValue).toBeUndefined();
    // `stripThinkingEnv` maps a clear to `{}` (`{...undefined}`), so the user
    // layer collapses to an empty object instead of disappearing — the
    // long-standing `replace(domain, undefined)` behavior, unchanged here.
    expect(config.inspect(THINKING_SECTION).userValue).toEqual({});

    disposables.dispose();
  });

  it('treats null as clear — the wire encoding JSON transports use for undefined', async () => {
    const { config, disposables, store } = await createSectionsConfig();
    const setSpy = vi.spyOn(store, 'set');

    await config.replaceSections({
      [DEFAULT_MODEL_SECTION]: null,
      [PROVIDERS_SECTION]: { acme: { type: 'openai', apiKey: 'sk-acme-2' } },
    });

    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(config.get(DEFAULT_MODEL_SECTION)).toBeUndefined();
    expect(config.inspect(DEFAULT_MODEL_SECTION).userValue).toBeUndefined();
    expect(config.get<Record<string, unknown>>(PROVIDERS_SECTION)).toEqual({
      acme: { type: 'openai', apiKey: 'sk-acme-2' },
    });

    // `replace(domain, null)` clears too, so JSON transports behave
    // identically to in-process `replace(domain, undefined)` callers.
    await config.replace(DEFAULT_MODEL_SECTION, 'acme/m1');
    await config.replace(DEFAULT_MODEL_SECTION, null);
    expect(config.inspect(DEFAULT_MODEL_SECTION).userValue).toBeUndefined();

    disposables.dispose();
  });

  it('fires change events only after all domains have taken effect', async () => {
    const { config, disposables } = await createSectionsConfig();
    const domains: string[] = [];
    let snapshotDuringFirstEvent:
      | { providers: unknown; models: unknown; defaultModel: unknown; thinking: unknown }
      | undefined;
    config.onDidSectionChange((e) => {
      domains.push(e.domain);
      snapshotDuringFirstEvent ??= {
        providers: config.get(PROVIDERS_SECTION),
        models: config.get(MODELS_SECTION),
        defaultModel: config.get(DEFAULT_MODEL_SECTION),
        thinking: config.get(THINKING_SECTION),
      };
    });

    await config.replaceSections({
      [PROVIDERS_SECTION]: { acme: { type: 'openai', apiKey: 'sk-acme-2' } },
      [MODELS_SECTION]: { 'acme/m2': { provider: 'acme', model: 'm2', maxContextSize: 2000 } },
      [DEFAULT_MODEL_SECTION]: undefined,
      [THINKING_SECTION]: undefined,
    });

    // Every event — including the very first one — already observes the fully
    // applied state; no listener can catch the write half-applied. (The
    // cleared thinking section still resolves to its schema default `{}`.)
    expect(snapshotDuringFirstEvent).toEqual({
      providers: { acme: { type: 'openai', apiKey: 'sk-acme-2' } },
      models: { 'acme/m2': { provider: 'acme', model: 'm2', maxContextSize: 2000 } },
      defaultModel: undefined,
      thinking: {},
    });
    expect([...domains].sort()).toEqual(
      [PROVIDERS_SECTION, MODELS_SECTION, DEFAULT_MODEL_SECTION, THINKING_SECTION].sort(),
    );

    disposables.dispose();
  });

  it('supports the memory target without touching the persisted user layer', async () => {
    const { config, disposables, store } = await createSectionsConfig();
    const setSpy = vi.spyOn(store, 'set');

    await config.replaceSections(
      { [THINKING_SECTION]: { enabled: false, effort: 'low' } },
      ConfigTarget.Memory,
    );

    expect(setSpy).not.toHaveBeenCalled();
    expect(config.get<ThinkingConfig>(THINKING_SECTION)).toEqual({
      enabled: false,
      effort: 'low',
    });
    expect(config.inspect<ThinkingConfig>(THINKING_SECTION).userValue).toEqual({ enabled: true });

    disposables.dispose();
  });

  it('leaves the user layer untouched when a later domain fails validation', async () => {
    const { config, disposables, store } = await createSectionsConfig();
    const setSpy = vi.spyOn(store, 'set');

    // Providers is applied first in key order and validates fine; thinking
    // then fails schema validation (`enabled` must be a boolean). The batch
    // must reject with NO observable partial application.
    await expect(
      config.replaceSections({
        [PROVIDERS_SECTION]: { acme: { type: 'openai', apiKey: 'sk-acme-2' } },
        [THINKING_SECTION]: { enabled: 'yes' },
      }),
    ).rejects.toThrow();

    expect(setSpy).not.toHaveBeenCalled();
    expect(config.inspect<Record<string, unknown>>(PROVIDERS_SECTION).userValue).toEqual({
      acme: { type: 'openai', apiKey: 'sk-acme' },
    });
    expect(config.get<Record<string, unknown>>(PROVIDERS_SECTION)).toEqual({
      acme: { type: 'openai', apiKey: 'sk-acme' },
    });
    expect(config.inspect<ThinkingConfig>(THINKING_SECTION).userValue).toEqual({ enabled: true });

    disposables.dispose();
  });
});
