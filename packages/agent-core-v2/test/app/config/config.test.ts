import type { ModelCapability } from '#/llm-adapter/contract/capability';
import type { ToolCall } from '#human/message';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IAgentProfileService, type ResolvedAgentProfile } from '#/agent/profile/profile';
import { normalizeAgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import {
  Error2,
  ErrorCodes,
  isError2,
  resetUnexpectedErrorHandler,
  setUnexpectedErrorHandler,
  toErrorPayload,
} from '#/errors';
import { WIRE_PROTOCOL_VERSION } from '#/wire/migration/migration';
import { appService, createTestAgent, type TestAgentContext } from '../../harness';
import { DEFAULT_TEST_SYSTEM_PROMPT } from '../../harness/snapshots';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { createDecorator, type ProvideHandle } from '#/_base/di/instantiation';
import { DisposableStore } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { TestInstantiationService } from '#/_base/di/test';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import {
  type ConfigSchema,
  ConfigTarget,
  IConfigRegistry,
  IConfigService,
  type RegisterSectionOptions,
} from '#/app/config/config';
import { ConfigRegistry, ConfigService } from '#/app/config/configService';
import { ConfigSectionContribution } from '#/app/config/configSectionContributions';
import { CRON_SECTION, DEFAULT_CRON_CONFIG, type CronConfig } from '#/features/cron/configSection';
import '#/features/skill/catalog/configSection';
import { BUILTIN_PRODUCT_SKILLS_SECTION } from '#/features/skill/catalog/configSection';
import {
  EXTRA_SKILL_DIRS_SECTION,
  MERGE_ALL_AVAILABLE_SKILLS_SECTION,
} from '#/features/skill/catalog/configSection';
import '#/agent/permissionMode/configSection';
import { DEFAULT_PERMISSION_MODE_SECTION } from '#/agent/permissionMode/configSection';
import '#/agent/media/configSection';
import { IMAGE_SECTION, type ImageConfig } from '#/agent/media/configSection';
import { READ_SECTION } from '#/agent/tools/os/read/configSection';
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
  THINKING_SECTION,
} from '#/app/kosongConfig/configSection';
import '#/app/kosongConfig/envOverlay';
import { IOAuthService } from '#/app/auth/auth';
import { IAuthLegacyService } from '#/app/authLegacy/authLegacy';
import { AuthLegacyService } from '#/app/authLegacy/authLegacyService';
import { type ThinkingConfig } from '#/llm-adapter/model/thinking';
import {
  BASH_TASK_TIMEOUT_S_ENV,
  KEEP_ALIVE_ON_EXIT_ENV,
  MAX_RUNNING_TASKS_ENV,
  PRINT_BACKGROUND_MODE_ENV,
  PRINT_MAX_TURNS_ENV,
  PRINT_WAIT_CEILING_S_ENV,
  resolveAgentTaskConfig,
  resolvePrintBackgroundMode,
  type AgentTaskConfig,
} from '#/agent/task/configSection';
import { applyPrintModeConfigDefaults } from '#/agent/task/printDefaults';
import '#/session/subagent/configSection';
import {
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  resolveSubagentBinding,
  resolveSubagentModelPool,
  resolveSubagentTimeoutMs,
  SECONDARY_MODEL_FORCE_REMOVED_MESSAGE,
  SECONDARY_MODEL_SECTION,
  secondaryModelRemovedKeysMessage,
  SUBAGENT_SECTION,
  SUBAGENT_TIMEOUT_ENV,
  type SecondaryModelConfig,
  type SubagentConfig,
  wrapSubagentModelError,
} from '#/session/subagent/configSection';
import {
  DEFAULT_SWARM_TIMEOUT_MS,
  resolveSwarmTimeoutMs,
  SWARM_SECTION,
  SWARM_TIMEOUT_ENV,
  type SwarmConfig,
} from '#/features/swarm/configSection';
import {
  SERVICES_SECTION,
  WEB_FETCH_API_KEY_ENV,
  WEB_FETCH_BASE_URL_ENV,
  WEB_SEARCH_API_KEY_ENV,
  WEB_SEARCH_BASE_URL_ENV,
  type ServicesConfig,
} from '#/app/auth/configSection';
import '#/app/mcpConfig/configSection';
import {
  MCP_SECTION,
  MCP_STARTUP_TIMEOUT_ENV,
  MCP_TOOL_TIMEOUT_ENV,
  McpSectionSchema,
  type McpSection,
} from '#/app/mcpConfig/configSection';
import { ILogService } from '#/_base/log/log';
import { IHostClock } from '#/os/interface/hostClock';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { TomlAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { stubBootstrap } from '../bootstrap/stubs';
import { stubLog } from '../../_base/log/stubs';

const TEST_OS_ENV = {
  osKind: 'Linux',
  osArch: 'x86_64',
  osVersion: 'test',
  shellName: 'bash',
  shellPath: '/bin/bash',
} as const;

const pinnedHostClock: IHostClock = {
  _serviceBrand: undefined,
  now: () => new Date(),
  timeZone: () => 'Asia/Shanghai',
};

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
      [wire] config.update            { "agentId": "main", "profileName": "test-profile", "systemPrompt": "Profile system prompt.", "environmentDisclosure": { "cwd": "<cwd>" }, "agentsMdPaths": [], "disallowedTools": [], "time": "<time>" }
      [emit] agent.status.updated     { "time": "<time>", "agentId": "main", "model": "mock-model", "maxContextTokens": 1000000 }
      [wire] tools.set_active_tools   { "agentId": "main", "names": [ "Read" ], "time": "<time>" }
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
    await ctx.dispose();
    ctx = createTestAgent({ autoConfigure: false }, appService(IHostClock, pinnedHostClock));
    await ctx.restorePersisted();
    ctx.configure();
    profile = ctx.get(IAgentProfileService);
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
      [emit] prompt.submitted                { "time": "<time>", "agentId": "main", "promptId": "<msg-1>", "userMessageId": "<msg-1>", "status": "running", "content": [ { "type": "text", "text": "Look up before config changes" } ], "createdAt": "<time>" }
      [wire] turn.prompt                     { "agentId": "main", "input": [ { "type": "text", "text": "Look up before config changes" } ], "origin": { "kind": "user" }, "promptId": "<msg-1>", "turnId": 0, "time": "<time>" }
      [emit] turn.prompt                     { "time": "<time>", "agentId": "main", "input": [ { "type": "text", "text": "Look up before config changes" } ], "origin": { "kind": "user" }, "promptId": "<msg-1>", "turnId": 0 }
      [emit] turn.started                    { "time": "<time>", "agentId": "main", "turnId": 0, "promptId": "<msg-1>", "origin": { "kind": "user" }, "prompt": "Look up before config changes" }
      [emit] context.spliced                 { "time": "<time>", "agentId": "main", "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Look up before config changes" } ], "id": "<msg-1>", "origin": { "kind": "user" } } ] }
      [emit] prompt.started                  { "time": "<time>", "agentId": "main", "promptId": "<msg-1>" }
      [wire] context.append_message          { "agentId": "main", "message": { "role": "user", "content": [ { "type": "text", "text": "Look up before config changes" } ], "toolCalls": [], "id": "<msg-1>", "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] agent.message.appended          { "message": { "message": { "role": "user", "content": [ { "type": "text", "text": "Look up before config changes" } ] }, "meta": { "source": "input", "promptId": "<msg-1>", "origin": { "kind": "user" }, "tracked": true, "createdAt": "<time>", "userMessageId": "<msg-1>" } }, "time": "<time>", "kind": "event" }
      [wire] agent.turn.started              { "turnId": 0, "queueItemId": "<msg-1>", "time": "<time>", "kind": "event" }
      [wire] plugin.session_start            { "agentId": "main", "content": null, "time": "<time>" }
      [emit] turn.step.started               { "time": "<time>", "agentId": "main", "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [wire] context.append_loop_event       { "agentId": "main", "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
      [wire] tool_select.initialized         { "agentId": "main", "tools": [ { "name": "Agent", "description": "Launch a subagent to handle a task. The subagent runs as a same-process loop instance with its own context and wire file.\\n\\nDo not launch a subagent unless the user explicitly asks for one. Each subagent starts cold and re-derives context you already have, which costs the user time and tokens. Asking means: the user asks for a subagent, delegation, or parallel agents, or requests one of the agent types below by name (for example \\"use an explore agent\\"). Explicit instructions in AGENTS.md or a skill, and a multi-agent mode the user turned on (such as swarm or tower mode), also count. Nothing else does: a large or multi-part task, or a request for depth, thoroughness, research, or investigation, is not a request to launch — do that work yourself with your own tools. The agent type descriptions below only help you choose a type once launching is authorized; they never authorize it. Resuming a subagent to continue already-authorized work needs no new request.\\n\\nWriting the prompt:\\n- The subagent starts with zero context — it has not seen this conversation. Brief it like a colleague who just walked into the room: state the goal, list what you already know, hand over the specifics.\\n- Lookups (read this file, run that test): put the exact path or command in the prompt. The subagent should not have to search for things you already know.\\n- Investigations (figure out X, find why Y): give the question, not prescribed steps — fixed steps become dead weight when the premise is wrong.\\n- Do not delegate understanding. If the task hinges on a file path or line number, find it yourself first and write it into the prompt.\\n\\nUsage notes:\\n- When the task continues earlier work a subagent already did, prefer resuming that agent (pass its \`resume\` id) over spawning a fresh instance — the resumed agent keeps its prior context.\\n- A subagent's result is only visible to you, not to the user. When the user needs to see what a subagent produced, summarize the relevant parts yourself in your own reply.\\n\\nOnce a subagent is running, leave that scope to it: do not redo its searches or reads in parallel, and do not abandon it midway and finish the job manually. Both undo the context savings the delegation was meant to buy.\\n\\n\\nBackground agent execution is disabled for this agent. Do not set \`run_in_background=true\` — any call that sets it is rejected before the subagent launches. Run every subagent in the foreground and wait for its result.\\n\\nAvailable agent types (pass via subagent_type):\\n- plan: Read-only implementation planning and architecture design. Use this agent when the parent agent needs a step-by-step implementation plan, key file identification, and architectural trade-off analysis before code changes are made.\\n  Tools: Read, Glob, Grep, FetchURL\\n- coder: General software engineering agent — the only subagent type with file-editing tools; use it for any delegated task that must modify code. Use this agent for non-trivial software engineering work that may require reading files, editing code, running commands, and returning a compact but technically complete summary to the parent agent.\\n  Tools: Bash, CronCreate, CronDelete, CronList, Edit, Glob, Grep, Read, Skill, TaskList, TaskOutput, TaskStop, TodoList, WaitFor, FetchURL, Write, mcp__*\\n- explore: Fast codebase exploration with prompt-enforced read-only behavior. Fast agent specialized for exploring codebases: it finds files by patterns (e.g. \\"src/**/*.yaml\\"), searches code for keywords (e.g. \\"database connection\\"), and answers questions about the codebase (e.g. \\"how does the auth module work?\\"). When calling this agent, specify the desired thoroughness level: \\"quick\\" for basic searches, \\"medium\\" for moderate exploration, or \\"thorough\\" for comprehensive analysis across multiple locations and naming conventions.\\n  Tools: Bash, Read, Glob, Grep, FetchURL", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "prompt": { "type": "string", "description": "Full task prompt for the subagent" }, "description": { "type": "string", "description": "Short task description (3-5 words) for UI display" }, "subagent_type": { "description": "One of the available agent types (see \\"Available agent types\\" in this tool description). Defaults to \\"coder\\" when omitted.", "type": "string" }, "resume": { "description": "Optional agent ID to resume instead of creating a new instance. When set, do not also pass subagent_type — the resumed agent keeps its own type, and supplying both is rejected.", "type": "string" }, "run_in_background": { "description": "If true, return immediately without waiting for completion. Prefer false unless the task can run independently and there is a clear benefit to not waiting.", "type": "boolean" } }, "required": [ "prompt", "description" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "AgentSwarm", "description": "Launch multiple subagents from one prompt template, existing agent resumes, or both.\\n\\nAgentSwarm runs only while swarm mode is on, and only the user can turn swarm mode on. When swarm mode is off, do not call AgentSwarm: the call is rejected and no subagents start.\\n\\nUse AgentSwarm when many subagents should run the same kind of task over different inputs. The placeholder is exactly \`{{item}}\`. For example, with \`prompt_template\` set to \`Review {{item}} for likely regressions.\` and \`items\` set to \`[\\"src/a.ts\\", \\"src/b.ts\\"]\`, AgentSwarm launches two new subagents with those two concrete prompts. For a few differently-shaped tasks, make separate \`Agent\` calls in one message instead.\\n\\nUse \`resume_agent_ids\` to continue subagents that already exist from earlier work, such as ones that failed or timed out: map each agent id to the prompt for that resumed subagent (usually \`continue\` if no extra information is needed). You may combine \`resume_agent_ids\` with \`items\` in the same call to resume existing subagents and launch new ones. Do not duplicate resumed work in \`items\`.\\n\\nEach of these is enforced — a violation is rejected before any subagent starts: provide at least 2 \`items\` unless you pass \`resume_agent_ids\`; whenever \`items\` are present, \`prompt_template\` is required and must contain \`{{item}}\`; and the filled-in prompts must be distinct (two items that expand to the same prompt are rejected).\\n\\nUse enough subagents to keep the work focused and parallel. AgentSwarm supports up to 128 subagents, and launches are queued automatically, so it is safe to split large tasks into many clear, independent items.\\n\\nIf \`AgentSwarm\` is called, that call must be the only tool call in the response.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "description": { "type": "string", "minLength": 1, "description": "Short description for the whole swarm." }, "subagent_type": { "description": "Subagent type used for every new subagent spawned from items; defaults to coder when omitted. Resumed subagents always keep their original type, so passing subagent_type together with resume_agent_ids is allowed — it only affects the item-based spawns.", "type": "string", "minLength": 1 }, "prompt_template": { "description": "Prompt template for each subagent. The {{item}} placeholder is replaced with each item value.", "type": "string", "minLength": 1 }, "items": { "description": "Values used to fill {{item}}. Each item launches one new subagent.", "maxItems": 128, "type": "array", "items": { "type": "string", "minLength": 1 } }, "resume_agent_ids": { "description": "Map of existing subagent agent_id to the prompt used to resume that subagent. These resumed subagents are launched before new item-based subagents.", "type": "object", "propertyNames": { "type": "string", "minLength": 1 }, "additionalProperties": { "type": "string", "minLength": 1 } } }, "required": [ "description" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "AskUserQuestion", "description": "Use this tool when you need to ask the user questions with structured options during execution. This allows you to:\\n1. Collect user preferences or requirements before proceeding\\n2. Resolve ambiguous or underspecified instructions\\n3. Let the user decide between implementation approaches as you work\\n4. Present concrete options when multiple valid directions exist\\n\\n**When NOT to use:**\\n- When you can infer the answer from context — be decisive and proceed\\n- Trivial decisions that don't materially affect the outcome\\n\\nOverusing this tool interrupts the user's flow. Only use it when the user's input genuinely changes your next action.\\n\\n**Usage notes:**\\n- Users always have an \\"Other\\" option for custom input — don't create one yourself\\n- Use multi_select to allow multiple answers to be selected for a question\\n- Keep option labels concise (1-5 words), use descriptions for trade-offs and details\\n- Each question should have 2-4 meaningful, distinct options\\n- Question texts must be unique across the call, and option labels must be unique within each question\\n- You can ask 1-4 questions at a time; group related questions to minimize interruptions\\n- If you recommend a specific option, list it first and append \\"(Recommended)\\" to its label\\n- The result is JSON with an \`answers\` object keyed by question text; each value is the chosen option's label (comma-separated labels for multi_select, or the user's own words if they picked \\"Other\\"); if \`answers\` is empty and a \`note\` says the user dismissed it, they chose not to answer — do not treat this as selecting the recommended option; decide based on context and do not re-ask the same question\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "questions": { "minItems": 1, "maxItems": 4, "type": "array", "items": { "type": "object", "properties": { "question": { "type": "string", "minLength": 1, "description": "A specific, actionable question. End with '?'." }, "header": { "default": "", "description": "Short category tag (max 12 chars, e.g. 'Auth', 'Style').", "type": "string" }, "options": { "minItems": 2, "maxItems": 4, "type": "array", "items": { "type": "object", "properties": { "label": { "type": "string", "minLength": 1, "description": "Concise display text (1-5 words). If recommended, append '(Recommended)'." }, "description": { "default": "", "description": "Brief explanation of trade-offs or implications.", "type": "string" } }, "required": [ "label" ], "additionalProperties": false }, "description": "2-4 meaningful, distinct options. Do NOT include an 'Other' option — the system adds one automatically." }, "multi_select": { "default": false, "description": "Whether the user can select multiple options.", "type": "boolean" } }, "required": [ "question", "options" ], "additionalProperties": false }, "description": "The questions to ask the user (1-4 questions)." } }, "required": [ "questions" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Bash", "description": "Execute a \`bash\` command. Use this for shell semantics — pipes, env, processes, git, package managers, build/test runners, anything genuinely interactive or multi-step.\\n\\n**Translate these to a dedicated tool instead:**\\n- \`cat\` / \`head\` / \`tail\` (known path) → \`Read\`\\n- \`sed\` / \`awk\` (in-place edit) → \`Edit\`\\n- \`echo > file\` / \`cat <<EOF\` → \`Write\`\\n- \`find\` / recursive \`ls\` to locate files by name pattern → \`Glob\` (plain \`ls <known-directory>\` is fine for listing a directory)\\n- \`grep\` / \`rg\` (search file contents) → \`Grep\`\\n- \`echo\` / \`printf\` (talk to the user) → just output text directly\\n\\nThe dedicated tools render in the per-tool permission UI and keep raw stdout out of the conversation; that is why they are worth reaching for whenever one fits.\\n\\n**Output:**\\nThe stdout and stderr will be combined and returned as a string. The output may be truncated if it is too long. If the command exits non-zero, the output ends with a \`Command failed with exit code: N\` line; a command killed by its timeout or interrupted by the user ends with its own message instead.\\n\\nBackground execution is disabled for this agent. Do not set \`run_in_background=true\`.\\n\\n**Guidelines for safety and security:**\\n- Each shell tool call will be executed in a fresh shell environment. The shell variables, current working directory changes, and the shell history is not preserved between calls. To run a command in a particular directory, pass the \`cwd\` argument (or use absolute paths) rather than relying on a \`cd\` from an earlier call.\\n- The tool call will return after the command is finished. You shall not use this tool to execute an interactive command or a command that may run forever. For possibly long-running commands, set the \`timeout\` argument in seconds. The default is 60s; foreground commands allow up to 300s; a foreground command that hits its timeout is killed.\\n- Avoid using \`..\` to access files or directories outside of the working directory.\\n- Avoid modifying files outside of the working directory unless explicitly instructed to do so.\\n- Never run commands that require superuser privileges unless explicitly instructed to do so.\\n- Run git-mutating commands such as \`git commit\`, \`git push\`, \`git reset\`, and \`git rebase\` only when the user asks for them.\\n\\n**Guidelines for efficiency:**\\n- Use \`&&\` to chain commands that genuinely depend on each other, e.g. \`npm install && npm test\`. Independent read-only commands (separate \`git show\`, \`ls\`, or status checks) should be issued as separate parallel Bash calls in one response, not chained into a single call — chaining serializes their execution and mixes their output. Do not stitch outputs together with \`echo\` separators.\\n- Use \`;\` to run commands sequentially regardless of success/failure\\n- Use \`||\` for conditional execution (run second command only if first fails)\\n- Use pipe operations (\`|\`) and redirections (\`>\`, \`>>\`) to chain input and output between commands\\n- Always quote file paths containing spaces with double quotes (e.g., cd \\"/path with spaces/\\")\\n- Compose multi-step logic in a single call with \`if\` / \`case\` / \`for\` / \`while\` control flows.\\n- Do not set \`run_in_background=true\`; background task management tools are not available.\\n\\n**Commands available:**\\nThe following common command categories are usually available. Availability still depends on the host, so when in doubt run \`which <command>\` first to confirm a command exists before relying on it.\\n- Navigation and inspection: \`ls\`, \`pwd\`, \`cd\`, \`stat\`, \`file\`, \`du\`, \`df\`, \`tree\`\\n- File and directory management: \`cp\`, \`mv\`, \`rm\`, \`mkdir\`, \`touch\`, \`ln\`, \`chmod\`, \`chown\`\\n- Text and data processing: \`wc\`, \`sort\`, \`uniq\`, \`cut\`, \`tr\`, \`diff\`, \`xargs\`\\n- Archives and compression: \`tar\`, \`gzip\`, \`gunzip\`, \`zip\`, \`unzip\`\\n- Networking and transfer: \`curl\`, \`wget\`, \`ping\`, \`ssh\`, \`scp\`\\n- Version control: \`git\`; for GitHub-hosted work (PRs, issues, CI runs, API queries) prefer the \`gh\` CLI when installed — it carries the user's GitHub auth and can return structured JSON\\n- Process and system: \`ps\`, \`kill\`, \`top\`, \`env\`, \`date\`, \`uname\`, \`whoami\`\\n- Language and package toolchains: \`node\`, \`npm\`, \`pnpm\`, \`yarn\`, \`python\`, \`pip\` (use whichever the project actually relies on)\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "command": { "type": "string", "minLength": 1, "description": "The command to execute." }, "cwd": { "description": "The working directory in which to run the command. When omitted, the command runs in the session's working directory.", "type": "string" }, "timeout": { "default": 60, "description": "Optional timeout in seconds for the command to execute. Foreground default 60s, max 300s. Background default 600s, max 86400s. Ignored for background commands when disable_timeout=true.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 }, "description": { "description": "A short description for the background task. Required when run_in_background is true.", "type": "string" }, "run_in_background": { "description": "Whether to run the command as a background task.", "type": "boolean" }, "disable_timeout": { "description": "If true, do not apply a timeout to the command. Only applies when run_in_background is true.", "type": "boolean" } }, "required": [ "command" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "CreateGoal", "description": "Create a durable, structured goal that the runtime will pursue across multiple turns.\\n\\nCall \`CreateGoal\` only when:\\n\\n- the user explicitly asks you to start a goal or work autonomously toward an outcome, or\\n- a host goal-intake prompt asks you to create one.\\n\\nDo NOT create a goal for greetings, ordinary questions, or vague requests that lack a\\nverifiable completion condition. A goal needs a checkable end state.\\n\\nWhen the request is vague, ask the user for the missing completion criterion before creating\\nthe goal. If the user clearly insists after you warn them that the wording is vague or risky,\\nrespect that and create the goal.\\n\\nInclude a \`completionCriterion\` when the user provides one, or when it can be stated without\\ninventing new requirements. Keep \`objective\` concise; reference long task descriptions by file\\npath rather than pasting them.\\n\\nCreating a goal fails if one already exists, so use \`replace: true\` only when the user explicitly\\nwants to abandon the current goal and start a new one.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "objective": { "type": "string", "minLength": 1, "description": "The objective to pursue. Must have a verifiable end state." }, "completionCriterion": { "description": "How to verify the goal is complete. Include when the user provides one.", "type": "string" }, "replace": { "description": "Replace an existing active, paused, or blocked goal instead of failing.", "type": "boolean" } }, "required": [ "objective" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "CronCreate", "description": "Schedule a prompt to be enqueued at a future time. Use for both recurring schedules and one-shot reminders.\\n\\nUses standard 5-field cron in the user's local timezone: minute hour day-of-month month day-of-week. \`0 9 * * *\` means 9am local — no timezone conversion needed.\\n\\n## One-shot tasks (recurring: false)\\n\\nFor \\"remind me at X\\" or \\"at <time>, do Y\\" requests — fire once then auto-delete.\\nPin minute/hour/day-of-month/month to specific values:\\n  \\"remind me at 2:30pm today to check the deploy\\" → cron: \\"30 14 <today_dom> <today_month> *\\", recurring: false\\n  \\"tomorrow morning, run the smoke test\\" → cron: \\"57 8 <tomorrow_dom> <tomorrow_month> *\\", recurring: false\\n\\nOne-shots are best for near-term reminders. A task only fires while its session is still alive (see Session lifetime below), so favor near times — within hours or a few days — rather than scheduling weeks or months ahead.\\n\\n## Recurring jobs (recurring: true, the default)\\n\\nFor \\"every N minutes\\" / \\"every hour\\" / \\"weekdays at 9am\\" requests:\\n  \\"*/5 * * * *\\" (every 5 min), \\"0 * * * *\\" (hourly), \\"0 9 * * 1-5\\" (weekdays at 9am local)\\n\\n## Avoid the :00 and :30 minute marks when the task allows it\\n\\nEvery user who asks for \\"9am\\" gets \`0 9\`, and every user who asks for \\"hourly\\" gets \`0 *\` — which means requests from across the planet land on the API at the same instant. When the user's request is approximate, pick a minute that is NOT 0 or 30:\\n  \\"every morning around 9\\" → \\"57 8 * * *\\" or \\"3 9 * * *\\" (not \\"0 9 * * *\\")\\n  \\"hourly\\" → \\"7 * * * *\\" (not \\"0 * * * *\\")\\n  \\"in an hour or so, remind me to...\\" → pick whatever minute you land on, don't round\\n\\nOnly use minute 0 or 30 when the user names that exact time and clearly means it (\\"at 9:00 sharp\\", \\"at half past\\", coordinating with a meeting). When in doubt, nudge a few minutes early or late — the user will not notice, and the fleet will.\\n\\n## Coalesce semantics\\n\\nFires are delivered only while the session is idle: a fire that comes due during an active turn is held and delivered at the next idle moment, never injected mid-turn.\\n\\nIf the scheduler slept past multiple ideal fire times (laptop closed, long-running turn, etc.), only **one** fire is delivered when it wakes up. The origin carries \`coalescedCount\` showing how many ideal fires were collapsed into this single delivery. You should treat \`coalescedCount > 1\` as \\"I missed some checks; only the latest state matters\\" rather than running the prompt that many times.\\n\\n## Cron-fire envelope\\n\\nWhen a cron task fires, the prompt you scheduled is re-injected wrapped in an XML envelope that exposes the fire context:\\n\\n\`\`\`\\n<cron-fire jobId=\\"...\\" cron=\\"...\\" recurring=\\"true|false\\" coalescedCount=\\"N\\" stale=\\"true|false\\">\\n<prompt>\\nyour original prompt text, verbatim\\n</prompt>\\n</cron-fire>\\n\`\`\`\\n\\nThe envelope is parseable. Use \`coalescedCount > 1\` to know multiple ideal fires were collapsed into a single delivery (treat as \\"only the latest state matters\\"), and \`stale=\\"true\\"\` as a cue that the task is past its 7-day threshold.\\n\\n## 7-day stale behavior\\n\\nRecurring tasks that have been alive for more than 7 days fire one\\nfinal time with \`stale: true\` on the envelope, and the system then\\nauto-deletes the task. The flag is the model's notice that this is\\nthe last delivery. If the schedule is still wanted, call \`CronCreate\`\\nagain with the same \`cron\` and \`prompt\` — that resets \`createdAt\` and\\nstarts a fresh 7-day window. One-shot tasks are never marked stale.\\n\\n## Jitter behavior\\n\\nAnti-herd jitter is applied deterministically per task id:\\n  - Recurring: ideal fire time is shifted **forward** by an offset ≤ min(10% of the cron period, 15 minutes). A \`*/5 * * * *\` task can drift up to 30s; a \`0 9 * * *\` task can drift up to 15 minutes.\\n  - One-shot: only when the ideal fire lands on \`:00\` or \`:30\` of the hour, the fire is pulled **earlier** by ≤ 90 seconds. Other minutes pass through unchanged.\\n\\n## One-shot vs recurring — when to pick which\\n\\nUse \`recurring: false\` for \\"remind me at X\\" style requests, single deadlines, \\"in N minutes do Y\\", and any task that should not repeat. Use \`recurring: true\` for periodic polling (CI status, build watchers, scheduled reports), workday rituals, and anything the user explicitly described as recurring.\\n\\n## Session lifetime\\n\\nCron tasks live in the current session. When you exit, they\\nare persisted under the session homedir; resuming the same session\\nreloads them and the scheduler resumes from each task's \`createdAt\`. Fire times that fell during the offline window are\\ncollapsed into a single delivery via \`coalescedCount\` (and recurring\\ntasks past their 7-day window arrive with \`stale: true\` as their final\\ndelivery).\\n\\nTasks do **not** carry over into a brand-new session — they are scoped\\nto the resumed session id, not to the working directory.\\n\\n## Limits\\n\\nA session holds at most 50 live cron tasks; creating one beyond that is rejected. (The \`prompt\` body is also capped — see its parameter description.) Expressions that never fire within the next 5 years (e.g. \`0 0 31 2 *\`, an impossible date) are rejected at create time.\\n\\n## Returned fields\\n\\n\`id\` (ULID), \`cron\` (the normalized expression), \`humanSchedule\` (English summary), \`recurring\`,\\n\`nextFireAt\` (local ISO timestamp with numeric offset, or null). \`id\` is needed by \`CronDelete\`.\\n\\n## Tell the user how to cancel or modify\\n\\nAfter successfully creating a task, proactively tell the user how they can cancel or modify it later. Users have no direct \`/cron\` command or self-service UI to manage reminders themselves; they must ask the model to make changes (e.g. \\"cancel my 9am reminder\\" or \\"change my daily check to 10am\\"). Include the task \`id\` in your message so the user can reference it.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "cron": { "type": "string", "description": "5-field cron expression in local time: \\"M H DoM Mon DoW\\" (e.g. \\"*/5 * * * *\\" = every 5 minutes; \\"30 14 28 2 *\\" = Feb 28 at 2:30pm local — a pinned date like this repeats yearly unless you also pass recurring: false)." }, "prompt": { "type": "string", "minLength": 1, "maxLength": 8192, "description": "The prompt to enqueue at each fire time. Limited to 8 KiB (UTF-8)." }, "recurring": { "default": true, "description": "true (default) = fire on every cron match until deleted or auto-expired after 7 days. false = fire once at the next match, then auto-delete. Use false for \\"remind me at X\\" one-shot requests with pinned minute/hour/dom/month.", "type": "boolean" } }, "required": [ "cron", "prompt" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "CronDelete", "description": "Cancel a scheduled cron job by id.\\n\\nUse this tool to remove a cron task previously scheduled with\\n\`CronCreate\`. The \`id\` is the ULID value returned by \`CronCreate\`, or\\nshown in the \`id:\` column of \`CronList\` — quote it verbatim, no\\nprefix.\\n\\nBehaviour by task kind:\\n\\n- **Recurring task** (\`recurring: true\`): stops all future fires\\n  immediately. The scheduler picks up the deletion on its next tick.\\n- **One-shot task** (\`recurring: false\`): cancels the pending fire if\\n  it has not happened yet. One-shots that have already fired\\n  auto-delete themselves, so calling \`CronDelete\` on a fired one-shot\\n  returns \\"no cron job with id ...\\".\\n\\nNot-found is reported as an error (not a silent no-op) so you can\\ncorrect yourself — typically by calling \`CronList\` to see which ids\\nare actually live, rather than re-trying with the same stale id.\\n\\nRefresh pattern (use when you want a stale recurring schedule to\\ncontinue):\\n\\nStale recurring tasks are auto-deleted by the system after their final\\nfire — there is nothing for \`CronDelete\` to remove at that point. To\\nkeep the schedule running, just call \`CronCreate\` with the same \`cron\`\\nand \`prompt\`. Use \`CronList\`'s \`prompt\` field to recall the original\\ntext after a context compaction.\\n\\n\`CronDelete\` remains the right call when you want to cancel a task\\nthat is still live (recurring not yet stale, or a one-shot still\\npending).\\n\\nGuidelines:\\n\\n- Users have no direct \`/cron\` command or self-service UI to delete\\n  tasks themselves; they must ask the model to cancel a reminder.\\n  When deleting on behalf of a user, confirm the action and report\\n  the result plainly.\\n- Cron deletion is irreversible — there is no undo. If you delete the\\n  wrong task, you must re-create it with \`CronCreate\`.\\n- If the model is unsure which id is current (e.g. after a context\\n  compaction), call \`CronList\` first rather than guessing.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "id": { "type": "string", "description": "The cron job id (ULID) returned by CronCreate / CronList." } }, "required": [ "id" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "CronList", "description": "List all cron jobs currently scheduled in this session.\\n\\nUse this tool to see every pending cron task — both recurring jobs and\\none-shot reminders — that you (or the user) have scheduled with\\n\`CronCreate\`. The output is the entry point for inspecting scheduled\\nwork: it returns a stable id, the original cron expression, a human\\nrendering, the next post-jitter fire time, the recurring flag, the\\ntask's age in days, and a stale indicator.\\n\\nEach record carries:\\n\\n- \`id\` — the task id (a ULID). Pass this to \`CronDelete\` to remove the\\n  task, or quote it in user-facing messages when asking for\\n  confirmation.\\n- \`cron\` — the verbatim 5-field cron expression as scheduled.\\n- \`humanSchedule\` — plain-English rendering (e.g. \`every 5 minutes\`).\\n- \`prompt\` — the scheduled prompt text, JSON-encoded so embedded\\n  newlines stay on one line. Truncated to 200 UTF-8 bytes with\\n  \`…(truncated)\` if longer. Use this to recall what a task is for\\n  after a context compaction, and as the source for the\\n  \`CronCreate\` refresh ritual.\\n- \`nextFireAt\` — local ISO timestamp with an explicit numeric offset\\n  for the next fire **after jitter has been applied**. The actual fire\\n  may land slightly before or after a round \`:00\` / \`:30\` minute mark\\n  due to herd-avoidance jitter; this is the value the scheduler will\\n  compare against, so it reflects what will really happen. \`null\` if\\n  the expression has no fire in the next 5 years (should not happen\\n  for tasks created through \`CronCreate\`, which validates).\\n- \`recurring\` — \`true\` for cadenced jobs, \`false\` for one-shots.\\n- \`ageDays\` — \`(now - createdAt) / day\`, two decimal places. Useful\\n  when deciding whether a long-running cron is still relevant.\\n- \`stale\` — \`true\` when a recurring task is older than 7 days. The\\n  system **auto-deletes the task after this fire** to bound session\\n  lifetime; the \`stale: true\` flag is the model's notice that this is\\n  the final delivery. To resume the same schedule, call \`CronCreate\`\\n  again with the original \`cron\` and \`prompt\` (the \`prompt\` row above\\n  carries it for exactly this purpose). One-shots are never marked\\n  stale — they fire at most once by construction.\\n\\nGuidelines:\\n\\n- This tool is read-only and never mutates state, so it is always\\n  safe to call (including in plan mode).\\n- Users cannot directly manage cron tasks themselves; if they want to\\n  cancel or modify a schedule, route the request through the model\\n  (i.e. call \`CronDelete\` or \`CronCreate\` on their behalf).\\n- The empty case returns \`cron_jobs: 0\\\\nNo cron jobs scheduled.\`. Cron\\n  tasks survive a resume of the same session but do not bleed into new\\n  sessions.\\n- After a context compaction, or whenever you are unsure which cron\\n  jobs are live, call this tool to re-enumerate them rather than\\n  guessing ids from earlier in the conversation.\\n- Records are separated by a line containing just \`---\`, in the\\n  insertion order they were scheduled.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": {}, "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Edit", "description": "Perform exact replacements in existing files.\\n\\n- Edit is mandatory for every incremental change, especially small edits. DO NOT use Write or Bash \`sed\`.\\n- Read the target file before every Edit. DO NOT call Edit from memory, stale context, or a guessed \`old_string\`.\\n- Take \`old_string\` and \`new_string\` from the Read output view.\\n- Drop the line-number prefix and tab; match only file content.\\n- \`old_string\` must be unique unless \`replace_all\` is set.\\n- If \`old_string\` is ambiguous, add surrounding context. Use \`replace_all\` only when every occurrence should change — for example, renaming a symbol throughout the file.\\n- Multiple Edit calls may run in one response only when they do not target the same file.\\n- DO NOT issue consecutive Edit calls on the same file. A previous Edit can invalidate a later Edit's \`old_string\`, causing \`old_string not found\`. Read the file again before the next Edit.\\n- A write lock serializes same-file edits in response order, but serialization does not make stale \`old_string\` valid.\\n- For pure CRLF files, Read shows LF; use LF in \`old_string\` and \`new_string\`, and Edit writes CRLF back.\\n- For mixed endings or lone carriage returns, Read shows carriage returns as \\\\r; include actual \\\\r escapes in those positions.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to the text file to edit. Relative paths resolve against the working directory; a path outside the working directory must be absolute." }, "old_string": { "type": "string", "minLength": 1, "description": "Exact content to replace from the Read output view, without the line-number prefix. Use LF for pure CRLF files; use actual \\\\r escapes where Read shows \\\\r." }, "new_string": { "type": "string", "description": "Replacement text in the same Read output view. LF is written back as CRLF only for pure CRLF files." }, "replace_all": { "description": "Set true only when every occurrence of old_string should be replaced.", "type": "boolean" } }, "required": [ "path", "old_string", "new_string" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "ExitPlanMode", "description": "Use this tool when you are in plan mode and have finished writing your plan to the plan file and are ready for user approval.\\n\\n## How This Tool Works\\n- You should have already written your plan to the plan file specified in the plan mode reminder.\\n- This tool does NOT take the plan content as a parameter - it reads the plan from the file you wrote.\\n- The user reviews the contents of your plan file before plan mode ends, in every permission mode, and can approve it, ask for revisions, or reject it.\\n\\n## When to Use\\nOnly use this tool for tasks that require planning implementation steps. For research tasks (searching files, reading code, understanding the codebase), do NOT use this tool.\\n\\n## What a good plan contains\\nWrite the plan for a reviewer: they should be able to judge it quickly, and an implementer should be able to carry it out without making further decisions. Keep it concise, usually in these sections:\\n- Context — why the change is needed and the outcome it should produce.\\n- Approach — the approach you recommend. When the user must choose between genuinely different approaches, describe each briefly and pass them as \`options\`.\\n- Key changes — grouped by behavior or subsystem, not file by file. Name a file only when that makes a change unambiguous; for a change repeated across many files, describe the pattern once and list a few representative paths. Point to existing functions or utilities to reuse, with their paths.\\n- Verification — how to check the result end to end: the tests or commands to run and the scenario to exercise.\\n- Assumptions — each decision you made without the user's input, and the default you chose.\\nAvoid vague filler like \\"improve performance\\" or \\"add tests\\"; say what changes and how you will know it works.\\n\\n## Multiple Approaches\\nIf your plan offers multiple alternative approaches, pass them via the \`options\` parameter so the user can choose which one to execute — see the \`options\` parameter for the format, count, and reserved labels. The user sees all options alongside the host's Reject and Revise controls.\\n\\n## Before Using\\n- If questions about preferences or trade-offs are still open, use AskUserQuestion first. In auto permission mode AskUserQuestion is unavailable: decide from context and list those decisions under Assumptions.\\n- Outside auto permission mode, if you have multiple approaches and haven't narrowed down yet, consider using AskUserQuestion first to let the user choose, then write a plan for the chosen approach only.\\n- Once your plan is finalized, use THIS tool to request approval.\\n- Do NOT use AskUserQuestion to ask \\"Is this plan OK?\\" or \\"Should I proceed?\\" - that is exactly what ExitPlanMode does.\\n- If rejected, revise based on feedback and call ExitPlanMode again.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "options": { "description": "When the plan contains multiple alternative approaches, list them here so the user can choose which one to execute. Provide up to 3 options; 2-3 distinct approaches work best when the plan offers a real choice. Passing a single option is allowed and is equivalent to a plain plan approval. Each option represents a distinct approach from the plan. Do not use \\"Reject\\", \\"Revise\\", \\"Approve\\", or \\"Reject and Exit\\" as labels.", "minItems": 1, "maxItems": 3, "type": "array", "items": { "type": "object", "properties": { "label": { "type": "string", "minLength": 1, "maxLength": 80, "description": "Short name for this option (1-8 words). Append \\"(Recommended)\\" if you recommend this option." }, "description": { "default": "", "description": "Brief summary of this approach and its trade-offs.", "type": "string" } }, "required": [ "label" ], "additionalProperties": false } } }, "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "FetchURL", "description": "Fetch content from a URL. The content is returned either as the main text extracted from the page, or as the full response body verbatim; a note at the top of the result states which of the two you received, so you can judge how complete it is. Use this when you need to read a specific web page.\\n\\nOnly fully-formed public \`http\`/\`https\` URLs are supported; other schemes and private or loopback addresses are not fetched. Very large pages may be truncated or refused. The fetch carries no login or session for the target site, so pages behind authentication (private repositories, internal dashboards) return a login page or an error instead of the real content — if the text you get back looks like a generic landing or sign-in page, treat that as the login wall, not the answer, and reach the content through a credentialed route (an authenticated CLI or MCP tool) instead.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "url": { "type": "string", "description": "The URL to fetch content from." } }, "required": [ "url" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "GetGoal", "description": "Read the current goal: its objective, completion criterion, status, and budgets (turns, tokens,\\ntime, and how much of each remains). When the goal has stopped, it also reports the terminal reason.\\n\\nUse \`GetGoal\` before deciding whether to continue working, report completion, report a blocker,\\nor respect a pause. It returns \`{ \\"goal\\": null }\` when there is no current goal.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": {}, "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Glob", "description": "Find files by glob pattern, sorted by modification time (most recent first).\\n\\nPowered by ripgrep. Respects \`.gitignore\`, \`.ignore\`, and \`.rgignore\` by default — set \`include_ignored\` to also match ignored files (e.g. build outputs, \`node_modules\`). Sensitive files (such as \`.env\`) are always filtered out. Matches are files only — directories themselves are never listed; to find a directory, glob for a file inside it (e.g. \`**/fixtures/**\`).\\n\\nGood patterns:\\n- \`*.ts\` — all files matching an extension, at any depth below the search root (a bare pattern without \`/\` matches recursively)\\n- \`src/*.ts\` — files directly inside \`src/\` (one level, not recursive)\\n- \`src/**/*.ts\` — recursive walk with a subdirectory anchor and extension\\n- \`**/*.py\` — recursive walk from the search root for an extension\\n- \`*.{ts,tsx}\` — brace expansion is supported\\n- \`{src,test}/**/*.ts\` — cartesian brace expansion is supported too\\n\\nResults default to 100 matching paths. Use \`offset\` (default 0) and \`head_limit\` (default 100) to page through results. When more matches are available, the result gives the next offset; keep the other search arguments unchanged. Set \`head_limit=0\` to remove the match-count limit. Pages still stay within the character retention limit, including notices: when it is reached, only complete paths are returned, with the next offset for continuation. Large pages are saved to a file with a path for Read.\\n\\nEach call searches the current filesystem again; pagination is not a snapshot, and file changes can shift results between pages. To collect a large list, use \`head_limit=0\`, read any saved output, and follow continuation offsets if the character limit is reached. Search timeouts, traversal errors, and output capture limits can still produce partial results; the result reports these limits, and pagination cannot recover paths that were never collected. Narrow the search and retry when it is incomplete.\\n\\nLarge-directory caveat — avoid recursing into dependency / build output even with an anchor, especially when \`include_ignored\` is set:\\n- \`node_modules/**/*.js\`, \`.venv/**/*.py\`, \`__pycache__/**\`, \`target/**\` can produce thousands of results and waste search time and context. Prefer specific subpaths like \`node_modules/react/src/**/*.js\` unless you need a complete listing.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "pattern": { "type": "string", "description": "Glob pattern to match files." }, "head_limit": { "description": "Maximum number of matching paths to return after offset. Defaults to 100. Pass 0 to remove the match-count limit. The character limit still applies: large pages are saved for Read, and a continuation offset is provided when more paths remain. Search time and output capture limits still apply.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "offset": { "description": "Number of matching paths to skip. Defaults to 0. Each call searches the current filesystem again; changes can shift results between pages.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "path": { "description": "Directory to search. Accepts an absolute path, or a path relative to the current working directory. Defaults to the current working directory.", "type": "string" }, "include_ignored": { "description": "Also match files excluded by ignore files such as \`.gitignore\`, \`.ignore\`, and \`.rgignore\` (for example \`node_modules\` or build outputs). Sensitive files (such as \`.env\`) remain filtered out for safety. VCS metadata directories (\`.git\` and similar) are always skipped, even when this is true. Defaults to false.", "type": "boolean" }, "include_dirs": { "description": "Deprecated and ignored. Results are always files-only — directories are never listed. Accepted only so older calls that still pass this flag are not rejected by parameter validation.", "type": "boolean" } }, "required": [ "pattern" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Grep", "description": "Search file contents using regular expressions (powered by ripgrep).\\n\\nUse Grep when the task is to find unknown content or unknown file locations. Do not use shell \`grep\` or \`rg\` directly; this tool applies workspace path policy, output limits, and sensitive-file filtering.\\nALWAYS use Grep tool instead of running \`grep\` or \`rg\` from a shell — direct shell calls bypass workspace policy, output limits, and sensitive-file filtering.\\nIf you already know a concrete file path and need to inspect its contents, use Read directly instead.\\n\\nWrite patterns in ripgrep regex syntax, which differs from POSIX \`grep\` syntax. For example, braces are special, so escape them as \`\\\\{\` to match a literal \`{\`.\\n\\nHidden files (dotfiles such as \`.gitlab-ci.yml\` or \`.eslintrc.json\`) are searched by default. To also search files excluded by \`.gitignore\` (such as \`node_modules\` or build outputs), set \`include_ignored\` to \`true\`. Sensitive files (such as \`.env\`) are always skipped for safety, even when \`include_ignored\` is \`true\`.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "pattern": { "type": "string", "description": "Regular expression to search for." }, "path": { "description": "File or directory to search. Accepts an absolute path, or a path relative to the current working directory. Omit to search the current working directory. Use Read instead when you already know a concrete file path and need its contents.", "type": "string" }, "glob": { "description": "Optional glob filter for which files to search, e.g. \`*.ts\`. Matched against each file's full absolute path, so a path-anchored pattern like \`src/**/*.ts\` silently matches nothing — use a basename pattern (\`*.ts\`), or anchor with \`**/\` (\`**/src/**/*.ts\`). To scope the search to a directory, use \`path\` instead.", "type": "string" }, "type": { "description": "Optional ripgrep file type filter, such as ts or py. Prefer this over \`glob\` when filtering by language or file kind: it is more efficient and less error-prone than an equivalent glob pattern.", "type": "string" }, "output_mode": { "description": "Shape of the result. \`content\` shows matching lines (honors \`-A\`, \`-B\`, \`-C\`, \`-n\`, and \`head_limit\`); \`files_with_matches\` shows only the paths of files that contain a match, most-recently-modified first (honors \`head_limit\`); \`count_matches\` shows per-file match counts as \`path:count\` lines, preceded by an aggregate total line. Defaults to \`files_with_matches\`.", "type": "string", "enum": [ "content", "files_with_matches", "count_matches" ] }, "-i": { "description": "Perform a case-insensitive search. Defaults to false.", "type": "boolean" }, "-n": { "description": "Prefix each matching line with its line number. Applies only when \`output_mode\` is \`content\`. Defaults to true.", "type": "boolean" }, "-A": { "description": "Number of lines to show after each match. Applies only when \`output_mode\` is \`content\`.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "-B": { "description": "Number of lines to show before each match. Applies only when \`output_mode\` is \`content\`.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "-C": { "description": "Number of lines to show before and after each match. Applies only when \`output_mode\` is \`content\`; takes precedence over \`-A\` and \`-B\`.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "head_limit": { "description": "Limit output to the first N lines/entries after offset. Defaults to 250. Pass 0 for unlimited.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "offset": { "description": "Number of leading lines/entries to skip before applying \`head_limit\`. Use it together with \`head_limit\` to page through large result sets. Defaults to 0.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "multiline": { "description": "Enable multiline matching, where the pattern can span line boundaries and \`.\` also matches newlines. Defaults to false.", "type": "boolean" }, "include_ignored": { "description": "Also search files excluded by ignore files such as \`.gitignore\`, \`.ignore\`, and \`.rgignore\` (for example \`node_modules\` or build outputs). Sensitive files (such as \`.env\`) remain filtered out for safety. VCS metadata directories (\`.git\` and similar) are always skipped, even when this is true. Defaults to false.", "type": "boolean" } }, "required": [ "pattern" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Lookup", "description": "Look up a short test value.", "parameters": { "type": "object", "properties": { "query": { "type": "string" } }, "required": [ "query" ], "additionalProperties": false }, "source": "user", "origin": "initial" }, { "name": "Read", "description": "Read a text file from the active environment's filesystem.\\n\\nThe path may be a \`kimi-file://\` attachment reference. Its bytes come from the current session's storage, independently of the workspace environment. Next Read keeps the reference so pagination also works after a fork. For a binary attachment, the error includes a server-local path when available; a converter must be able to access that filesystem. ReadMediaFile accepts the same reference for images and videos.\\n\\nIf the user provides a concrete file path to a text file, call Read directly. Do not \`Glob\`, \`ls\`, or otherwise pre-check known text file paths; missing or invalid file paths return errors you can handle. Do not use Read for directories; use \`ls\` via Bash for a known directory, or Glob when you need files matching a name pattern (Glob lists files only, never directories). Use \`Grep\` only when the task is to search for unknown content or locations.\\n\\nWhen you need several files, prefer to read them in parallel: emit multiple \`Read\` calls in a single response instead of reading one file per turn.\\n\\n- Relative paths resolve against the working directory; a path outside the working directory must be absolute.\\n- Returns text within \`max_chars\`, including line numbers and the status block, preferring complete lines. The configured default is 100000 characters; calls can request up to 500000. Characters use JavaScript string length, not UTF-8 bytes or tokens. Read results are not spilled or shortened again by the general tool-output limit.\\n- Omit \`n_lines\` to read toward the end of the file. There is no fixed line-count cap. When the task requires the full text of a large file, request a larger \`max_chars\`, up to 500000, in the first call.\\n- Page larger files with \`line_offset\` (1-based start line) and \`n_lines\`. If the result is incomplete, copy the \`Next Read\` arguments in the status block to continue without gaps or overlaps. Do not answer from a partial page when the task requires the remaining content.\\n- If a single line cannot fit on its own page, Read returns a fragment and reports its column range. Continue on the same line with the supplied \`column_offset\`; do not insert a newline between fragments of one source line. A partial line still counts toward the remaining \`n_lines\` until its ending is returned.\\n- \`column_offset\` is a zero-based position in the first line's displayed text, excluding its line-number prefix. It is supported only for forward reads. Offsets past the line or inside a Unicode surrogate pair return an error. Continuation refers to the current file contents; start a new read if the file changed.\\n- Kimi Code agent event logs (\`wire.jsonl\` under the sessions directory) follow the same character budget; locate a record with Grep, read it with \`n_lines=1\`, and follow \`Next Read\` to retrieve every fragment of a long record.\\n- Sensitive files (\`.env\` files, credential stores, SSH private keys, and similar secrets) are refused to protect secrets; do not attempt to read them. Templates and public keys are exempt: \`.env.example\` / \`.env.sample\` / \`.env.template\` and public SSH keys such as \`id_rsa.pub\` read normally.\\n- UTF-8 text files are read directly. UTF-16 LE/BE text files (with or without a BOM) are detected automatically and checked with strict decoding first. If malformed sequences are found, Read returns readable text with U+FFFD replacements and a lossy-decoding warning on every page; do not treat this view as exact original text. The status block notes the detected encoding, and Edit/Write on such a file still expect UTF-8 — convert its encoding first (e.g. with \`iconv\`). Other encodings (e.g. GBK), binary files, and files containing NUL bytes are refused.\\n- Negative \`line_offset\` reads from the end of the file (for example, -100 reads the last 100 lines). If the requested tail range exceeds the character budget, the newest complete lines in that range are returned first; \`Next Read\` covers the omitted earlier range. If no complete line fits, Read reports this and supplies forward \`Next Read\` arguments for the entire unread range. Omit \`column_offset\` when using a negative \`line_offset\`.\\n- Output format: \`<line-number>\\\\t<content>\` per line.\\n- A \`<system>...</system>\` status block is appended after the file content. It reports the actual returned range, total lines, effective character budget, whether the requested range is complete, and whether EOF was reached. The block is not part of the file itself.\\n- Pure CRLF files are displayed with LF line endings; \`Edit\` matches this output and preserves CRLF when writing back.\\n- Mixed or lone carriage-return line endings are shown as \`\\\\r\` and require exact \`Edit.old_string\` escapes.\\n- After a successful \`Edit\`/\`Write\`, do not re-read solely to prove the write landed. When the task depends on an exact file, API, or output shape, inspect the final external contract before finishing.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to a text file or a kimi-file:// attachment reference in the current session. Relative filesystem paths resolve against the working directory; a path outside the working directory must be absolute. Directories are not supported; use \`ls\` via Bash for a known directory, or Glob for pattern search." }, "line_offset": { "description": "The line number to start reading from. Omit to start at line 1. Negative values read from the end of the file (for example, -100 reads the last 100 lines).", "anyOf": [ { "type": "integer", "minimum": 1, "maximum": 9007199254740991 }, { "type": "integer", "minimum": -9007199254740991, "exclusiveMaximum": 0 } ] }, "column_offset": { "description": "Zero-based character offset within the first line of a forward read, excluding its line-number prefix. Uses JavaScript string length in the displayed text. Copy continuation arguments from the previous result to resume a long line.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "n_lines": { "description": "The number of lines to read. Omit to read toward the end of the file. Results are bounded by max_chars, with continuation arguments when the requested range is incomplete.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 }, "max_chars": { "description": "Maximum characters in the returned text, including line numbers and status. Omit for the configured default; requests above the configured maximum are capped.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 } }, "required": [ "path" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "ReadMediaFile", "description": "Read media content from a file.\\n\\nThe path may be a \`kimi-file://\` attachment reference. Its bytes come from the current session's storage, independently of the workspace environment, including after a fork. Any reported local attachment path belongs to the server; external converters must be able to access that filesystem.\\n\\n**Tips:**\\n- Make sure you follow the description of each tool parameter.\\n- A \`<system>\` tag accompanies the media content; it summarizes the mime type, byte size and, for images, the original pixel dimensions, and states how the image was delivered (untouched, downsampled, cropped, or native resolution). When outputting coordinates, give relative coordinates first and compute absolute coordinates from the original image size. After generating or editing media via commands or scripts, read the result back before continuing.\\n- Large images are downsampled by default when automatic compression can safely fit them within model limits, which can blur fine detail (small text, dense UI). Compute absolute coordinates from the original dimensions reported in the \`<system>\` block, never by measuring the displayed copy. When the \`<system>\` tag reports downsampling and you need that detail, call this tool again with the \`region\` parameter (original-image pixel coordinates) to view a crop at full fidelity, or set \`full_resolution\` to true when the whole file fits the per-image byte limit. Re-reading the same file without these parameters just reproduces the same downsampled image.\\n- If automatic compression cannot safely produce an image within model limits, the tool returns an error and does not send the original image. Follow the error: use Bash or an available image-processing tool to create a smaller copy, then read that copy. Do not retry the unchanged file.\\n- The system will notify you when there is anything wrong when reading the file.\\n- This tool is a tool that you typically want to use in parallel. Always read multiple files in one response when possible.\\n- This tool can only read image or video files. To read text files, use the Read tool. To list directories, use \`ls\` via Bash for a known directory, or Glob for pattern search.\\n- If the file doesn't exist or path is invalid, an error will be returned.\\n- The maximum size that can be read is 100MB. An error will be returned if the file is larger than this limit.\\n- The media content will be returned in a form that you can directly view and understand.\\n\\n**Capabilities**\\n\\n- This tool supports image and video files.", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to an image or video file, or a kimi-file:// attachment reference in the current session. Relative filesystem paths resolve against the working directory; a path outside the working directory must be absolute. Directories and text files are not supported." }, "region": { "description": "Images only: view just this rectangle of the image (original-image pixel coordinates). Use after a downsampled full view to inspect fine detail — a region within the size limits is delivered at full fidelity.", "type": "object", "properties": { "x": { "type": "integer", "minimum": 0, "maximum": 9007199254740991, "description": "Left edge of the crop, in original-image pixels." }, "y": { "type": "integer", "minimum": 0, "maximum": 9007199254740991, "description": "Top edge of the crop, in original-image pixels." }, "width": { "type": "integer", "minimum": 1, "maximum": 9007199254740991, "description": "Crop width, in original-image pixels." }, "height": { "type": "integer", "minimum": 1, "maximum": 9007199254740991, "description": "Crop height, in original-image pixels." } }, "required": [ "x", "y", "width", "height" ], "additionalProperties": false }, "full_resolution": { "description": "Images only: skip the default downscaling and view at native resolution. Fails with an explicit error when the payload would exceed the per-image byte limit; use region for files that large.", "type": "boolean" } }, "required": [ "path" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "select_tools", "description": "Load one or more tools by name so you can call them. The loadable names are listed in the <tools_added>/<tools_removed> announcements in the system context — fold them in order to get the current list. If you have not seen a <tools_added> announcement in this session, no tools are currently loadable — do not call select_tools. Pass the exact tool name(s) you need — plugin, skill, or category names do not work. The full definitions become available immediately, so you can call them directly in your next tool call. Only announced names are loadable — tools you already have available are called directly, never passed to select_tools.", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "names": { "minItems": 1, "type": "array", "items": { "type": "string" }, "description": "Exact tool names to load, taken from the latest announced tool list." } }, "required": [ "names" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "SetGoalBudget", "description": "Set a hard budget limit for the current goal.\\n\\nUse this only when the user clearly gives a runtime limit, such as:\\n\\n- \\"stop after 20 turns\\"\\n- \\"use no more than 500k tokens\\"\\n- \\"finish within 30 minutes\\"\\n\\nDo not invent limits. Do not call this for vague wording such as \\"spend some time\\" or\\n\\"try to be quick\\".\\n\\nIf the user gives a compound time, convert it to one supported unit before calling this tool.\\nFor example, \\"2 hours and 3 minutes\\" can be set as \`value: 123, unit: \\"minutes\\"\`.\\n\\nA time budget must be at least 1 second and convert to a finite number of milliseconds.\\nThere is no upper duration limit. Turn and token budgets must be positive and are rounded\\nto the nearest whole number (minimum 1).\\n\\nSupported units:\\n\\n- \`turns\`\\n- \`tokens\`\\n- \`milliseconds\`\\n- \`seconds\`\\n- \`minutes\`\\n- \`hours\`\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "value": { "type": "number", "exclusiveMinimum": 0, "description": "The positive numeric budget value." }, "unit": { "type": "string", "enum": [ "turns", "tokens", "milliseconds", "seconds", "minutes", "hours" ] } }, "required": [ "value", "unit" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Skill", "description": "Invoke a registered skill from the current skill listing. BLOCKING REQUIREMENT: when a skill from the listing matches the user's request, you MUST call this tool (not free-form text). Do not re-invoke a skill to repeat work already done: if a \`<skill-loaded>\` block for it with the same \`args\` is already present in the conversation, follow those instructions directly instead of calling the tool again. Do call the tool again when you need the skill with different arguments — the loaded block was expanded with the earlier \`args\` and will not reflect new inputs.", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "skill": { "type": "string", "description": "The exact name of the skill to invoke, copied verbatim from the current skill listing." }, "args": { "description": "Optional argument string for the skill, written like a command line (e.g. \`-m \\"fix bug\\"\`, \`123\`, a file path). It is split on whitespace (quotes group a token) and expanded into the skill's placeholders ($NAME, $1, $ARGUMENTS); if the skill body has no placeholders, the whole string is still appended as a trailing \`ARGUMENTS:\` line. Omit it only when there is nothing to pass.", "type": "string" } }, "required": [ "skill" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "TaskList", "description": "List background tasks and their current status.\\n\\nUse this tool to discover which background tasks exist and where each one\\nstands. It is the entry point for inspecting background work: it returns a\\ntask ID, status, and description for every task it reports, plus the command,\\nPID, and (once finished) exit code for shell tasks, and a stop reason for any\\ntask that ended early.\\n\\nGuidelines:\\n\\n- After a context compaction, or whenever you are unsure which background\\n  tasks are running or what their task IDs are, call this tool to\\n  re-enumerate them instead of guessing a task ID.\\n- Prefer the default \`active_only=true\`, which lists only non-terminal tasks.\\n  Pass \`active_only=false\` only when you specifically need to see tasks that\\n  have already finished. With \`active_only=false\` the result may also include\\n  \`lost\` tasks — tasks left over from a previous process that can no longer be\\n  inspected or controlled; treat them as already terminated.\\n- \`limit\` caps how many tasks are returned. It accepts a value between 1 and\\n  100 and defaults to 20 when omitted.\\n- This tool only lists tasks; it does not return their output. Use it first\\n  to locate the task ID you need, then call \`TaskOutput\` with that ID to read\\n  the task's output and details.\\n- This tool is read-only and does not change any state, so it is always safe\\n  to call, including in plan mode.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "active_only": { "default": true, "description": "Whether to list only non-terminal background tasks.", "type": "boolean" }, "limit": { "default": 20, "description": "Maximum number of tasks to return.", "type": "integer", "minimum": 1, "maximum": 100 } }, "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "TaskOutput", "description": "Retrieve a snapshot of a running or completed background task.\\n\\nUse this after \`Bash(run_in_background=true)\`, \`Agent(run_in_background=true)\`, or \`AskUserQuestion(background=true)\` to check progress, or to read the output of a task that has already completed.\\n\\nGuidelines:\\n- Prefer relying on automatic completion notifications. Use this tool only when you need task output before the automatic notification arrives.\\n- This tool is always non-blocking: it returns the current status/output snapshot immediately and never waits for the task to finish.\\n- Do not use TaskOutput to wait for a result you need before continuing — if your next step depends on the task's result, run that task in the foreground instead. TaskOutput is for a deliberate progress check you will act on without blocking, not a way to sit and wait for a background task you just launched.\\n- This tool returns structured task metadata, a fixed-size output preview, and an output_path for the full log.\\n- For a terminal task, the metadata also explains why it ended. A shell command that runs to completion reports \`status: completed\` on a zero exit, or \`status: failed\` with its non-zero \`exit_code\` — judge that failure from the \`exit_code\`, because a plain command failure carries no \`stop_reason\` and no \`terminal_reason\`. \`terminal_reason\` is a categorical label emitted only when the end is not an ordinary exit: \`timed_out\` when the deadline aborted it, \`stopped\` when it was explicitly stopped, or \`failed\` when it errored without producing an exit code; the \`stopped\` and \`failed\` cases also carry a human-readable \`stop_reason\`. A task that finished on its own with a clean exit carries neither \`stop_reason\` nor \`terminal_reason\`.\\n- The full, never-truncated log is always available at output_path; use the \`Read\` tool with that path to page through it, whether or not the preview was truncated.\\n- This tool works with the generic background task system and should remain the primary read path for future task types, not just bash.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "task_id": { "type": "string", "description": "The background task ID to inspect." } }, "required": [ "task_id" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "TaskStop", "description": "Stop a running background task.\\n\\nOnly use this when a task must genuinely be cancelled — for a task that is\\nfinishing normally, wait for its completion notification or inspect it with\\n\`TaskOutput\` instead of stopping it.\\n\\nGuidelines:\\n- This is a general-purpose stop capability for any background task. It is not\\n  a bash-specific kill.\\n- Stopping a task is destructive: it may leave partial side effects behind.\\n  Use it with care.\\n- If the task has already finished, this tool simply returns its current\\n  status.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "task_id": { "type": "string", "description": "The background task ID to stop." }, "reason": { "default": "Stopped by TaskStop", "description": "Short reason recorded when the task is stopped.", "type": "string" } }, "required": [ "task_id" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "TodoList", "description": "Use this tool to maintain a structured TODO list as you work through a multi-step task. Use it proactively and often when progress tracking helps the current work. The list is shown to the user as a live progress panel, so keep it in step with what you have actually done. This is especially useful in long-running investigations and implementation tasks with several tool calls; in plan mode, write the plan to the plan file rather than tracking it here.\\n\\n**When to use:**\\n- Multi-step tasks that span several tool calls\\n- Tracking investigation progress across a large codebase search\\n- Planning a sequence of edits before making them\\n- After receiving new multi-step instructions, capture the requirements as todos\\n\\n**When NOT to use:**\\n- Single-shot answers that complete in one or two tool calls\\n- Trivial requests where tracking adds no clarity\\n- Purely conversational or informational replies\\n\\n**Keeping it current:**\\n- Before you start a tracked task, mark it \`in_progress\`; while work is underway, keep exactly one task \`in_progress\`.\\n- As soon as a task is finished, mark it \`done\`, before you start the next one. Do not batch completions at the end.\\n- Before you write your final message, make sure the list matches what you actually did.\\n- An update can go in the same response as your next tool call; it does not need a step of its own.\\n- Do not re-send an unchanged list. If you are stuck and no available tool can move any task forward, tell the user instead of re-ordering the same todos.\\n\\n**How to use:**\\n- Call with \`todos: [...]\` to replace the full list. Statuses: pending / in_progress / done.\\n- Call with no \`todos\` argument to retrieve the current list without changing it.\\n- Call with \`todos: []\` to clear the list.\\n- Keep titles short and actionable (e.g. \\"Read session-control.ts\\", \\"Add planMode flag to TurnManager\\").\\n- Only mark a task \`done\` when it is fully accomplished.\\n- Never mark a task \`done\` if tests are failing, implementation is partial, unresolved errors remain, or required files/dependencies could not be found.\\n- If you encounter a blocker, keep the blocked task \`in_progress\` or add a new pending task describing what must be resolved.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "todos": { "description": "The updated todo list. Omit to read the current todo list without making changes. Pass an empty array to clear the list.", "type": "array", "items": { "type": "object", "properties": { "title": { "type": "string", "minLength": 1, "description": "Short, actionable title for the todo." }, "status": { "type": "string", "enum": [ "pending", "in_progress", "done" ], "description": "Current status of the todo." } }, "required": [ "title", "status" ], "additionalProperties": false } } }, "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "UpdateGoal", "description": "Set the status of the current goal. This is how you resume, complete, or block an autonomous goal.\\n\\n- \`active\` — resume a paused or blocked goal when the user explicitly asks you to work on that goal.\\n- \`complete\` — the objective is satisfied and any stated validation has passed. The goal ends and a completion summary is recorded. Before using this, verify the current state against the actual objective and every explicit requirement. Treat weak or indirect evidence as not complete. Do not use \`complete\` merely because a budget is nearly exhausted or you want to stop.\\n- \`blocked\` — a genuine impasse prevents useful progress: an external condition, required user input, missing credentials or permissions, a persistent technical failure, or an impossible, unsafe, or contradictory objective. For non-terminal blockers, do not use \`blocked\` the first time you hit the blocker. The same blocking condition must repeat for at least 3 consecutive goal turns before you call \`blocked\`, counting the original/user-triggered turn and automatic continuations. If a previously blocked goal is resumed, treat the resumed run as a fresh blocked audit. If the objective itself is impossible, unsafe, or contradictory, call \`blocked\` in the same turn instead of running more goal turns. Do not use \`blocked\` because the work is large, hard, slow, uncertain, incomplete, still needs validation, would benefit from clarification, or needs more goal turns. Once the 3-turn threshold is met and you cannot make meaningful progress without user input or an external-state change, call \`blocked\` instead of leaving the goal active.\\n\\nMost active goal turns should not call this tool. If you complete one useful slice of work and material work remains, end the turn normally without calling UpdateGoal; the runtime will prompt you to continue in the next goal turn. Call \`complete\` only when all required work is done, any stated validation has passed, and there is no useful next action. Do not call \`complete\` after only producing a plan, summary, first pass, or partial result. Call \`blocked\` only after the blocked audit threshold is met. If you call \`blocked\`, you will be prompted to explain the blocker in your next message. Setting the status is the machine-readable signal; the completion summary or blocker explanation is yours to write in the following message.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "status": { "type": "string", "enum": [ "active", "complete", "blocked" ], "description": "The lifecycle status to set for the current goal. Use \`blocked\` for impossible, unsafe, or contradictory objectives, or after the same non-terminal blocking condition repeats for at least 3 consecutive goal turns." } }, "required": [ "status" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "WaitFor", "description": "Wait for background tasks to finish without ending the current turn.\\n\\nOnly call this tool when you really have no other work to do and your next step cannot proceed without the result of a running background task (a sub-agent, a background bash command, or a background AskUserQuestion). The call suspends inside the current turn until the task finishes or the timeout elapses, then returns the outcome so you can keep working in the same turn. While waiting, no LLM requests are made, but the user is kept waiting too.\\n\\nWhen background tasks finish, they notify you automatically, so you do not need to busily wait for them.\\n\\nGuidelines:\\n\\n- Before calling WaitFor, think about what else you can do meanwhile: another part of the task, verifying earlier work, or ending your turn with a progress update. If there is anything, do that instead.\\n- Do not call WaitFor right after dispatching work whose result you do not need yet.\\n- \`timeout\` is required, in seconds, capped at 90. Pick it from how long you expect the task to take, not the maximum.\\n- A timeout is not an error: the result lists the tasks that are still running. Prefer moving on to other work over calling WaitFor again; repeated waits keep the user waiting.\\n- Without \`task_id\`, the wait ends as soon as any background task that was running at call time finishes. Tasks started during the wait are not covered by it; their completion arrives via the usual automatic notification.\\n- With \`task_id\`, the wait ends when that task finishes. An unknown \`task_id\` is an error; a task that has already finished returns immediately.\\n- When no background tasks are running, WaitFor returns immediately without waiting.\\n- When the wait ends because a task finished, the result also lists other tasks that finished during the wait window, so failures surface with context.\\n- Waiting has no side effects on the waited tasks: WaitFor never stops a task, and interrupting the wait (for example, a new user message) leaves every task running.\\n- A finished task's result is delivered exactly once: tasks reported by WaitFor do not also produce an automatic completion notification.\\n- You can only wait for background tasks started by this agent; task IDs belonging to other agents are unknown here.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "timeout": { "type": "integer", "exclusiveMinimum": 0, "maximum": 90, "description": "Maximum time to wait, in seconds (1-90). Pick it from how long you expect the task to take, not the maximum. A timeout is not an error: the tool returns the tasks that are still running." }, "task_id": { "description": "The background task ID to wait for. When omitted, the wait ends as soon as any background task that was running at call time finishes.", "type": "string" } }, "required": [ "timeout" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Write", "description": "Create, append to, or replace a file entirely.\\n\\n- Missing parent directories are created automatically (like \`mkdir(parents=True, exist_ok=True)\`).\\n- Mode defaults to overwrite; append adds content at EOF without adding a newline.\\n- Write is NOT ALLOWED for incremental changes to existing files, including trivial, one-line, quick, or cosmetic edits. Use Edit instead.\\n- Use Write only when the file does not exist, you intend a complete replacement, or the new contents have little continuity with the old contents.\\n- Do not create unsolicited documentation files (\`*.md\` write-ups, \`README\`s, summaries) just because a task finished — write one only when the user asks for it, or when a task or project instruction requires it (e.g. the plan-mode plan file, created with Write when plan mode directs you to, or a changeset the repo mandates).\\n- Read before overwriting an existing file.\\n- Write ignores the Read/Edit line-number view. NEVER include line prefixes.\\n- Write outputs content literally, including supplied line endings: \\\\n stays LF, \\\\r\\\\n stays CRLF.\\n- For new content too large for one call, overwrite the first chunk, then append subsequent chunks. Never chunk Write to modify an existing file.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to the file to create, append to, or completely overwrite. Relative paths resolve against the working directory; a path outside the working directory must be absolute. Missing parent directories are created automatically." }, "content": { "type": "string", "description": "Raw full file content to write exactly as provided. This does not use the Read/Edit text view." }, "mode": { "description": "Write mode. Defaults to overwrite. append adds content to the end exactly as provided and does not add a newline.", "type": "string", "enum": [ "overwrite", "append" ] } }, "required": [ "path", "content" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" } ], "time": "<time>" }
      [wire] llm.tools_snapshot              { "agentId": "main", "hash": "3bfeb22e61431247933e79f6ab94e7ca14a127f899bc87e7bbd22594ba9cdb66", "tools": [ { "name": "Lookup", "description": "Look up a short test value.", "parameters": { "type": "object", "properties": { "query": { "type": "string" } }, "required": [ "query" ], "additionalProperties": false } } ], "time": "<time>" }
      [wire] llm.request                     { "agentId": "main", "kind": "loop", "provider": "openai", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "3bfeb22e61431247933e79f6ab94e7ca14a127f899bc87e7bbd22594ba9cdb66", "messageCount": 1, "turnStep": "0.1", "time": "<time>" }
      [emit] assistant.delta                 { "time": "<time>", "agentId": "main", "turnId": 0, "delta": "I will look it up." }
      [emit] tool.call.delta                 { "time": "<time>", "agentId": "main", "turnId": 0, "toolCallId": "call_lookup", "name": "Lookup", "argumentsPart": "{\\"query\\":\\"original\\"}" }
      [wire] usage.record                    { "agentId": "main", "model": "mock-model", "usage": { "inputOther": 9, "output": 17, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated            { "time": "<time>", "agentId": "main", "usage": { "byModel": { "mock-model": { "inputOther": 9, "output": 17, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 9, "output": 17, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 9, "output": 17, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] token_counting.measured         { "agentId": "main", "length": 2, "tokens": 26, "time": "<time>" }
      [emit] agent.status.updated            { "time": "<time>", "agentId": "main", "contextTokens": 26 }
      [wire] context.append_loop_event       { "agentId": "main", "event": { "type": "content.part", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "I will look it up." } }, "time": "<time>" }
      [emit] permission.approval.requested   { "time": "<time>", "id": "<approval-1>", "sessionId": "test-session", "agentId": "main", "turnId": 0, "toolCallId": "call_lookup", "toolName": "Lookup", "action": "Approve Lookup", "display": { "kind": "generic", "summary": "Approve Lookup", "detail": { "query": "original" } }, "toolInput": { "query": "original" } }
      [wire] interaction.request             { "agentId": "main", "id": "<approval-1>", "kind": "approval", "toolCallId": "call_lookup", "request": { "id": "<approval-1>", "sessionId": "test-session", "agentId": "main", "turnId": 0, "toolCallId": "call_lookup", "toolName": "Lookup", "action": "Approve Lookup", "display": { "kind": "generic", "summary": "Approve Lookup", "detail": { "query": "original" } } }, "time": "<time>" }
      [emit] requestApproval                 { "id": "<approval-1>", "turnId": 0, "toolCallId": "call_lookup", "toolName": "Lookup", "action": "Approve Lookup", "display": { "kind": "generic", "summary": "Approve Lookup", "detail": { "query": "original" } } }
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
      [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "tool.call", "uuid": "<uuid-3>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "toolCallId": "call_lookup", "name": "Lookup", "args": { "query": "original" } }, "time": "<time>" }
      [wire] interaction.request         { "agentId": "main", "id": "<user_tool-2>", "kind": "user_tool", "toolCallId": "call_lookup", "request": { "turnId": 0, "toolCallId": "call_lookup", "name": "Lookup", "args": { "query": "original" } }, "time": "<time>" }
      [wire] interaction.resolved        { "agentId": "main", "id": "<user_tool-2>", "response": { "content": "original-result", "output": "original-result" }, "time": "<time>" }
      [emit] tool.result                 { "time": "<time>", "agentId": "main", "turnId": 0, "toolCallId": "call_lookup", "output": "original-result" }
      [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "tool.result", "parentUuid": "<uuid-3>", "toolCallId": "call_lookup", "result": { "output": "original-result" } }, "time": "<time>" }
      [emit] turn.step.completed         { "time": "<time>", "agentId": "main", "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 9, "output": 17, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use", "providerFinishReason": "tool_calls", "rawFinishReason": "tool_calls" }
      [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "step.end", "uuid": "<uuid-1>", "turnId": "0", "step": 1, "finishReason": "tool_use", "usage": { "inputOther": 9, "output": 17, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-1", "providerFinishReason": "tool_calls", "rawFinishReason": "tool_calls" }, "time": "<time>" }
      [emit] context.spliced             { "time": "<time>", "agentId": "main", "start": 3, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "<date-reminder>" } ], "origin": { "kind": "injection", "variant": "date_change", "disclosure": { "kind": "date", "renderGeneration": 2, "localDate": "<date>", "timeZone": "<time-zone>" } } } ] }
      [wire] context.append_message      { "agentId": "main", "message": { "role": "user", "content": [ { "type": "text", "text": "<date-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "date_change", "disclosure": { "kind": "date", "renderGeneration": 2, "localDate": "<date>", "timeZone": "<time-zone>" } } }, "time": "<time>" }
      [emit] turn.step.started           { "time": "<time>", "agentId": "main", "turnId": 0, "step": 2, "stepId": "<uuid-4>" }
      [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "step.begin", "uuid": "<uuid-4>", "turnId": "0", "step": 2 }, "time": "<time>" }
      [wire] llm.tools_snapshot          { "agentId": "main", "hash": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", "tools": [], "time": "<time>" }
      [wire] llm.request                 { "agentId": "main", "kind": "loop", "provider": "openai", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "systemPrompt": "You are a deterministic test agent.", "toolsHash": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", "messageCount": 4, "turnStep": "0.2", "time": "<time>" }
      [emit] assistant.delta             { "time": "<time>", "agentId": "main", "turnId": 0, "delta": "Still using the original turn config." }
      [wire] usage.record                { "agentId": "main", "model": "mock-model", "usage": { "inputOther": 103, "output": 13, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated        { "time": "<time>", "agentId": "main", "usage": { "byModel": { "mock-model": { "inputOther": 112, "output": 30, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 112, "output": 30, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 112, "output": 30, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] token_counting.measured     { "agentId": "main", "length": 5, "tokens": 116, "time": "<time>" }
      [emit] agent.status.updated        { "time": "<time>", "agentId": "main", "contextTokens": 116 }
      [emit] turn.step.completed         { "time": "<time>", "agentId": "main", "turnId": 0, "step": 2, "stepId": "<uuid-4>", "usage": { "inputOther": 103, "output": 13, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn", "providerFinishReason": "completed", "rawFinishReason": "stop" }
      [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "content.part", "uuid": "<uuid-5>", "turnId": "0", "step": 2, "stepUuid": "<uuid-4>", "part": { "type": "text", "text": "Still using the original turn config." } }, "time": "<time>" }
      [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "step.end", "uuid": "<uuid-4>", "turnId": "0", "step": 2, "finishReason": "end_turn", "usage": { "inputOther": 103, "output": 13, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-2", "providerFinishReason": "completed", "rawFinishReason": "stop" }, "time": "<time>" }
      [wire] agent.message.appended      { "message": { "message": { "role": "assistant", "content": [ { "type": "text", "text": "I will look it up." } ], "toolCalls": [ { "type": "function", "id": "call_lookup", "name": "Lookup", "arguments": "{\\"query\\":\\"original\\"}" } ] }, "meta": { "model": { "provider": "agent-loop", "model": "agent-loop" }, "source": "llm", "usage": { "inputOther": 9, "output": 17, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finish": { "finishReason": "tool_calls", "rawFinishReason": "tool_calls" }, "messageId": "mock-1" } }, "time": "<time>", "kind": "event" }
      [wire] agent.message.appended      { "message": { "message": { "role": "tool", "content": [ { "type": "text", "text": "original-result" } ], "toolCallId": "call_lookup" }, "meta": { "source": "tool" } }, "time": "<time>", "kind": "event" }
      [wire] agent.message.appended      { "message": { "message": { "role": "assistant", "content": [ { "type": "text", "text": "Still using the original turn config." } ], "toolCalls": [] }, "meta": { "model": { "provider": "agent-loop", "model": "agent-loop" }, "source": "llm", "usage": { "inputOther": 103, "output": 13, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finish": { "finishReason": "completed", "rawFinishReason": "stop" }, "messageId": "mock-2" } }, "time": "<time>", "kind": "event" }
      [wire] agent.turn.ended            { "turnId": 0, "outcome": "done", "time": "<time>", "kind": "event" }
      [wire] turn.ended                  { "agentId": "main", "turnId": 0, "reason": "completed", "time": "<time>" }
      [emit] turn.ended                  { "time": "<time>", "agentId": "main", "turnId": 0, "reason": "completed" }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      tools: []
      messages:
        <last>
        assistant: text "I will look it up."  calls call_lookup:Lookup { "query": "original" }
        tool[call_lookup]: text "original-result"
        user: text <date-reminder>
    `);

    ctx.mockNextResponse({ type: 'text', text: 'Now the changed config is active.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Start a fresh turn' }] });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] token_counting.turn_recorded   { "agentId": "main", "turnId": 0, "length": 5, "tokens": 116, "time": "<time>" }
      [emit] agent.status.updated           { "time": "<time>", "agentId": "main", "contextTokens": 116 }
      [wire] prompt.completed               { "agentId": "main", "promptId": "<msg-1>", "finishedAt": "<time>", "reason": "completed", "time": "<time>" }
      [emit] prompt.completed               { "time": "<time>", "agentId": "main", "promptId": "<msg-1>", "finishedAt": "<time>", "reason": "completed" }
      [emit] prompt.submitted               { "time": "<time>", "agentId": "main", "promptId": "<msg-2>", "userMessageId": "<msg-2>", "status": "running", "content": [ { "type": "text", "text": "Start a fresh turn" } ], "createdAt": "<time>" }
      [wire] turn.prompt                    { "agentId": "main", "input": [ { "type": "text", "text": "Start a fresh turn" } ], "origin": { "kind": "user" }, "promptId": "<msg-2>", "turnId": 1, "time": "<time>" }
      [emit] turn.prompt                    { "time": "<time>", "agentId": "main", "input": [ { "type": "text", "text": "Start a fresh turn" } ], "origin": { "kind": "user" }, "promptId": "<msg-2>", "turnId": 1 }
      [emit] turn.started                   { "time": "<time>", "agentId": "main", "turnId": 1, "promptId": "<msg-2>", "origin": { "kind": "user" }, "prompt": "Start a fresh turn" }
      [emit] context.spliced                { "time": "<time>", "agentId": "main", "start": 5, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Start a fresh turn" } ], "id": "<msg-2>", "origin": { "kind": "user" } } ] }
      [emit] prompt.started                 { "time": "<time>", "agentId": "main", "promptId": "<msg-2>" }
      [wire] context.append_message         { "agentId": "main", "message": { "role": "user", "content": [ { "type": "text", "text": "Start a fresh turn" } ], "toolCalls": [], "id": "<msg-2>", "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] agent.message.appended         { "message": { "message": { "role": "user", "content": [ { "type": "text", "text": "Start a fresh turn" } ] }, "meta": { "source": "input", "promptId": "<msg-2>", "origin": { "kind": "user" }, "tracked": true, "createdAt": "<time>", "userMessageId": "<msg-2>" } }, "time": "<time>", "kind": "event" }
      [wire] agent.turn.started             { "turnId": 1, "queueItemId": "<msg-2>", "time": "<time>", "kind": "event" }
      [emit] turn.step.started              { "time": "<time>", "agentId": "main", "turnId": 1, "step": 1, "stepId": "<uuid-6>" }
      [wire] context.append_loop_event      { "agentId": "main", "event": { "type": "step.begin", "uuid": "<uuid-6>", "turnId": "1", "step": 1 }, "time": "<time>" }
      [wire] llm.request                    { "agentId": "main", "kind": "loop", "provider": "openai", "model": "changed-model", "modelAlias": "changed-model", "thinkingEffort": "off", "toolSelect": false, "systemPromptHash": "7617cb8b42659214c397a1d7505fce204b673b078a10de8bcccc697d88dcda56", "toolsHash": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", "messageCount": 6, "turnStep": "1.1", "time": "<time>" }
      [emit] assistant.delta                { "time": "<time>", "agentId": "main", "turnId": 1, "delta": "Now the changed config is active." }
      [wire] usage.record                   { "agentId": "main", "model": "changed-model", "usage": { "inputOther": 122, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated           { "time": "<time>", "agentId": "main", "usage": { "byModel": { "mock-model": { "inputOther": 112, "output": 30, "inputCacheRead": 0, "inputCacheCreation": 0 }, "changed-model": { "inputOther": 122, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 234, "output": 42, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 122, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] token_counting.measured        { "agentId": "main", "length": 7, "tokens": 134, "time": "<time>" }
      [emit] agent.status.updated           { "time": "<time>", "agentId": "main", "contextTokens": 134 }
      [emit] turn.step.completed            { "time": "<time>", "agentId": "main", "turnId": 1, "step": 1, "stepId": "<uuid-6>", "usage": { "inputOther": 122, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn", "providerFinishReason": "completed", "rawFinishReason": "stop" }
      [wire] context.append_loop_event      { "agentId": "main", "event": { "type": "content.part", "uuid": "<uuid-7>", "turnId": "1", "step": 1, "stepUuid": "<uuid-6>", "part": { "type": "text", "text": "Now the changed config is active." } }, "time": "<time>" }
      [wire] context.append_loop_event      { "agentId": "main", "event": { "type": "step.end", "uuid": "<uuid-6>", "turnId": "1", "step": 1, "finishReason": "end_turn", "usage": { "inputOther": 122, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-3", "providerFinishReason": "completed", "rawFinishReason": "stop" }, "time": "<time>" }
      [wire] agent.message.appended         { "message": { "message": { "role": "assistant", "content": [ { "type": "text", "text": "Now the changed config is active." } ], "toolCalls": [] }, "meta": { "model": { "provider": "agent-loop", "model": "agent-loop" }, "source": "llm", "usage": { "inputOther": 122, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finish": { "finishReason": "completed", "rawFinishReason": "stop" }, "messageId": "mock-3" } }, "time": "<time>", "kind": "event" }
      [wire] agent.turn.ended               { "turnId": 1, "outcome": "done", "time": "<time>", "kind": "event" }
      [wire] turn.ended                     { "agentId": "main", "turnId": 1, "reason": "completed", "time": "<time>" }
      [emit] turn.ended                     { "time": "<time>", "agentId": "main", "turnId": 1, "reason": "completed" }
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

  it('re-validates an env-bound section only when its env values change', async () => {
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

    const parse = vi.fn((value: unknown) => value as { value?: string });
    ix.get(IConfigRegistry).registerSection('memoDemo', { parse }, {
      env: { value: 'MEMO_DEMO_ENV' },
    });
    parse.mockClear();

    expect(config.get<{ value?: string }>('memoDemo')).toEqual({});
    expect(config.get<{ value?: string }>('memoDemo')).toEqual({});
    expect(parse).toHaveBeenCalledTimes(1);

    env['MEMO_DEMO_ENV'] = 'from-env';
    expect(config.get<{ value?: string }>('memoDemo')).toEqual({ value: 'from-env' });
    expect(config.get<{ value?: string }>('memoDemo')).toEqual({ value: 'from-env' });
    expect(parse).toHaveBeenCalledTimes(2);

    delete env['MEMO_DEMO_ENV'];
    expect(config.get<{ value?: string }>('memoDemo')).toEqual({});
    expect(parse).toHaveBeenCalledTimes(3);

    disposables.dispose();
  });

  it('drops a memoized env-bound value when its domain is re-registered by another section', async () => {
    const env: Record<string, string> = { REBOUND_DEMO_ENV: 'x' };
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
    const registry = ix.get(IConfigRegistry);

    registry.registerSection(
      'reboundDemo',
      { parse: (value: unknown) => `first:${String(value)}` },
      { env: 'REBOUND_DEMO_ENV' },
    );
    expect(config.get('reboundDemo')).toBe('first:x');

    registry.unregisterSection('reboundDemo');
    registry.registerSection(
      'reboundDemo',
      { parse: (value: unknown) => `second:${String(value)}` },
      { env: 'REBOUND_DEMO_ENV' },
    );
    expect(config.get('reboundDemo')).toBe('second:x');

    disposables.dispose();
  });

  it('applies a scalar section env binding and keeps it out of the file', async () => {
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

    expect(config.get(BUILTIN_PRODUCT_SKILLS_SECTION)).toBe(true);

    env['KIMI_CODE_BUILTIN_PRODUCT_SKILLS'] = '0';
    expect(config.get(BUILTIN_PRODUCT_SKILLS_SECTION)).toBe(false);

    await config.replace(BUILTIN_PRODUCT_SKILLS_SECTION, true);
    delete env['KIMI_CODE_BUILTIN_PRODUCT_SKILLS'];
    expect(config.get(BUILTIN_PRODUCT_SKILLS_SECTION)).toBe(true);

    disposables.dispose();
  });

  it('keeps the file value when a scalar section env value fails to parse', async () => {
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
    await config.replace(BUILTIN_PRODUCT_SKILLS_SECTION, false);

    for (const invalid of ['', '   ', 'maybe']) {
      env['KIMI_CODE_BUILTIN_PRODUCT_SKILLS'] = invalid;
      expect(config.get(BUILTIN_PRODUCT_SKILLS_SECTION)).toBe(false);
    }

    env['KIMI_CODE_BUILTIN_PRODUCT_SKILLS'] = 'on';
    expect(config.get(BUILTIN_PRODUCT_SKILLS_SECTION)).toBe(true);

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

  it('marks the env-injected flat model ready in the auth legacy summary', async () => {
    const env: Record<string, string> = { KIMI_MODEL_NAME: 'kimi-for-coding' };
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.stub(IOAuthService, { status: vi.fn() } as unknown as IOAuthService);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    ix.set(IAuthLegacyService, new SyncDescriptor(AuthLegacyService));

    const summary = await ix.get(IAuthLegacyService).get();

    expect(summary).toEqual({
      models_ready: true,
      providers_count: 1,
      managed_provider: null,
    });

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

describe('Read config section', () => {
  it('accepts positive character budgets and rejects invalid limits', () => {
    const registry = new ConfigRegistry();

    expect(registry.validate(READ_SECTION, { defaultMaxChars: 200_000, maxChars: 750_000 }))
      .toEqual({ defaultMaxChars: 200_000, maxChars: 750_000 });
    expect(registry.validate(READ_SECTION, { maxChars: 1_000 })).toEqual({ maxChars: 1_000 });
    expect(() => registry.validate(READ_SECTION, { defaultMaxChars: 0 })).toThrow();
    expect(() => registry.validate(READ_SECTION, { maxChars: -1 })).toThrow();
    expect(() => registry.validate(READ_SECTION, { maxChars: 1.5 })).toThrow();
    expect(() => registry.validate(READ_SECTION, { maxChars: Infinity })).toThrow();
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

    await config.set(IMAGE_SECTION, { maxEdgePx: 1500, readByteBudget: 262144 });

    expect(config.get<ImageConfig>(IMAGE_SECTION)).toEqual({
      maxEdgePx: 1500,
      readByteBudget: 262144,
    });
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
    expect(registry.validate(LOOP_CONTROL_SECTION, { compactionMaxAttempts: 8 })).toEqual({
      compactionMaxAttempts: 8,
    });
    expect(() => registry.validate(LOOP_CONTROL_SECTION, { maxStepsPerTurn: -1 })).toThrow();
    expect(() => registry.validate(LOOP_CONTROL_SECTION, { maxAttemptsPerStep: 1.5 })).toThrow();
    expect(() => registry.validate(LOOP_CONTROL_SECTION, { compactionMaxAttempts: 0 })).toThrow();
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

    await config.set(LOOP_CONTROL_SECTION, {
      maxStepsPerTurn: 7,
      maxAttemptsPerStep: 2,
      reservedContextSize: 5000,
    });

    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION)).toEqual({
      maxStepsPerTurn: 7,
      maxAttemptsPerStep: 2,
      reservedContextSize: 5000,
    });
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

    env[LOOP_MAX_STEPS_PER_TURN_ENV] = 'abc';
    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION).maxStepsPerTurn).toBe(100);

    env[LOOP_MAX_STEPS_PER_TURN_ENV] = '9';
    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION).maxStepsPerTurn).toBe(9);

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

    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION)).toEqual({ maxStepsPerTurn: 7 });
    expect(config.inspect<LoopControl>(LOOP_CONTROL_SECTION).userValue).toEqual({
      maxStepsPerRun: 100,
    });
    expect(config.diagnostics()).toContainEqual({
      domain: LOOP_CONTROL_SECTION,
      severity: 'warning',
      message:
        "[loop_control] 'max_steps_per_run' is deprecated and no longer used; rename it to 'max_steps_per_turn'. Run /update-config to fix it.",
    });
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

    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION)).toEqual({});
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

    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION)).toEqual({ maxAttemptsPerStep: 4 });
    expect(config.diagnostics()).toContainEqual({
      domain: LOOP_CONTROL_SECTION,
      severity: 'warning',
      message: `Environment variable ${LOOP_MAX_RETRIES_PER_STEP_ENV} is deprecated; use ${LOOP_MAX_ATTEMPTS_PER_STEP_ENV} instead.`,
    });
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

    await config.set(LOOP_CONTROL_SECTION, { maxAttemptsPerStep: 2, reservedContextSize: 5000 });

    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION)).toEqual({
      maxAttemptsPerStep: 2,
      reservedContextSize: 5000,
    });
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

describe('malformed models config entries', () => {
  async function createConfig(toml: string) {
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    await storage.write('', 'config.toml', new TextEncoder().encode(toml));
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', {}));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;
    return { config, disposables, storage };
  }

  it('warns at load time when a dotted alias parses as a nested table', async () => {
    const { config, disposables } = await createConfig(
      '[models.kimi-k2.7-code]\nmodel = "kimi-k2.7-code"\nmax_context_size = 262144\n',
    );

    expect(config.diagnostics()).toContainEqual({
      domain: 'models',
      severity: 'warning',
      message:
        "[models] entry 'kimi-k2' is missing the 'model' field and cannot be used as a model; " +
        'if the alias contains dots, quote the table name (e.g. [models."kimi-k2.7-code"]).',
    });

    disposables.dispose();
  });

  it('stays silent for quoted dotted aliases and entries with a wire-facing name', async () => {
    const { config, disposables } = await createConfig(
      '[models."kimi-k2.7-code"]\nmodel = "kimi-k2.7-code"\n\n[models.renamed]\nname = "wire-name"\n',
    );

    expect(config.diagnostics()).toEqual([]);

    disposables.dispose();
  });

  it('warns without the dotted-alias hint when the entry has no nested table', async () => {
    const { config, disposables } = await createConfig(
      '[models.partial]\nmax_context_size = 262144\n',
    );

    expect(config.diagnostics()).toContainEqual({
      domain: 'models',
      severity: 'warning',
      message:
        "[models] entry 'partial' is missing the 'model' field and cannot be used as a model.",
    });

    disposables.dispose();
  });

  it('does not mistake schema object fields for a dotted alias', async () => {
    const { config, disposables } = await createConfig(
      '[models.partial]\noverrides = { max_output_size = 8192 }\n',
    );

    expect(config.diagnostics()).toContainEqual({
      domain: 'models',
      severity: 'warning',
      message:
        "[models] entry 'partial' is missing the 'model' field and cannot be used as a model.",
    });

    disposables.dispose();
  });

  it('clears the warning on reload once the entry is fixed', async () => {
    const { config, disposables, storage } = await createConfig(
      '[models.kimi-k2.7-code]\nmodel = "kimi-k2.7-code"\n',
    );
    expect(config.diagnostics()).toHaveLength(1);

    await storage.write(
      '',
      'config.toml',
      new TextEncoder().encode('[models."kimi-k2.7-code"]\nmodel = "kimi-k2.7-code"\n'),
    );
    await config.reload();

    expect(config.diagnostics()).toEqual([]);

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

    await config.set('background', {
      keepAliveOnExit: true,
      maxRunningTasks: 8,
      killGracePeriodMs: 25,
    });

    expect(config.get<AgentTaskConfig>('background')).toEqual({
      keepAliveOnExit: true,
      maxRunningTasks: 8,
      killGracePeriodMs: 25,
    });
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

  it('applies the bashTaskTimeoutS env binding, accepting 0 as no timeout', async () => {
    const env: Record<string, string> = {};
    const { config, disposables } = await createTaskConfig(env);

    expect(config.get<AgentTaskConfig>('task')?.bashTaskTimeoutS).toBeUndefined();

    env[BASH_TASK_TIMEOUT_S_ENV] = 'abc';
    expect(config.get<AgentTaskConfig>('task')?.bashTaskTimeoutS).toBeUndefined();
    env[BASH_TASK_TIMEOUT_S_ENV] = '-5';
    expect(config.get<AgentTaskConfig>('task')?.bashTaskTimeoutS).toBeUndefined();

    env[BASH_TASK_TIMEOUT_S_ENV] = '0';
    expect(config.get<AgentTaskConfig>('task')?.bashTaskTimeoutS).toBe(0);
    expect(config.get<AgentTaskConfig>('background')?.bashTaskTimeoutS).toBe(0);

    env[BASH_TASK_TIMEOUT_S_ENV] = '30';
    expect(config.get<AgentTaskConfig>('task')?.bashTaskTimeoutS).toBe(30);

    disposables.dispose();
  });

  it('applies the print policy env bindings and ignores invalid values', async () => {
    const env: Record<string, string> = {};
    const { config, disposables } = await createTaskConfig(env);

    env[PRINT_WAIT_CEILING_S_ENV] = '0';
    expect(config.get<AgentTaskConfig>('task')?.printWaitCeilingS).toBeUndefined();
    env[PRINT_WAIT_CEILING_S_ENV] = '3600';
    expect(config.get<AgentTaskConfig>('task')?.printWaitCeilingS).toBe(3600);

    env[PRINT_MAX_TURNS_ENV] = 'abc';
    expect(config.get<AgentTaskConfig>('task')?.printMaxTurns).toBeUndefined();
    env[PRINT_MAX_TURNS_ENV] = '7';
    expect(config.get<AgentTaskConfig>('task')?.printMaxTurns).toBe(7);

    env[PRINT_BACKGROUND_MODE_ENV] = 'wait';
    expect(resolvePrintBackgroundMode(config)).toBe('steer');
    env[PRINT_BACKGROUND_MODE_ENV] = 'exit';
    expect(resolvePrintBackgroundMode(config)).toBe('exit');
    env[PRINT_BACKGROUND_MODE_ENV] = ' drain ';
    expect(resolvePrintBackgroundMode(config)).toBe('drain');

    disposables.dispose();
  });

  it('lets the print policy env bindings override the config values', async () => {
    const env: Record<string, string> = {
      [PRINT_BACKGROUND_MODE_ENV]: 'exit',
      [PRINT_WAIT_CEILING_S_ENV]: '3600',
    };
    const { config, disposables } = await createTaskConfig(
      env,
      '[task]\nprint_background_mode = "drain"\nprint_wait_ceiling_s = 60\n',
    );

    expect(resolvePrintBackgroundMode(config)).toBe('exit');
    expect(resolveAgentTaskConfig(config)?.printWaitCeilingS).toBe(3600);

    disposables.dispose();
  });

  it('ignores unsafe integers without discarding sibling env bindings', async () => {
    const env: Record<string, string> = {
      [BASH_TASK_TIMEOUT_S_ENV]: '9007199254740992',
      [PRINT_WAIT_CEILING_S_ENV]: '9007199254740992',
      [PRINT_BACKGROUND_MODE_ENV]: 'exit',
    };
    const { config, disposables } = await createTaskConfig(env);

    expect(config.get<AgentTaskConfig>('task')?.bashTaskTimeoutS).toBeUndefined();
    expect(config.get<AgentTaskConfig>('task')?.printWaitCeilingS).toBeUndefined();
    expect(resolvePrintBackgroundMode(config)).toBe('exit');

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
    expect(resolveSwarmTimeoutMs(config)).toBe(0);
    expect(config.inspect('task').memoryValue).toMatchObject({ bashTaskTimeoutS: 0 });
    expect(config.inspect(LOOP_CONTROL_SECTION).memoryValue).toMatchObject({
      maxStepsPerTurn: 0,
    });
    expect(config.inspect('subagent').memoryValue).toMatchObject({ timeoutMs: 0 });
    expect(config.inspect('swarm').memoryValue).toMatchObject({ timeoutMs: 0 });

    disposables.dispose();
  });

  it('does not override keys the user set explicitly', async () => {
    const { config, disposables } = await createConfig(
      {},
      '[task]\nbash_task_timeout_s = 30\n\n' +
        '[loop_control]\nmax_steps_per_turn = 7\n\n' +
        '[subagent]\ntimeout_ms = 5000\n\n' +
        '[swarm]\ntimeout_ms = 6000\n',
    );

    await applyPrintModeConfigDefaults(config);

    expect(resolveAgentTaskConfig(config)?.bashTaskTimeoutS).toBe(30);
    expect(config.get<LoopControl>(LOOP_CONTROL_SECTION)?.maxStepsPerTurn).toBe(7);
    expect(resolveSubagentTimeoutMs(config)).toBe(5000);
    expect(resolveSwarmTimeoutMs(config)).toBe(6000);
    expect(config.inspect('task').memoryValue).toBeUndefined();
    expect(config.inspect(LOOP_CONTROL_SECTION).memoryValue).toBeUndefined();
    expect(config.inspect('subagent').memoryValue).toBeUndefined();
    expect(config.inspect('swarm').memoryValue).toBeUndefined();

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

  it('does not override keys set via env bindings', async () => {
    const { config, disposables } = await createConfig({
      [BASH_TASK_TIMEOUT_S_ENV]: '30',
    });

    await applyPrintModeConfigDefaults(config);

    expect(resolveAgentTaskConfig(config)?.bashTaskTimeoutS).toBe(30);
    expect(config.inspect('task').memoryValue).toBeUndefined();

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

  it('does not override the swarm timeout env override', async () => {
    const env: Record<string, string> = { [SWARM_TIMEOUT_ENV]: '3000' };
    const { config, disposables } = await createConfig(env);

    await applyPrintModeConfigDefaults(config);

    expect(resolveSwarmTimeoutMs(config)).toBe(3000);

    disposables.dispose();
  });
});

describe('swarm config section', () => {
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

    expect(resolveSwarmTimeoutMs(config)).toBe(DEFAULT_SWARM_TIMEOUT_MS);

    env[SWARM_TIMEOUT_ENV] = 'abc';
    expect(resolveSwarmTimeoutMs(config)).toBe(DEFAULT_SWARM_TIMEOUT_MS);

    env[SWARM_TIMEOUT_ENV] = '3000';
    expect(resolveSwarmTimeoutMs(config)).toBe(3000);

    disposables.dispose();
  });

  it('reads timeout_ms from config.toml and lets the env var win', async () => {
    const env: Record<string, string> = {};
    const { config, disposables } = await createConfig(env, '[swarm]\ntimeout_ms = 5000\n');
    expect(resolveSwarmTimeoutMs(config)).toBe(5000);

    env[SWARM_TIMEOUT_ENV] = '7000';
    expect(resolveSwarmTimeoutMs(config)).toBe(7000);

    disposables.dispose();
  });

  it('does not fall back to [subagent] timeout_ms', async () => {
    const { config, disposables } = await createConfig({}, '[subagent]\ntimeout_ms = 5000\n');

    expect(resolveSwarmTimeoutMs(config)).toBe(DEFAULT_SWARM_TIMEOUT_MS);

    disposables.dispose();
  });

  it('restores the env-owned timeout to the raw value on set() while the env var is set', async () => {
    const env: Record<string, string> = { [SWARM_TIMEOUT_ENV]: '7000' };
    const { config, disposables } = await createConfig(env, '[swarm]\ntimeout_ms = 5000\n');

    await config.set(SWARM_SECTION, { timeoutMs: 7000 });

    expect(resolveSwarmTimeoutMs(config)).toBe(7000);
    expect(config.inspect<SwarmConfig>(SWARM_SECTION).userValue).toEqual({
      timeoutMs: 5000,
    });

    disposables.dispose();
  });

  it('clears the raw section when stripping removes the last persisted field', async () => {
    const env: Record<string, string> = { [SWARM_TIMEOUT_ENV]: '7000' };
    const { config, disposables } = await createConfig(env);

    await config.set(SWARM_SECTION, { timeoutMs: 7000 });

    expect(resolveSwarmTimeoutMs(config)).toBe(7000);
    expect(config.inspect<SwarmConfig>(SWARM_SECTION).userValue).toBeUndefined();

    delete env[SWARM_TIMEOUT_ENV];
    expect(config.get<SwarmConfig>(SWARM_SECTION)).toEqual({
      timeoutMs: DEFAULT_SWARM_TIMEOUT_MS,
    });

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
    return { config, disposables, storage };
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

    await config.set(SUBAGENT_SECTION, { timeoutMs: 7000 });

    expect(resolveSubagentTimeoutMs(config)).toBe(7000);
    expect(config.inspect<SubagentConfig>(SUBAGENT_SECTION).userValue).toEqual({
      timeoutMs: 5000,
    });

    disposables.dispose();
  });

  it('clears the raw section when stripping removes the last persisted field', async () => {
    const env: Record<string, string> = { [SUBAGENT_TIMEOUT_ENV]: '7000' };
    const { config, disposables } = await createConfig(env);

    await config.set(SUBAGENT_SECTION, { timeoutMs: 7000 });

    expect(resolveSubagentTimeoutMs(config)).toBe(7000);
    expect(config.inspect<SubagentConfig>(SUBAGENT_SECTION).userValue).toBeUndefined();

    delete env[SUBAGENT_TIMEOUT_ENV];
    expect(config.get<SubagentConfig>(SUBAGENT_SECTION)).toEqual({
      timeoutMs: DEFAULT_SUBAGENT_TIMEOUT_MS,
    });

    disposables.dispose();
  });

  it('reads default_model and [secondary_model.models] from config.toml', async () => {
    const { config, disposables } = await createConfig(
      {},
      '[secondary_model]\ndefault_model = "provider/fast"\n\n[secondary_model.models]\n"provider/fast" = "fast and cheap"\n"provider/smart" = ""\n',
    );

    expect(config.get<SecondaryModelConfig>(SECONDARY_MODEL_SECTION)).toEqual({
      defaultModel: 'provider/fast',
      models: { 'provider/fast': 'fast and cheap', 'provider/smart': '' },
    });

    disposables.dispose();
  });

  it('resolves the spawn binding: pool default, explicit alias, inherit without pool', async () => {
    const own = { modelAlias: 'provider/main', thinkingLevel: 'medium' };

    const noPool = await createConfig({});
    expect(resolveSubagentBinding(noPool.config, own)).toEqual({
      model: 'provider/main',
      thinking: 'medium',
      modelSource: 'inherited',
    });
    expect(() => resolveSubagentBinding(noPool.config, own, 'primary')).toThrow(
      /Invalid model "primary": no \[secondary_model\] pool is configured/,
    );
    noPool.disposables.dispose();

    const pool = await createConfig(
      {},
      '[secondary_model]\ndefault_model = "provider/fast"\n\n[secondary_model.models]\n"provider/fast" = "fast and cheap"\n"provider/smart" = "hard tasks"\n',
    );
    expect(resolveSubagentBinding(pool.config, own)).toEqual({
      model: 'provider/fast',
      thinking: undefined,
      modelSource: 'secondary_pool',
    });
    expect(resolveSubagentBinding(pool.config, own, 'provider/smart')).toEqual({
      model: 'provider/smart',
      thinking: undefined,
      modelSource: 'secondary_pool',
    });
    expect(() => resolveSubagentBinding(pool.config, own, 'primary')).toThrow(
      'Invalid model "primary". Available models: provider/fast, provider/smart.',
    );
    pool.disposables.dispose();
  });

  it('treats a pool-less default_model as an implicit single-entry pool', async () => {
    const own = { modelAlias: 'provider/main', thinkingLevel: 'medium' };
    const { config, disposables } = await createConfig(
      {},
      '[secondary_model]\ndefault_model = "provider/fast"\n',
    );

    expect(resolveSubagentBinding(config, own)).toEqual({
      model: 'provider/fast',
      thinking: undefined,
      modelSource: 'secondary_pool',
    });
    expect(() => resolveSubagentBinding(config, own, 'primary')).toThrow(
      'Invalid model "primary". Available models: provider/fast.',
    );
    expect(() => resolveSubagentBinding(config, own, 'provider/smart')).toThrow(
      'Invalid model "provider/smart". Available models: provider/fast.',
    );

    disposables.dispose();
  });

  it('falls back to the legacy model key when no pool keys are set', async () => {
    const own = { modelAlias: 'provider/main', thinkingLevel: 'medium' };
    const { config, disposables } = await createConfig(
      {},
      '[secondary_model]\nmodel = "provider/fast"\ndefault_effort = "low"\n',
    );

    expect(config.get<SecondaryModelConfig>(SECONDARY_MODEL_SECTION)).toEqual({
      model: 'provider/fast',
      defaultEffort: 'low',
    });
    expect(resolveSubagentModelPool(config)).toEqual({
      defaultModel: 'provider/fast',
      models: { 'provider/fast': '' },
    });
    expect(resolveSubagentBinding(config, own)).toEqual({
      model: 'provider/fast',
      thinking: 'low',
      modelSource: 'secondary_pool',
    });
    expect(() => resolveSubagentBinding(config, own, 'provider/smart')).toThrow(
      'Invalid model "provider/smart". Available models: provider/fast.',
    );

    disposables.dispose();
  });

  it('lets default_model win over the legacy model key', async () => {
    const own = { modelAlias: 'provider/main', thinkingLevel: 'medium' };
    const { config, disposables } = await createConfig(
      {},
      '[secondary_model]\nmodel = "provider/slow"\ndefault_model = "provider/fast"\n',
    );

    expect(resolveSubagentBinding(config, own)).toEqual({
      model: 'provider/fast',
      thinking: undefined,
      modelSource: 'secondary_pool',
    });

    disposables.dispose();
  });

  it('does not let the legacy model key substitute for a pool table default_model', async () => {
    const own = { modelAlias: 'provider/main', thinkingLevel: 'medium' };
    const { config, disposables } = await createConfig(
      {},
      '[secondary_model]\nmodel = "provider/fast"\n\n[secondary_model.models]\n"provider/fast" = "fast and cheap"\n',
    );

    expect(() => resolveSubagentBinding(config, own)).toThrow(
      '[secondary_model].default_model is required when [secondary_model.models] is configured',
    );

    disposables.dispose();
  });

  it('ignores legacy recipe patch fields with a warning and keeps them on disk', async () => {
    const { config, disposables, storage } = await createConfig(
      {},
      '[secondary_model]\nmodel = "provider/fast"\ndefault_effort = "low"\nmax_output_size = 8192\ncapabilities = ["image_in"]\n',
    );

    expect(config.get<SecondaryModelConfig>(SECONDARY_MODEL_SECTION)).toEqual({
      model: 'provider/fast',
      defaultEffort: 'low',
    });
    expect(config.diagnostics()).toContainEqual({
      domain: SECONDARY_MODEL_SECTION,
      severity: 'warning',
      message: secondaryModelRemovedKeysMessage(['max_output_size', 'capabilities']),
    });

    await config.set(SECONDARY_MODEL_SECTION, { defaultModel: 'provider/fast' });
    expect(config.get<SecondaryModelConfig>(SECONDARY_MODEL_SECTION)?.defaultEffort).toBe('low');
    const onDisk = new TextDecoder().decode(await storage.read('', 'config.toml'));
    expect(onDisk).toContain('max_output_size = 8192');

    disposables.dispose();
  });

  it('binds [secondary_model].default_effort as the subagent thinking', async () => {
    const own = { modelAlias: 'provider/main', thinkingLevel: 'medium' };
    const { config, disposables } = await createConfig(
      {},
      '[secondary_model]\ndefault_model = "provider/fast"\ndefault_effort = "max"\n',
    );

    expect(resolveSubagentBinding(config, own)).toEqual({
      model: 'provider/fast',
      thinking: 'max',
      modelSource: 'secondary_pool',
    });

    disposables.dispose();
  });

  it('ignores the removed force key with a warning, keeping the pool semantics', async () => {
    const own = { modelAlias: 'provider/main', thinkingLevel: 'medium' };
    const lone = await createConfig({}, '[secondary_model]\ndefault_model = "provider/fast"\nforce = true\n');

    expect(lone.config.get<SecondaryModelConfig>(SECONDARY_MODEL_SECTION)).toEqual({
      defaultModel: 'provider/fast',
    });
    expect(lone.config.diagnostics()).toContainEqual({
      domain: SECONDARY_MODEL_SECTION,
      severity: 'warning',
      message: SECONDARY_MODEL_FORCE_REMOVED_MESSAGE,
    });
    expect(resolveSubagentBinding(lone.config, own)).toEqual({
      model: 'provider/fast',
      thinking: undefined,
      modelSource: 'secondary_pool',
    });
    lone.disposables.dispose();

    const table = await createConfig(
      {},
      '[secondary_model]\ndefault_model = "provider/fast"\nforce = true\n\n[secondary_model.models]\n"provider/fast" = "fast and cheap"\n"provider/smart" = ""\n',
    );
    expect(resolveSubagentBinding(table.config, own, 'provider/smart')).toEqual({
      model: 'provider/smart',
      thinking: undefined,
      modelSource: 'secondary_pool',
    });
    table.disposables.dispose();
  });

  it('rejects an alias outside the pool, listing the available models', async () => {
    const own = { modelAlias: 'provider/main', thinkingLevel: 'medium' };
    const { config, disposables } = await createConfig(
      {},
      '[secondary_model]\ndefault_model = "provider/fast"\n\n[secondary_model.models]\n"provider/fast" = "fast and cheap"\n"provider/smart" = "hard tasks"\n',
    );

    let caught: unknown;
    try {
      resolveSubagentBinding(config, own, 'provider/typo');
    } catch (error) {
      caught = error;
    }
    expect(isError2(caught)).toBe(true);
    expect((caught as Error2).code).toBe(ErrorCodes.CONFIG_INVALID);
    expect((caught as Error2).message).toBe(
      'Invalid model "provider/typo". Available models: provider/fast, provider/smart.',
    );

    disposables.dispose();
  });

  it('rejects a stray model choice when no pool is configured', async () => {
    const own = { modelAlias: 'provider/main', thinkingLevel: 'medium' };
    const { config, disposables } = await createConfig({});

    expect(() => resolveSubagentBinding(config, own, 'provider/fast')).toThrow(
      /Invalid model "provider\/fast": no \[secondary_model\] pool is configured/,
    );

    disposables.dispose();
  });

  it('preserves the coded error contract when adding subagent-model guidance', () => {
    const cause = new Error2(
      ErrorCodes.CONFIG_INVALID,
      'Model "provider/bad" is not configured in config.toml.',
      { details: { model: 'provider/bad' } },
    );

    const result = wrapSubagentModelError(cause, 'provider/bad', 'provider/main');

    expect(toErrorPayload(result)).toMatchObject({
      code: ErrorCodes.CONFIG_INVALID,
      message: expect.stringContaining('comes from [secondary_model.models]'),
      details: {
        model: 'provider/bad',
        subagentModel: 'provider/bad',
        subagentModelConfig: {
          section: 'secondary_model.models',
        },
      },
      cause: {
        code: ErrorCodes.CONFIG_INVALID,
        details: { model: 'provider/bad' },
      },
    });
  });

  it('passes through config-invalid failures that are not a missing bound alias', () => {
    const malformed = new Error2(
      ErrorCodes.CONFIG_INVALID,
      'Model "provider/pool" must declare a wire protocol (config: models.<id>.protocol).',
    );
    expect(wrapSubagentModelError(malformed, 'provider/pool', 'provider/main')).toBe(malformed);

    const unrelated = new Error2(
      ErrorCodes.CONFIG_INVALID,
      'Model "provider/other" is not configured in config.toml.',
      { details: { model: 'provider/other' } },
    );
    expect(wrapSubagentModelError(unrelated, 'provider/pool', 'provider/main')).toBe(unrelated);
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

    await config.set(MCP_SECTION, { startupTimeoutMs: 7000 });

    expect(config.get<McpSection | undefined>(MCP_SECTION)?.startupTimeoutMs).toBe(7000);
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

describe('config section collection fold (D12)', () => {
  const RUNTIME_SECTION = 'runtimeFoldDemo';
  const RUNTIME_NOTE_ENV = 'RUNTIME_FOLD_DEMO_NOTE';

  interface RuntimeFoldDemo {
    enabled: boolean;
    note?: string;
  }

  const RuntimeFoldDemoSchema: ConfigSchema<RuntimeFoldDemo> = {
    parse(value: unknown): RuntimeFoldDemo {
      const demo = value as RuntimeFoldDemo;
      if (typeof demo?.enabled !== 'boolean') {
        throw new TypeError('runtimeFoldDemo.enabled must be a boolean');
      }
      return demo;
    },
  };

  interface IRuntimeSectionContributor {
    readonly marker: string;
  }
  const IRuntimeSectionContributor = createDecorator<IRuntimeSectionContributor>(
    'test-runtime-section-contributor',
  );

  class RuntimeSectionContributor extends Service implements IRuntimeSectionContributor {
    readonly marker = 'runtime-section-contributor';
    constructor(contribution: ConfigSectionContribution) {
      super();
      this.provide(ConfigSectionContribution, contribution);
    }
  }

  function sectionContribution<T>(
    domain: string,
    schema: ConfigSchema<T>,
    options: RegisterSectionOptions<T> = {},
  ): ConfigSectionContribution {
    return {
      domain,
      schema: schema as ConfigSchema<unknown>,
      options: options as RegisterSectionOptions<unknown>,
    };
  }

  function provideContribution(
    ix: TestInstantiationService,
    contribution: ConfigSectionContribution,
  ): ProvideHandle {
    const handle = ix.provide(
      IRuntimeSectionContributor,
      new SyncDescriptor(RuntimeSectionContributor, [contribution] as never),
    );
    ix.invokeFunction((accessor) => accessor.get(IRuntimeSectionContributor));
    return handle;
  }

  function setupFold(env: Record<string, string>) {
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg', env));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    return { disposables, ix, storage };
  }

  it('activates a runtime-provided section: defaults, env bindings and validation apply', async () => {
    const env: Record<string, string> = {};
    const { disposables, ix } = setupFold(env);
    const registry = ix.get(IConfigRegistry);
    const config = ix.get(IConfigService);
    await config.ready;
    expect(registry.getSection(RUNTIME_SECTION)).toBeUndefined();

    provideContribution(
      ix,
      sectionContribution(RUNTIME_SECTION, RuntimeFoldDemoSchema, {
        defaultValue: { enabled: true },
        env: { note: RUNTIME_NOTE_ENV },
      }),
    );

    expect(registry.getSection(RUNTIME_SECTION)).toBeDefined();
    expect(config.get<RuntimeFoldDemo>(RUNTIME_SECTION)).toEqual({ enabled: true });
    env[RUNTIME_NOTE_ENV] = 'from-env';
    expect(config.get<RuntimeFoldDemo>(RUNTIME_SECTION)).toEqual({
      enabled: true,
      note: 'from-env',
    });
    delete env[RUNTIME_NOTE_ENV];
    expect(config.get<RuntimeFoldDemo>(RUNTIME_SECTION)).toEqual({ enabled: true });

    await config.set(RUNTIME_SECTION, { enabled: false }, ConfigTarget.Memory);
    expect(config.get<RuntimeFoldDemo>(RUNTIME_SECTION)).toEqual({ enabled: false });
    await expect(
      config.set(RUNTIME_SECTION, { enabled: 'nope' }, ConfigTarget.Memory),
    ).rejects.toThrow('enabled');

    disposables.dispose();
  });

  it('withdraws the section when the provider dies; TOML values survive, builtins untouched', async () => {
    const env: Record<string, string> = {};
    const { disposables, ix, storage } = setupFold(env);
    const config = ix.get(IConfigService);
    await config.ready;
    const registry = ix.get(IConfigRegistry);
    const builtinSection = registry.getSection(DEFAULT_PERMISSION_MODE_SECTION);

    const handle = provideContribution(
      ix,
      sectionContribution(RUNTIME_SECTION, RuntimeFoldDemoSchema, {
        defaultValue: { enabled: true },
      }),
    );
    await config.set(RUNTIME_SECTION, { enabled: false, note: 'kept' }, ConfigTarget.User);
    expect(config.get<RuntimeFoldDemo>(RUNTIME_SECTION)).toEqual({
      enabled: false,
      note: 'kept',
    });

    handle.dispose();
    await ix.cascade.whenIdle();

    expect(registry.getSection(RUNTIME_SECTION)).toBeUndefined();
    const persisted = await storage.read('', 'config.toml');
    expect(new TextDecoder().decode(persisted)).toContain('runtime_fold_demo');
    expect(config.get<RuntimeFoldDemo>(RUNTIME_SECTION)).toEqual({
      enabled: false,
      note: 'kept',
    });
    expect(registry.getSection(DEFAULT_PERMISSION_MODE_SECTION)).toBe(builtinSection);
    expect(registry.validate(DEFAULT_PERMISSION_MODE_SECTION, 'auto')).toBe('auto');

    disposables.dispose();
  });

  it('logs — never throws — a record colliding with a builtin section, and the builtin survives', async () => {
    const env: Record<string, string> = {};
    const { disposables, ix } = setupFold(env);
    const config = ix.get(IConfigService);
    await config.ready;
    const registry = ix.get(IConfigRegistry);
    const builtinSection = registry.getSection(DEFAULT_PERMISSION_MODE_SECTION);

    const logged: unknown[] = [];
    setUnexpectedErrorHandler((err) => logged.push(err));
    try {
      const handle = provideContribution(
        ix,
        sectionContribution(DEFAULT_PERMISSION_MODE_SECTION, { parse: () => 'rogue' }),
      );
      expect(logged).toHaveLength(1);
      expect(String(logged[0])).toContain('already registered');
      expect(registry.getSection(DEFAULT_PERMISSION_MODE_SECTION)).toBe(builtinSection);
      expect(registry.validate(DEFAULT_PERMISSION_MODE_SECTION, 'auto')).toBe('auto');

      handle.dispose();
      await ix.cascade.whenIdle();

      expect(registry.getSection(DEFAULT_PERMISSION_MODE_SECTION)).toBe(builtinSection);
    } finally {
      resetUnexpectedErrorHandler();
      disposables.dispose();
    }
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

describe('ConfigService replaceSections', () => {
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
    const setTextSpy = vi.spyOn(store, 'setText');

    await config.replaceSections({
      [PROVIDERS_SECTION]: { acme: { type: 'openai', apiKey: 'sk-acme-2' } },
      [MODELS_SECTION]: { 'acme/m2': { provider: 'acme', model: 'm2', maxContextSize: 2000 } },
      [DEFAULT_MODEL_SECTION]: undefined,
      [THINKING_SECTION]: undefined,
    });

    expect(setSpy.mock.calls.length + setTextSpy.mock.calls.length).toBe(1);
    expect(config.get<Record<string, unknown>>(PROVIDERS_SECTION)).toEqual({
      acme: { type: 'openai', apiKey: 'sk-acme-2' },
    });
    expect(config.get<Record<string, unknown>>(MODELS_SECTION)).toEqual({
      'acme/m2': { provider: 'acme', model: 'm2', maxContextSize: 2000 },
    });
    expect(config.get(DEFAULT_MODEL_SECTION)).toBeUndefined();
    expect(config.get(THINKING_SECTION)).toEqual({});
    expect(config.inspect(DEFAULT_MODEL_SECTION).userValue).toBeUndefined();
    expect(config.inspect(THINKING_SECTION).userValue).toEqual({});

    disposables.dispose();
  });

  it('round-trips model upgrade metadata using snake_case TOML fields', async () => {
    const { config, disposables, storage } = await createSectionsConfig();
    await config.replaceSections({
      [MODELS_SECTION]: {
        'acme/m1': {
          provider: 'acme',
          model: 'm1',
          maxContextSize: 1000,
          upgrade: {
            model: 'm2',
            migrationMarkdown: 'Use {model_to}',
            retirementAt: '2030-01-01T00:00:00Z',
          },
        },
      },
    });

    const onDisk = new TextDecoder().decode(await storage.read('', 'config.toml'));
    expect(onDisk).toContain('migration_markdown = "Use {model_to}"');
    expect(onDisk).toContain('retirement_at = "2030-01-01T00:00:00Z"');
    expect(onDisk).not.toContain('migrationMarkdown');
    expect(onDisk).not.toContain('retirementAt');

    await config.reload();
    const models = config.get<Record<string, { upgrade?: unknown }>>(MODELS_SECTION);
    expect(models['acme/m1']?.upgrade).toEqual({
      model: 'm2',
      migrationMarkdown: 'Use {model_to}',
      retirementAt: '2030-01-01T00:00:00Z',
    });
    disposables.dispose();
  });

  it('removes withdrawn upgrade metadata instead of merging it', async () => {
    const { config, disposables, storage } = await createSectionsConfig();
    const model = {
      provider: 'acme',
      model: 'm1',
      maxContextSize: 1000,
    };
    await config.replaceSections({
      [MODELS_SECTION]: {
        'acme/m1': {
          ...model,
          upgrade: {
            model: 'm2',
            migrationMarkdown: 'Use {model_to}',
            retirementAt: '2030-01-01T00:00:00Z',
          },
        },
      },
    });
    await config.replaceSections({
      [MODELS_SECTION]: {
        'acme/m1': {
          ...model,
          upgrade: { model: 'm2', migrationMarkdown: 'Use {model_to}' },
        },
      },
    });

    const withoutRetirement = new TextDecoder().decode(await storage.read('', 'config.toml'));
    expect(withoutRetirement).not.toContain('retirement_at');

    await config.replaceSections({ [MODELS_SECTION]: { 'acme/m1': model } });
    const withoutUpgrade = new TextDecoder().decode(await storage.read('', 'config.toml'));
    expect(withoutUpgrade).not.toContain('[models."acme/m1".upgrade]');
    disposables.dispose();
  });

  it('can replace selected domains exactly without touching other domains', async () => {
    const toml = [
      '[providers.acme]',
      'type = "openai"',
      'api_key = "sk-old"',
      'future_field = 1',
      '',
      '[providers.other]',
      'type = "openai"',
      'api_key = "sk-other"',
      'future_provider_field = 2',
      '',
      '[models."acme/m1"]',
      'provider = "acme"',
      'model = "m1"',
      'max_context_size = 1000',
      'beta_api = true',
      '',
      '[future]',
      'keep = true',
      '',
    ].join('\n');
    const { config, disposables, store, storage } = await createSectionsConfig(toml);
    const setSpy = vi.spyOn(store, 'set');
    const setTextSpy = vi.spyOn(store, 'setText');

    await config.replaceSections(
      {
        [PROVIDERS_SECTION]: {
          acme: { type: 'openai', apiKey: 'sk-new' },
          other: { type: 'openai', apiKey: 'sk-other' },
          stale: { type: 'openai', apiKey: 'sk-stale' },
        },
        [MODELS_SECTION]: {
          'acme/m1': { provider: 'acme', model: 'm1', maxContextSize: 2000 },
        },
      },
      undefined,
      {
        preserveUnknown: false,
        exactKeys: {
          [PROVIDERS_SECTION]: ['acme'],
          [MODELS_SECTION]: ['acme/m1'],
        },
      },
    );

    expect(setSpy.mock.calls.length + setTextSpy.mock.calls.length).toBe(1);
    const onDisk = new TextDecoder().decode(await storage.read('', 'config.toml'));
    expect(onDisk).not.toContain('future_field');
    expect(onDisk).not.toContain('beta_api');
    expect(onDisk).not.toContain('[providers.stale]');
    expect(onDisk).toContain('[providers.other]');
    expect(onDisk).toContain('future_provider_field = 2');
    expect(onDisk).toContain('[future]');
    expect(onDisk).toContain('keep = true');
    disposables.dispose();
  });

  it('rejects an atomic replacement when a guarded user value changed on disk', async () => {
    const { config, disposables, store, storage } = await createSectionsConfig();
    const setSpy = vi.spyOn(store, 'set');
    const setTextSpy = vi.spyOn(store, 'setText');
    const external = SEED_TOML.replace(
      'default_model = "acme/m1"',
      'default_model = "other/m1"',
    );
    await storage.write('', 'config.toml', new TextEncoder().encode(external));

    await expect(
      config.replaceSections(
        {
          [PROVIDERS_SECTION]: { acme: { type: 'openai', apiKey: 'sk-new' } },
          [DEFAULT_MODEL_SECTION]: undefined,
        },
        undefined,
        { expectedValues: { [DEFAULT_MODEL_SECTION]: 'acme/m1' } },
      ),
    ).rejects.toThrow(/changed.*retry/i);

    expect(setSpy).not.toHaveBeenCalled();
    expect(setTextSpy).not.toHaveBeenCalled();
    expect(new TextDecoder().decode(await storage.read('', 'config.toml'))).toBe(external);
    disposables.dispose();
  });

  it('treats null as clear — the wire encoding JSON transports use for undefined', async () => {
    const { config, disposables, store } = await createSectionsConfig();
    const setSpy = vi.spyOn(store, 'set');
    const setTextSpy = vi.spyOn(store, 'setText');

    await config.replaceSections({
      [DEFAULT_MODEL_SECTION]: null,
      [PROVIDERS_SECTION]: { acme: { type: 'openai', apiKey: 'sk-acme-2' } },
    });

    expect(setSpy.mock.calls.length + setTextSpy.mock.calls.length).toBe(1);
    expect(config.get(DEFAULT_MODEL_SECTION)).toBeUndefined();
    expect(config.inspect(DEFAULT_MODEL_SECTION).userValue).toBeUndefined();
    expect(config.get<Record<string, unknown>>(PROVIDERS_SECTION)).toEqual({
      acme: { type: 'openai', apiKey: 'sk-acme-2' },
    });

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

    expect(snapshotDuringFirstEvent).toEqual({
      providers: { acme: { type: 'openai', apiKey: 'sk-acme-2' } },
      models: { 'acme/m2': { provider: 'acme', model: 'm2', maxContextSize: 2000 } },
      defaultModel: undefined,
      thinking: {},
    });
    expect([...domains].toSorted()).toEqual(
      [PROVIDERS_SECTION, MODELS_SECTION, DEFAULT_MODEL_SECTION, THINKING_SECTION].toSorted(),
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

describe('ConfigService persistence guards', () => {
  async function createGuardedConfig(toml: string, env: NodeJS.ProcessEnv = {}) {
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    await storage.write('', 'config.toml', new TextEncoder().encode(toml));
    ix.stub(ILogService, stubLog());
    ix.stub(IBootstrapService, stubBootstrap('/tmp/kimi-cfg-guards', env));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    const config = ix.get(IConfigService);
    await config.ready;
    return { config, disposables, storage };
  }

  async function overwrite(storage: InMemoryStorageService, toml: string): Promise<void> {
    await storage.write('', 'config.toml', new TextEncoder().encode(toml));
  }

  async function stored(storage: InMemoryStorageService): Promise<string> {
    const bytes = await storage.read('', 'config.toml');
    return new TextDecoder().decode(bytes);
  }

  async function expectPersistBlocked(promise: Promise<unknown>): Promise<void> {
    const error = await promise.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(isError2(error)).toBe(true);
    expect((error as Error2).code).toBe(ErrorCodes.CONFIG_PERSIST_BLOCKED);
  }

  it('refuses to persist when the initial load fails and keeps the file untouched', async () => {
    const broken = '[providers\nbroken';
    const { config, disposables, storage } = await createGuardedConfig(broken);

    expect(config.diagnostics().some((d) => d.severity === 'error')).toBe(true);
    expect(config.get(PROVIDERS_SECTION)).toEqual({});
    expect(config.get<CronConfig>(CRON_SECTION)).toEqual(DEFAULT_CRON_CONFIG);

    await expectPersistBlocked(config.set(THINKING_SECTION, { enabled: true }));
    await expectPersistBlocked(config.replace(THINKING_SECTION, { enabled: true }));
    await expectPersistBlocked(config.replaceSections({ [THINKING_SECTION]: { enabled: true } }));

    expect(await stored(storage)).toBe(broken);

    await config.set(THINKING_SECTION, { enabled: true }, ConfigTarget.Memory);
    expect(config.get<ThinkingConfig>(THINKING_SECTION)).toEqual({ enabled: true });

    disposables.dispose();
  });

  it('keeps last-known-good values when a reload hits a broken file, and recovers after the file is fixed', async () => {
    const { config, disposables, storage } = await createGuardedConfig(
      '[providers.acme]\ntype = "openai"\napi_key = "sk-acme"\n',
    );
    expect(config.get<Record<string, unknown>>(PROVIDERS_SECTION)).toEqual({
      acme: { type: 'openai', apiKey: 'sk-acme' },
    });

    await overwrite(storage, '= broken =');
    await config.reload();

    expect(config.get<Record<string, unknown>>(PROVIDERS_SECTION)).toEqual({
      acme: { type: 'openai', apiKey: 'sk-acme' },
    });
    await expectPersistBlocked(config.set(THINKING_SECTION, { enabled: true }));
    expect(await stored(storage)).toBe('= broken =');

    await overwrite(storage, '[providers.beta]\ntype = "openai"\napi_key = "sk-beta"\n');
    await config.reload();

    expect(config.get<Record<string, unknown>>(PROVIDERS_SECTION)).toEqual({
      beta: { type: 'openai', apiKey: 'sk-beta' },
    });
    await config.set(THINKING_SECTION, { enabled: true });
    expect(config.get<ThinkingConfig>(THINKING_SECTION)).toEqual({ enabled: true });

    disposables.dispose();
  });

  it('merges external edits observed at persist time instead of clobbering them', async () => {
    const { config, disposables, storage } = await createGuardedConfig(
      'default_model = "acme/m1"\n\n[providers.acme]\ntype = "openai"\napi_key = "sk-acme"\n',
    );

    await overwrite(
      storage,
      'default_model = "acme/m1"\n\n[providers.acme]\ntype = "openai"\napi_key = "sk-acme-2"\n\n[providers.beta]\ntype = "openai"\napi_key = "sk-beta"\n',
    );

    const changed: string[] = [];
    config.onDidSectionChange((e) => changed.push(e.domain));
    await config.set(THINKING_SECTION, { enabled: true });

    const doc = await stored(storage);
    expect(doc).toContain('sk-acme-2');
    expect(doc).toContain('[providers.beta]');
    expect(doc).toContain('[thinking]');
    expect(config.get<Record<string, unknown>>(PROVIDERS_SECTION)).toEqual({
      acme: { type: 'openai', apiKey: 'sk-acme-2' },
      beta: { type: 'openai', apiKey: 'sk-beta' },
    });
    expect(config.get<ThinkingConfig>(THINKING_SECTION)).toEqual({ enabled: true });
    expect(changed).toContain(PROVIDERS_SECTION);
    expect(changed).toContain(THINKING_SECTION);

    disposables.dispose();
  });

  it('honors an external delete instead of resurrecting the in-memory copy', async () => {
    const { config, disposables, storage } = await createGuardedConfig(
      '[providers.acme]\ntype = "openai"\napi_key = "sk-acme"\n',
    );

    await storage.delete('', 'config.toml');
    await config.set(THINKING_SECTION, { enabled: true });

    const doc = await stored(storage);
    expect(doc).toContain('[thinking]');
    expect(doc).not.toContain('[providers.acme]');
    expect(config.inspect(PROVIDERS_SECTION).userValue).toBeUndefined();

    disposables.dispose();
  });

  it('rebases a set() merge onto external edits of the same section', async () => {
    const { config, disposables, storage } = await createGuardedConfig(
      '[providers.acme]\ntype = "openai"\napi_key = "sk-acme"\n',
    );

    await overwrite(
      storage,
      '[providers.acme]\ntype = "openai"\napi_key = "sk-acme"\n\n[providers.beta]\ntype = "openai"\napi_key = "sk-beta"\n',
    );
    await config.set(PROVIDERS_SECTION, { gamma: { type: 'openai', apiKey: 'sk-gamma' } });

    const doc = await stored(storage);
    expect(doc).toContain('[providers.beta]');
    expect(doc).toContain('[providers.gamma]');
    expect(config.get<Record<string, unknown>>(PROVIDERS_SECTION)).toEqual({
      acme: { type: 'openai', apiKey: 'sk-acme' },
      beta: { type: 'openai', apiKey: 'sk-beta' },
      gamma: { type: 'openai', apiKey: 'sk-gamma' },
    });

    disposables.dispose();
  });

  it('restores env-masked values from the freshly re-read file instead of the stale snapshot', async () => {
    const { config, disposables, storage } = await createGuardedConfig(
      'default_model = "acme/m1"\n\n[providers.acme]\ntype = "openai"\napi_key = "sk-acme"\n\n[models."acme/m1"]\nprovider = "acme"\nmodel = "m1"\n',
      { KIMI_MODEL_NAME: 'env-model' },
    );
    expect(config.get(DEFAULT_MODEL_SECTION)).toBe('__kimi_env_model__');

    await overwrite(
      storage,
      'default_model = "acme/m2"\n\n[providers.acme]\ntype = "openai"\napi_key = "sk-acme"\n\n[models."acme/m2"]\nprovider = "acme"\nmodel = "m2"\n',
    );
    await config.replace(DEFAULT_MODEL_SECTION, config.get(DEFAULT_MODEL_SECTION));

    const doc = await stored(storage);
    expect(doc).toContain('default_model = "acme/m2"');
    expect(doc).not.toContain('default_model = "acme/m1"');

    disposables.dispose();
  });

  it('keeps the in-memory snapshots untouched when a write fails validation', async () => {
    const { config, disposables, storage } = await createGuardedConfig(
      '[thinking]\nenabled = true\n',
    );

    await overwrite(storage, '[thinking]\nenabled = false\n');
    await expect(config.set(THINKING_SECTION, { enabled: 'yes' })).rejects.toThrow();

    expect(config.inspect(THINKING_SECTION).userValue).toEqual({ enabled: true });
    expect(await stored(storage)).toBe('[thinking]\nenabled = false\n');

    disposables.dispose();
  });
});
