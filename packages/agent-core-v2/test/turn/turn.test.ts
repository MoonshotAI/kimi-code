import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { join } from 'pathe';
import { setTimeout as delay } from 'node:timers/promises';

import { type ModelCapability } from '#/app/llmProtocol/capability';
import { APIConnectionError, APIEmptyResponseError, APIStatusError, APITimeoutError } from '#/app/llmProtocol/errors';
import { type ToolCall } from '#/app/llmProtocol/message';
import type { ChatProvider } from '#/app/llmProtocol/provider';
import { IProtocolAdapterRegistry } from '#/app/protocol/protocol';
import { describe, expect, it, vi } from 'vitest';

import { abortError, abortable } from '#/_base/utils/abort';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IOAuthService } from '#/app/auth/auth';
import { IAgentTelemetryContextService } from '#/app/telemetry/agentTelemetryContext';
import { ErrorCodes, KimiError } from '#/errors';
import { makeHookRunner } from '../externalHooks/runner-stub';
import type { ILogger as Logger, LogPayload } from '#/_base/log/log';
import { IAgentMcpService } from '#/agent/mcp/mcp';
import { McpConnectionManager } from '#/agent/mcp/connection-manager';
import { createVideoUploader, registerMediaTools } from '#/agent/media/registerMediaTools';
import { IAgentPermissionGate } from '#/agent/permissionGate/permissionGate';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentSwarmService } from '#/agent/swarm/swarm';
import { IAgentTurnService } from '#/agent/turn/turn';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import type { IProcess, ISessionProcessRunner } from '#/session/process/processRunner';
import type {
  SessionSwarmRunResult as QueuedSubagentRunResult,
  SessionSwarmTask as QueuedSubagentTask,
} from '#/session/swarm/sessionSwarm';
import { recordingTelemetry, type TelemetryRecord } from '../telemetry/stubs';
import { createFakeHostFs, createFakeProcessRunner } from '../tools/fixtures/fake-exec';
import {
  configServices,
  appServices,
  createCommandRunner,
  execEnvServices,
  logServices,
  mcpServices,
  swarmServices,
  testAgent,
  type TestAgentOptions,
  type TestAgentServiceOverride,
} from '../harness';
import { executeTool } from '../tools/fixtures/execute-tool';

type GenerateFn = NonNullable<TestAgentOptions['generate']>;

interface CapturedLogEntry {
  readonly level: 'error' | 'warn' | 'info' | 'debug';
  readonly message: string;
  readonly payload: LogPayload | undefined;
}

function captureLogs(): { logger: Logger; entries: CapturedLogEntry[] } {
  const entries: CapturedLogEntry[] = [];
  const capture =
    (level: CapturedLogEntry['level']) => (message: string, payload?: LogPayload) => {
      entries.push({ level, message, payload });
    };
  const logger: Logger = {
    error: capture('error'),
    warn: capture('warn'),
    info: capture('info'),
    debug: capture('debug'),
    child: () => logger,
  };
  return { logger, entries };
}

describe('Agent turn flow', () => {
  it('waits for MCP initial load before executing tools', async () => {
    const mcp = new McpConnectionManager();
    let resolveInitialLoad: () => void = () => {};
    const initialLoad = new Promise<void>((resolve) => {
      resolveInitialLoad = resolve;
    });
    const waitForInitialLoad = vi
      .spyOn(mcp, 'waitForInitialLoad')
      .mockImplementation((signal?: AbortSignal) =>
        signal === undefined ? initialLoad : abortable(initialLoad, signal),
    );
    const { runner, exec: execWithEnv } = createExecRunner('mcp-ready');
    const ctx = testAgent(mcpServices({ manager: mcp }), execEnvServices({ processRunner: runner }));
    ctx.get(IAgentMcpService);
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });
    ctx.mockNextResponse(
      { type: 'text', text: 'I will run Bash after MCP is ready.' },
      bashCallWithId('call_mcp_wait', 'printf mcp-ready'),
    );
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Wait for MCP' }] });
    await vi.waitFor(() => {
      expect(waitForInitialLoad).toHaveBeenCalledTimes(1);
    });

    expect(execWithEnv).not.toHaveBeenCalled();

    resolveInitialLoad();
    await ctx.untilTurnEnd();

    expect(execWithEnv).toHaveBeenCalledTimes(1);
  });

  it('cancels the turn while waiting for MCP initial load before tool execution', async () => {
    const mcp = new McpConnectionManager();
    const initialLoad = new Promise<void>(() => undefined);
    const waitForInitialLoad = vi
      .spyOn(mcp, 'waitForInitialLoad')
      .mockImplementation((signal?: AbortSignal) =>
        signal === undefined ? initialLoad : abortable(initialLoad, signal),
    );
    const { runner, exec: execWithEnv } = createExecRunner('should-not-run');
    const ctx = testAgent(mcpServices({ manager: mcp }), execEnvServices({ processRunner: runner }));
    ctx.get(IAgentMcpService);
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });
    ctx.mockNextResponse(
      { type: 'text', text: 'I will run Bash after MCP is ready.' },
      bashCallWithId('call_mcp_cancel', 'printf should-not-run'),
    );

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Cancel before MCP ready' }] });
    await vi.waitFor(() => {
      expect(waitForInitialLoad).toHaveBeenCalledTimes(1);
    });
    await ctx.rpc.cancel({ turnId: 0 });
    const events = await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'cancelled' }),
      }),
    );
    expect(execWithEnv).not.toHaveBeenCalled();
  });

  it('tracks turn_started and turn_interrupted telemetry', async () => {
    const records: TelemetryRecord[] = [];
    const ctx = testAgent({ telemetry: recordingTelemetry(records) });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello without login' }] });
    await ctx.untilTurnEnd();

    expect(records).toContainEqual({
      event: 'turn_started',
      properties: { mode: 'agent', protocol: 'kimi', provider_type: 'kimi' },
    });
    expect(records).toContainEqual({
      event: 'turn_interrupted',
      properties: { mode: 'agent', at_step: 1, protocol: 'kimi', provider_type: 'kimi' },
    });
    expect(records).toContainEqual(
      expect.objectContaining({
        event: 'turn_ended',
        properties: expect.objectContaining({
          mode: 'agent',
          reason: 'failed',
          protocol: 'kimi',
          provider_type: 'kimi',
        }),
      }),
    );
  });

  it('tags turn telemetry from the agent telemetry context', async () => {
    const records: TelemetryRecord[] = [];
    const ctx = testAgent({ telemetry: recordingTelemetry(records) });
    ctx.get(IAgentTelemetryContextService).set({ mode: 'plan' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello in plan mode' }] });
    await ctx.untilTurnEnd();

    expect(records).toContainEqual({
      event: 'turn_started',
      properties: { mode: 'plan', protocol: 'kimi', provider_type: 'kimi' },
    });
    expect(records).toContainEqual({
      event: 'turn_interrupted',
      properties: { mode: 'plan', at_step: 1, protocol: 'kimi', provider_type: 'kimi' },
    });
    expect(records).toContainEqual(
      expect.objectContaining({
        event: 'turn_ended',
        properties: expect.objectContaining({
          mode: 'plan',
          reason: 'failed',
          protocol: 'kimi',
          provider_type: 'kimi',
        }),
      }),
    );
  });

  it('tracks duplicate tool-call detection telemetry', async () => {
    const records: TelemetryRecord[] = [];
    const ctx = testAgent(execEnvServices({ processRunner: createCommandRunner('dup') }), {
      telemetry: recordingTelemetry(records),
    });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });
    records.length = 0;

    ctx.mockNextResponse(
      bashCallWithId('call_dup_1', 'printf dup'),
      bashCallWithId('call_dup_2', 'printf dup'),
    );
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run duplicates' }] });
    await ctx.untilTurnEnd();

    expect(records).toContainEqual({
      event: 'tool_call_dedupe_detected',
      properties: {
        turn_id: 0,
        step_no: 1,
        tool_call_id: 'call_dup_2',
        tool_name: 'Bash',
        dup_type: 'same_step',
        args_hash: expect.any(String),
      },
    });
    expect(records).toContainEqual({
      event: 'permission_policy_decision',
      properties: expect.objectContaining({
        policy_name: 'yolo-mode-approve',
        tool_name: 'Bash',
        permission_mode: 'yolo',
        decision: 'approve',
      }),
    });
  });

  it('tracks cross-step duplicate tool-call detection telemetry', async () => {
    const records: TelemetryRecord[] = [];
    const ctx = testAgent(execEnvServices({ processRunner: createCommandRunner('dup') }), {
      telemetry: recordingTelemetry(records),
    });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });
    records.length = 0;

    ctx.mockNextResponse(bashCallWithId('call_dup_1', 'printf dup'));
    ctx.mockNextResponse(bashCallWithId('call_dup_2', 'printf dup'));
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run duplicates across steps' }] });
    await ctx.untilTurnEnd();

    expect(records).toContainEqual({
      event: 'tool_call_dedupe_detected',
      properties: {
        turn_id: 0,
        step_no: 2,
        tool_call_id: 'call_dup_2',
        tool_name: 'Bash',
        dup_type: 'cross_step',
        args_hash: expect.any(String),
      },
    });
    expect(records).toContainEqual({
      event: 'tool_call',
      properties: expect.objectContaining({
        turn_id: 0,
        tool_call_id: 'call_dup_2',
        tool_name: 'Bash',
        outcome: 'success',
        duration_ms: expect.any(Number),
      }),
    });
  });

  it('fires PostToolUse for same-step dups with the original real output, not the dedupe placeholder', async () => {
    // Hook command asserts the dup's PostToolUse payload carries the real
    // stdout ('dup'), not the placeholder ('').
    const assertScript = [
      "let input = '';",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      '  const payload = JSON.parse(input);',
      "  if (typeof payload.tool_output === 'string' && payload.tool_output.includes('dup')) process.exit(0);",
      "  console.error('bad tool_output: ' + JSON.stringify(payload.tool_output));",
      '  process.exit(2);',
      '});',
    ].join('');
    const resolved: Array<[string, string, string]> = [];
    const hookEngine = makeHookRunner(
      [
        {
          event: 'PostToolUse',
          matcher: 'Bash',
          command: `node -e ${JSON.stringify(assertScript)}`,
        },
      ],
      {
        onResolved: (event, target, action) => {
          resolved.push([event, target, action]);
        },
      },
    );
    const ctx = testAgent(execEnvServices({ processRunner: createCommandRunner('dup') }), { hookEngine });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });

    ctx.mockNextResponse(
      bashCallWithId('call_dup_1', 'printf dup'),
      bashCallWithId('call_dup_2', 'printf dup'),
    );
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run duplicates' }] });
    await ctx.untilTurnEnd();

    await vi.waitFor(() => {
      expect(resolved).toEqual([
        ['PostToolUse', 'Bash', 'allow'],
        ['PostToolUse', 'Bash', 'allow'],
      ]);
    });
  });

  it('tracks failed tool-call telemetry with error taxonomy', async () => {
    const records: TelemetryRecord[] = [];
    const ctx = testAgent({ telemetry: recordingTelemetry(records) });
    ctx.configure();
    records.length = 0;

    ctx.mockNextResponse({
      type: 'function',
      id: 'call_missing',
      name: 'MissingTool',
      arguments: '{}',
    });
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Call a missing tool' }] });
    await ctx.untilTurnEnd();

    expect(records).toContainEqual({
      event: 'tool_call',
      properties: expect.objectContaining({
        turn_id: 0,
        tool_call_id: 'call_missing',
        tool_name: 'MissingTool',
        outcome: 'error',
        error_type: 'ToolNotFound',
        duration_ms: expect.any(Number),
      }),
    });
  });

  it('emits a failed turn and error when generation fails', async () => {
    const ctx = testAgent();
    ctx.configure();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Trigger generate failure' }] });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] turn.prompt                 { "input": [ { "type": "text", "text": "Trigger generate failure" } ], "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started                { "turnId": 0, "origin": { "kind": "user" } }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Trigger generate failure" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [emit] context.spliced             { "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Trigger generate failure" } ], "toolCalls": [], "origin": { "kind": "user" } } ] }
      [emit] turn.step.started           { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
      [wire] llm.tools_snapshot          { "hash": "11648f47860177e1e5af084aa9af31d519309a860df84eeb0864b1c050dc87ca", "tools": [ { "name": "Agent", "description": "Launch a subagent to handle a task. The subagent runs as a same-process loop instance with its own context and wire file. Delegating also keeps the bulk of intermediate file contents out of your own context — you get a conclusion back instead of a pile of dumps.\\n\\nWriting the prompt:\\n- The subagent starts with zero context — it has not seen this conversation. Brief it like a colleague who just walked into the room: state the goal, list what you already know, hand over the specifics.\\n- Lookups (read this file, run that test): put the exact path or command in the prompt. The subagent should not have to search for things you already know.\\n- Investigations (figure out X, find why Y): give the question, not prescribed steps — fixed steps become dead weight when the premise is wrong.\\n- Do not delegate understanding. If the task hinges on a file path or line number, find it yourself first and write it into the prompt.\\n\\nUsage notes:\\n- When the task continues earlier work a subagent already did, prefer resuming that agent (pass its \`resume\` id) over spawning a fresh instance — the resumed agent keeps its prior context.\\n- A subagent's result is only visible to you, not to the user. When the user needs to see what a subagent produced, summarize the relevant parts yourself in your own reply.\\n- Subagents use a fixed 30-minute timeout. If one times out, resume the same agent instead of starting over.\\n\\nWhen NOT to use Agent: skip delegation for trivial work you can do directly — reading a file whose path you already know, searching a small known set of files, or any task that takes only a step or two. Delegation has a context-handoff cost; it pays off only when the task is substantial enough to outweigh it.\\n\\nOnce a subagent is running, leave that scope to it: do not redo its searches or reads in parallel, and do not abandon it midway and finish the job manually. Both undo the context savings the delegation was meant to buy.\\n\\n\\nWhen \`run_in_background=true\`, the subagent runs detached from this turn. The completion arrives in a later turn as a synthetic user-role message containing its result — you do not need to poll, sleep, or check on its progress. Continue with other work or respond to the user. Never fabricate or predict what the result will say.\\n\\nDefault to a foreground subagent (omit \`run_in_background\`) when your next step needs its result — foreground hands the result straight back. Reach for \`run_in_background=true\` only when you have other work to do while it runs and do not need its result to proceed. Never launch in the background and then immediately wait on it (with \`TaskOutput block=true\`, sleeping, or otherwise): that just blocks the turn for no benefit — run it in the foreground instead.\\n\\n\\nAvailable agent types (pass via subagent_type):\\n- plan: Read-only implementation planning and architecture design. Use this agent when the parent agent needs a step-by-step implementation plan, key file identification, and architectural trade-off analysis before code changes are made.\\n  Tools: Read, ReadMediaFile, Glob, Grep, WebSearch, FetchURL\\n- agent: Default Kimi Code agent\\n  Tools: Read, Write, Edit, Grep, Glob, Bash, TaskList, TaskOutput, TaskStop, CronCreate, CronList, CronDelete, ReadMediaFile, TodoList, Skill, WebSearch, Agent, AgentSwarm, FetchURL, AskUserQuestion, EnterPlanMode, ExitPlanMode, CreateGoal, GetGoal, SetGoalBudget, UpdateGoal, mcp__*\\n- coder: General software engineering agent — the only subagent type with file-editing tools; use it for any delegated task that must modify code. Use this agent for non-trivial software engineering work that may require reading files, editing code, running commands, and returning a compact but technically complete summary to the parent agent.\\n  Tools: Agent, AgentSwarm, Bash, CronCreate, CronDelete, CronList, Edit, EnterPlanMode, ExitPlanMode, Glob, Grep, Read, ReadMediaFile, Skill, TaskList, TaskOutput, TaskStop, TodoList, WebSearch, FetchURL, Write, mcp__*\\n- explore: Fast codebase exploration with prompt-enforced read-only behavior. Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (e.g. \\"src/**/*.yaml\\"), search code for keywords (e.g. \\"database connection\\"), or answer questions about the codebase (e.g. \\"how does the auth module work?\\"). When calling this agent, specify the desired thoroughness level: \\"quick\\" for basic searches, \\"medium\\" for moderate exploration, or \\"thorough\\" for comprehensive analysis across multiple locations and naming conventions. Use this agent for any read-only exploration that will clearly require more than 3 search queries. Prefer launching multiple explore agents concurrently when investigating independent questions.\\n  Tools: Bash, Read, ReadMediaFile, Glob, Grep, WebSearch, FetchURL", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "prompt": { "type": "string", "description": "Full task prompt for the subagent" }, "description": { "type": "string", "description": "Short task description (3-5 words) for UI display" }, "subagent_type": { "description": "One of the available agent types (see \\"Available agent types\\" in this tool description). Defaults to \\"coder\\" when omitted.", "type": "string" }, "resume": { "description": "Optional agent ID to resume instead of creating a new instance. When set, do not also pass subagent_type — the resumed agent keeps its own type, and supplying both is rejected.", "type": "string" }, "run_in_background": { "description": "If true, return immediately without waiting for completion. Prefer false unless the task can run independently and there is a clear benefit to not waiting.", "type": "boolean" } }, "required": [ "prompt", "description" ], "additionalProperties": false } }, { "name": "AgentSwarm", "description": "Launch multiple subagents from one prompt template, existing agent resumes, or both.\\n\\nUse AgentSwarm when many subagents should run the same kind of task over different inputs. The placeholder is exactly \`{{item}}\`. For example, with \`prompt_template\` set to \`Review {{item}} for likely regressions.\` and \`items\` set to \`[\\"src/a.ts\\", \\"src/b.ts\\"]\`, AgentSwarm launches two new subagents with those two concrete prompts. For a few differently-shaped tasks, make separate \`Agent\` calls in one message instead.\\n\\nUse \`resume_agent_ids\` to continue subagents that already exist from earlier work, such as ones that failed or timed out: map each agent id to the prompt for that resumed subagent (usually \`continue\` if no extra information is needed). You may combine \`resume_agent_ids\` with \`items\` in the same call to resume existing subagents and launch new ones. Do not duplicate resumed work in \`items\`.\\n\\nEach of these is enforced — a violation is rejected before any subagent starts: provide at least 2 \`items\` unless you pass \`resume_agent_ids\`; whenever \`items\` are present, \`prompt_template\` is required and must contain \`{{item}}\`; and the filled-in prompts must be distinct (two items that expand to the same prompt are rejected).\\n\\nUse enough subagents to keep the work focused and parallel. AgentSwarm supports up to 128 subagents, and launches are queued automatically, so it is safe to split large tasks into many clear, independent items.\\n\\nIf \`AgentSwarm\` is called, that call must be the only tool call in the response.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "description": { "type": "string", "minLength": 1, "description": "Short description for the whole swarm." }, "subagent_type": { "description": "Subagent type used for every new subagent spawned from items; defaults to coder when omitted. Resumed subagents always keep their original type, so passing subagent_type together with resume_agent_ids is allowed — it only affects the item-based spawns.", "type": "string", "minLength": 1 }, "prompt_template": { "description": "Prompt template for each subagent. The {{item}} placeholder is replaced with each item value.", "type": "string", "minLength": 1 }, "items": { "description": "Values used to fill {{item}}. Each item launches one new subagent.", "maxItems": 128, "type": "array", "items": { "type": "string", "minLength": 1 } }, "resume_agent_ids": { "description": "Map of existing subagent agent_id to the prompt used to resume that subagent. These resumed subagents are launched before new item-based subagents.", "type": "object", "propertyNames": { "type": "string", "minLength": 1 }, "additionalProperties": { "type": "string", "minLength": 1 } } }, "required": [ "description" ], "additionalProperties": false } }, { "name": "AskUserQuestion", "description": "Use this tool when you need to ask the user questions with structured options during execution. This allows you to:\\n1. Collect user preferences or requirements before proceeding\\n2. Resolve ambiguous or underspecified instructions\\n3. Let the user decide between implementation approaches as you work\\n4. Present concrete options when multiple valid directions exist\\n\\n**When NOT to use:**\\n- When you can infer the answer from context — be decisive and proceed\\n- Trivial decisions that don't materially affect the outcome\\n\\nOverusing this tool interrupts the user's flow. Only use it when the user's input genuinely changes your next action.\\n\\n**Usage notes:**\\n- Users always have an \\"Other\\" option for custom input — don't create one yourself\\n- Use multi_select to allow multiple answers to be selected for a question\\n- Keep option labels concise (1-5 words), use descriptions for trade-offs and details\\n- Each question should have 2-4 meaningful, distinct options\\n- Question texts must be unique across the call, and option labels must be unique within each question\\n- You can ask 1-4 questions at a time; group related questions to minimize interruptions\\n- If you recommend a specific option, list it first and append \\"(Recommended)\\" to its label\\n- The result is JSON with an \`answers\` object keyed by question text; each value is the chosen option's label (comma-separated labels for multi_select, or the user's own words if they picked \\"Other\\"); if \`answers\` is empty and a \`note\` says the user dismissed it, they declined to answer — proceed with your best judgment and do not re-ask the same question\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "questions": { "minItems": 1, "maxItems": 4, "type": "array", "items": { "type": "object", "properties": { "question": { "type": "string", "minLength": 1, "description": "A specific, actionable question. End with '?'." }, "header": { "default": "", "description": "Short category tag (max 12 chars, e.g. 'Auth', 'Style').", "type": "string" }, "options": { "minItems": 2, "maxItems": 4, "type": "array", "items": { "type": "object", "properties": { "label": { "type": "string", "minLength": 1, "description": "Concise display text (1-5 words). If recommended, append '(Recommended)'." }, "description": { "default": "", "description": "Brief explanation of trade-offs or implications.", "type": "string" } }, "required": [ "label" ], "additionalProperties": false }, "description": "2-4 meaningful, distinct options. Do NOT include an 'Other' option — the system adds one automatically." }, "multi_select": { "default": false, "description": "Whether the user can select multiple options.", "type": "boolean" } }, "required": [ "question", "options" ], "additionalProperties": false }, "description": "The questions to ask the user (1-4 questions)." } }, "required": [ "questions" ], "additionalProperties": false } }, { "name": "Bash", "description": "Execute a \`bash\` command. Use this for shell semantics — pipes, env, processes, git, package managers, build/test runners, anything genuinely interactive or multi-step.\\n\\n**Translate these to a dedicated tool instead:**\\n- \`cat\` / \`head\` / \`tail\` (known path) → \`Read\`\\n- \`sed\` / \`awk\` (in-place edit) → \`Edit\`\\n- \`echo > file\` / \`cat <<EOF\` → \`Write\`\\n- \`find\` / recursive \`ls\` to locate files by name pattern → \`Glob\` (plain \`ls <known-directory>\` is fine for listing a directory)\\n- \`grep\` / \`rg\` (search file contents) → \`Grep\`\\n- \`echo\` / \`printf\` (talk to the user) → just output text directly\\n\\nThe dedicated tools render in the per-tool permission UI and keep raw stdout out of the conversation; that is why they are worth reaching for whenever one fits.\\n\\n**Output:**\\nThe stdout and stderr will be combined and returned as a string. The output may be truncated if it is too long. If the command exits non-zero, the output ends with a \`Command failed with exit code: N\` line; a command killed by its timeout or interrupted by the user ends with its own message instead.\\n\\nIf \`run_in_background=true\`, the command will be started as a background task and this tool will return a task ID instead of waiting for command completion. When doing that, you must provide a short \`description\`. Background commands default to a 600s timeout and \`timeout\` is capped at 86400s; set \`disable_timeout=true\` only when the task should run without a timeout. You will be automatically notified when the task completes. After starting one, default to returning control to the user instead of immediately waiting on it. Use \`TaskOutput\` for a non-blocking status/output snapshot, and only set \`block=true\` when you explicitly want to wait for completion. Use \`TaskStop\` only if the task must be cancelled. If a human user wants to inspect background tasks themselves, point them to the \`/tasks\` command, which opens an interactive panel; it has no subcommands.\\n\\n**Guidelines for safety and security:**\\n- Each shell tool call will be executed in a fresh shell environment. The shell variables, current working directory changes, and the shell history is not preserved between calls. To run a command in a particular directory, pass the \`cwd\` argument (or use absolute paths) rather than relying on a \`cd\` from an earlier call.\\n- The tool call will return after the command is finished. You shall not use this tool to execute an interactive command or a command that may run forever. For possibly long-running foreground commands, set the \`timeout\` argument in seconds. Foreground commands default to 60s and allow up to 300s.\\n- Avoid using \`..\` to access files or directories outside of the working directory.\\n- Avoid modifying files outside of the working directory unless explicitly instructed to do so.\\n- Never run commands that require superuser privileges unless explicitly instructed to do so.\\n\\n**Guidelines for efficiency:**\\n- Use \`&&\` to chain commands that genuinely depend on each other, e.g. \`npm install && npm test\`. Independent read-only commands (separate \`git show\`, \`ls\`, or status checks) should be issued as separate parallel Bash calls in one response, not chained into a single call — chaining serializes their execution and mixes their output. Do not stitch outputs together with \`echo\` separators.\\n- Use \`;\` to run commands sequentially regardless of success/failure\\n- Use \`||\` for conditional execution (run second command only if first fails)\\n- Use pipe operations (\`|\`) and redirections (\`>\`, \`>>\`) to chain input and output between commands\\n- Always quote file paths containing spaces with double quotes (e.g., cd \\"/path with spaces/\\")\\n- Compose multi-step logic in a single call with \`if\` / \`case\` / \`for\` / \`while\` control flows.\\n- Prefer \`run_in_background=true\` for long-running builds, tests, watchers, or servers when you need the conversation to continue before the command finishes.\\n\\n**Commands available:**\\nThe following common command categories are usually available. Availability still depends on the host, so when in doubt run \`which <command>\` first to confirm a command exists before relying on it.\\n- Navigation and inspection: \`ls\`, \`pwd\`, \`cd\`, \`stat\`, \`file\`, \`du\`, \`df\`, \`tree\`\\n- File and directory management: \`cp\`, \`mv\`, \`rm\`, \`mkdir\`, \`touch\`, \`ln\`, \`chmod\`, \`chown\`\\n- Text and data processing: \`wc\`, \`sort\`, \`uniq\`, \`cut\`, \`tr\`, \`diff\`, \`xargs\`\\n- Archives and compression: \`tar\`, \`gzip\`, \`gunzip\`, \`zip\`, \`unzip\`\\n- Networking and transfer: \`curl\`, \`wget\`, \`ping\`, \`ssh\`, \`scp\`\\n- Version control: \`git\`; for GitHub-hosted work (PRs, issues, CI runs, API queries) prefer the \`gh\` CLI when installed — it carries the user's GitHub auth and can return structured JSON\\n- Process and system: \`ps\`, \`kill\`, \`top\`, \`env\`, \`date\`, \`uname\`, \`whoami\`\\n- Language and package toolchains: \`node\`, \`npm\`, \`pnpm\`, \`yarn\`, \`python\`, \`pip\` (use whichever the project actually relies on)\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "command": { "type": "string", "minLength": 1, "description": "The command to execute." }, "cwd": { "description": "The working directory in which to run the command. When omitted, the command runs in the session's working directory.", "type": "string" }, "timeout": { "default": 60, "description": "Optional timeout in seconds for the command to execute. Foreground default 60s, max 300s. Background default 600s, max 86400s. Ignored for background commands when disable_timeout=true.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 }, "description": { "description": "A short description for the background task. Required when run_in_background is true.", "type": "string" }, "run_in_background": { "description": "Whether to run the command as a background task.", "type": "boolean" }, "disable_timeout": { "description": "If true, do not apply a timeout to the command. Only applies when run_in_background is true.", "type": "boolean" } }, "required": [ "command" ], "additionalProperties": false } }, { "name": "CreateGoal", "description": "Create a durable, structured goal that the runtime will pursue across multiple turns.\\n\\nCall \`CreateGoal\` only when:\\n\\n- the user explicitly asks you to start a goal or work autonomously toward an outcome, or\\n- a host goal-intake prompt asks you to create one.\\n\\nDo NOT create a goal for greetings, ordinary questions, or vague requests that lack a\\nverifiable completion condition. A goal needs a checkable end state.\\n\\nWhen the request is vague, ask the user for the missing completion criterion before creating\\nthe goal. If the user clearly insists after you warn them that the wording is vague or risky,\\nrespect that and create the goal.\\n\\nInclude a \`completionCriterion\` when the user provides one, or when it can be stated without\\ninventing new requirements. Keep \`objective\` concise; reference long task descriptions by file\\npath rather than pasting them.\\n\\nCreating a goal fails if one already exists, so use \`replace: true\` only when the user explicitly\\nwants to abandon the current goal and start a new one.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "objective": { "type": "string", "minLength": 1, "description": "The objective to pursue. Must have a verifiable end state." }, "completionCriterion": { "description": "How to verify the goal is complete. Include when the user provides one.", "type": "string" }, "replace": { "description": "Replace an existing active, paused, or blocked goal instead of failing.", "type": "boolean" } }, "required": [ "objective" ], "additionalProperties": false } }, { "name": "Edit", "description": "Perform exact replacements in existing files.\\n\\n- Edit is mandatory for every incremental change, especially small edits. DO NOT use Write or Bash \`sed\`.\\n- Read the target file before every Edit. DO NOT call Edit from memory, stale context, or a guessed \`old_string\`.\\n- Take \`old_string\` and \`new_string\` from the Read output view.\\n- Drop the line-number prefix and tab; match only file content.\\n- \`old_string\` must be unique unless \`replace_all\` is set.\\n- If \`old_string\` is ambiguous, add surrounding context. Use \`replace_all\` only when every occurrence should change — for example, renaming a symbol throughout the file.\\n- Multiple Edit calls may run in one response only when they do not target the same file.\\n- DO NOT issue consecutive Edit calls on the same file. A previous Edit can invalidate a later Edit's \`old_string\`, causing \`old_string not found\`. Read the file again before the next Edit.\\n- A write lock serializes same-file edits in response order, but serialization does not make stale \`old_string\` valid.\\n- For pure CRLF files, Read shows LF; use LF in \`old_string\` and \`new_string\`, and Edit writes CRLF back.\\n- For mixed endings or lone carriage returns, Read shows carriage returns as \\\\r; include actual \\\\r escapes in those positions.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to the text file to edit. Relative paths resolve against the working directory; a path outside the working directory must be absolute." }, "old_string": { "type": "string", "minLength": 1, "description": "Exact content to replace from the Read output view, without the line-number prefix. Use LF for pure CRLF files; use actual \\\\r escapes where Read shows \\\\r." }, "new_string": { "type": "string", "description": "Replacement text in the same Read output view. LF is written back as CRLF only for pure CRLF files." }, "replace_all": { "description": "Set true only when every occurrence of old_string should be replaced.", "type": "boolean" } }, "required": [ "path", "old_string", "new_string" ], "additionalProperties": false } }, { "name": "EnterPlanMode", "description": "Use this tool proactively when you're about to start a non-trivial implementation task.\\nGetting user sign-off on your approach via ExitPlanMode before writing code prevents wasted effort.\\n\\nUse it when ANY of these conditions apply:\\n\\n1. New Feature Implementation - e.g. \\"Add a caching layer to the API\\"\\n2. Multiple Valid Approaches - e.g. \\"Optimize database queries\\" (indexing vs rewrite vs caching)\\n3. Code Modifications - e.g. \\"Refactor auth module to support OAuth\\"\\n4. Architectural Decisions - e.g. \\"Add WebSocket support\\"\\n5. Multi-File Changes - involves more than 2-3 files\\n6. Unclear Requirements - need exploration to understand scope\\n7. User Preferences Matter - if user input would materially change the implementation approach, use EnterPlanMode to structure the decision\\n\\nPermission mode notes:\\n- EnterPlanMode enters plan mode automatically without an approval prompt in all permission modes.\\n- In yolo and manual modes, ExitPlanMode still presents the plan to the user for approval.\\n- In auto permission mode, do not use AskUserQuestion; make the best decision from available context.\\n- In auto permission mode, ExitPlanMode exits plan mode without asking the user.\\n- Use EnterPlanMode only when planning itself adds value.\\n\\nWhen NOT to use:\\n- Single-line or few-line fixes (typos, obvious bugs, small tweaks)\\n- User gave very specific, detailed instructions\\n- Pure research/exploration tasks\\n\\nOnce you are in plan mode, a reminder walks you through the workflow (explore → design → write the plan file → \`ExitPlanMode\`) and enforces read-only access. For non-trivial tasks where you are unsure of the codebase structure or relevant code paths, use \`Agent(subagent_type=\\"explore\\")\` to investigate first when the \`Agent\` tool is available.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": {}, "additionalProperties": false } }, { "name": "ExitPlanMode", "description": "Use this tool when you are in plan mode and have finished writing your plan to the plan file and are ready for user approval.\\n\\n## How This Tool Works\\n- You should have already written your plan to the plan file specified in the plan mode reminder.\\n- This tool does NOT take the plan content as a parameter - it reads the plan from the file you wrote.\\n- The user will see the contents of your plan file when they review it. In auto permission mode, the tool reads the file and exits plan mode without asking the user.\\n\\n## When to Use\\nOnly use this tool for tasks that require planning implementation steps. For research tasks (searching files, reading code, understanding the codebase), do NOT use this tool.\\n\\n## What a good plan contains\\nList specific, verifiable steps grounded in the actual codebase — real files, functions, and commands, in a sensible order. Each step should be concrete enough to act on and to check. Avoid vague filler like \\"improve performance\\" or \\"add tests\\"; say what to change and where.\\n\\n## Multiple Approaches\\nIf your plan offers multiple alternative approaches, pass them via the \`options\` parameter so the user can choose which one to execute — see the \`options\` parameter for the format, count, and reserved labels. In yolo and manual modes the user sees all options alongside the host's Reject and Revise controls.\\n\\n## Before Using\\n- In auto permission mode, do NOT use AskUserQuestion; make the best decision from available context.\\n- In auto permission mode, this tool exits plan mode without asking the user.\\n- In yolo and manual modes, this tool still presents the plan to the user for approval.\\n- If auto permission mode is not active and you have unresolved questions, use AskUserQuestion first.\\n- If auto permission mode is not active and you have multiple approaches and haven't narrowed down yet, consider using AskUserQuestion first to let the user choose, then write a plan for the chosen approach only.\\n- Once your plan is finalized, use THIS tool to request approval.\\n- Do NOT use AskUserQuestion to ask \\"Is this plan OK?\\" or \\"Should I proceed?\\" - that is exactly what ExitPlanMode does.\\n- If rejected, revise based on feedback and call ExitPlanMode again.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "options": { "description": "When the plan contains multiple alternative approaches, list them here so the user can choose which one to execute. Provide up to 3 options; 2-3 distinct approaches work best when the plan offers a real choice. Passing a single option is allowed and is equivalent to a plain plan approval. Each option represents a distinct approach from the plan. Do not use \\"Reject\\", \\"Revise\\", \\"Approve\\", or \\"Reject and Exit\\" as labels.", "minItems": 1, "maxItems": 3, "type": "array", "items": { "type": "object", "properties": { "label": { "type": "string", "minLength": 1, "maxLength": 80, "description": "Short name for this option (1-8 words). Append \\"(Recommended)\\" if you recommend this option." }, "description": { "default": "", "description": "Brief summary of this approach and its trade-offs.", "type": "string" } }, "required": [ "label" ], "additionalProperties": false } } }, "additionalProperties": false } }, { "name": "FetchURL", "description": "Fetch content from a URL. The content is returned either as the main text extracted from the page, or as the full response body verbatim; a note at the top of the result states which of the two you received, so you can judge how complete it is. Use this when you need to read a specific web page.\\n\\nOnly fully-formed public \`http\`/\`https\` URLs are supported; other schemes and private or loopback addresses are not fetched. Very large pages may be truncated or refused. The fetch carries no login or session for the target site, so pages behind authentication (private repositories, internal dashboards) return a login page or an error instead of the real content — if the text you get back looks like a generic landing or sign-in page, treat that as the login wall, not the answer, and reach the content through a credentialed route (an authenticated CLI or MCP tool) instead.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "url": { "type": "string", "description": "The URL to fetch content from." } }, "required": [ "url" ], "additionalProperties": false } }, { "name": "GetGoal", "description": "Read the current goal: its objective, completion criterion, status, and budgets (turns, tokens,\\ntime, and how much of each remains). When the goal has stopped, it also reports the terminal reason.\\n\\nUse \`GetGoal\` before deciding whether to continue working, report completion, report a blocker,\\nor respect a pause. It returns \`{ \\"goal\\": null }\` when there is no current goal.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": {}, "additionalProperties": false } }, { "name": "Glob", "description": "Find files by glob pattern, sorted by modification time (most recent first).\\n\\nPowered by ripgrep. Respects \`.gitignore\`, \`.ignore\`, and \`.rgignore\` by default — set \`include_ignored\` to also match ignored files (e.g. build outputs, \`node_modules\`). Sensitive files (such as \`.env\`) are always filtered out. Matches are files only — directories themselves are never listed; to find a directory, glob for a file inside it (e.g. \`**/fixtures/**\`).\\n\\nGood patterns:\\n- \`*.ts\` — all files matching an extension, at any depth below the search root (a bare pattern without \`/\` matches recursively)\\n- \`src/*.ts\` — files directly inside \`src/\` (one level, not recursive)\\n- \`src/**/*.ts\` — recursive walk with a subdirectory anchor and extension\\n- \`**/*.py\` — recursive walk from the search root for an extension\\n- \`*.{ts,tsx}\` — brace expansion is supported\\n- \`{src,test}/**/*.ts\` — cartesian brace expansion is supported too\\n\\nResults are capped at the first 100 matching paths. If a search would return more, a truncation marker is appended. Refine the pattern (extension, subdirectory) when 100 is not enough, or call again with a narrower anchor.\\n\\nLarge-directory caveat — avoid recursing into dependency / build output even with an anchor, especially when \`include_ignored\` is set:\\n- \`node_modules/**/*.js\`, \`.venv/**/*.py\`, \`__pycache__/**\`, \`target/**\` can produce thousands of results that truncate at the match cap and waste context. Prefer specific subpaths like \`node_modules/react/src/**/*.js\`.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "pattern": { "type": "string", "description": "Glob pattern to match files." }, "path": { "description": "Directory to search. Accepts an absolute path, or a path relative to the current working directory. Defaults to the current working directory.", "type": "string" }, "include_ignored": { "description": "Also match files excluded by ignore files such as \`.gitignore\`, \`.ignore\`, and \`.rgignore\` (for example \`node_modules\` or build outputs). Sensitive files (such as \`.env\`) remain filtered out for safety. VCS metadata directories (\`.git\` and similar) are always skipped, even when this is true. Defaults to false.", "type": "boolean" }, "include_dirs": { "description": "Deprecated and ignored. Results are always files-only — directories are never listed. Accepted only so older calls that still pass this flag are not rejected by parameter validation.", "type": "boolean" } }, "required": [ "pattern" ], "additionalProperties": false } }, { "name": "Grep", "description": "Search file contents using regular expressions (powered by ripgrep).\\n\\nUse Grep when the task is to find unknown content or unknown file locations. Do not use shell \`grep\` or \`rg\` directly; this tool applies workspace path policy, output limits, and sensitive-file filtering.\\nALWAYS use Grep tool instead of running \`grep\` or \`rg\` from a shell — direct shell calls bypass workspace policy, output limits, and sensitive-file filtering.\\nIf you already know a concrete file path and need to inspect its contents, use Read directly instead.\\n\\nWrite patterns in ripgrep regex syntax, which differs from POSIX \`grep\` syntax. For example, braces are special, so escape them as \`\\\\{\` to match a literal \`{\`.\\n\\nHidden files (dotfiles such as \`.gitlab-ci.yml\` or \`.eslintrc.json\`) are searched by default. To also search files excluded by \`.gitignore\` (such as \`node_modules\` or build outputs), set \`include_ignored\` to \`true\`. Sensitive files (such as \`.env\`) are always skipped for safety, even when \`include_ignored\` is \`true\`.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "pattern": { "type": "string", "description": "Regular expression to search for." }, "path": { "description": "File or directory to search. Accepts an absolute path, or a path relative to the current working directory. Omit to search the current working directory. Use Read instead when you already know a concrete file path and need its contents.", "type": "string" }, "glob": { "description": "Optional glob filter for which files to search, e.g. \`*.ts\`. Matched against each file's full absolute path, so a path-anchored pattern like \`src/**/*.ts\` silently matches nothing — use a basename pattern (\`*.ts\`), or anchor with \`**/\` (\`**/src/**/*.ts\`). To scope the search to a directory, use \`path\` instead.", "type": "string" }, "type": { "description": "Optional ripgrep file type filter, such as ts or py. Prefer this over \`glob\` when filtering by language or file kind: it is more efficient and less error-prone than an equivalent glob pattern.", "type": "string" }, "output_mode": { "description": "Shape of the result. \`content\` shows matching lines (honors \`-A\`, \`-B\`, \`-C\`, \`-n\`, and \`head_limit\`); \`files_with_matches\` shows only the paths of files that contain a match, most-recently-modified first (honors \`head_limit\`); \`count_matches\` shows per-file match counts as \`path:count\` lines, preceded by an aggregate total line. Defaults to \`files_with_matches\`.", "type": "string", "enum": [ "content", "files_with_matches", "count_matches" ] }, "-i": { "description": "Perform a case-insensitive search. Defaults to false.", "type": "boolean" }, "-n": { "description": "Prefix each matching line with its line number. Applies only when \`output_mode\` is \`content\`. Defaults to true.", "type": "boolean" }, "-A": { "description": "Number of lines to show after each match. Applies only when \`output_mode\` is \`content\`.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "-B": { "description": "Number of lines to show before each match. Applies only when \`output_mode\` is \`content\`.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "-C": { "description": "Number of lines to show before and after each match. Applies only when \`output_mode\` is \`content\`; takes precedence over \`-A\` and \`-B\`.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "head_limit": { "description": "Limit output to the first N lines/entries after offset. Defaults to 250. Pass 0 for unlimited.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "offset": { "description": "Number of leading lines/entries to skip before applying \`head_limit\`. Use it together with \`head_limit\` to page through large result sets. Defaults to 0.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "multiline": { "description": "Enable multiline matching, where the pattern can span line boundaries and \`.\` also matches newlines. Defaults to false.", "type": "boolean" }, "include_ignored": { "description": "Also search files excluded by ignore files such as \`.gitignore\`, \`.ignore\`, and \`.rgignore\` (for example \`node_modules\` or build outputs). Sensitive files (such as \`.env\`) remain filtered out for safety. VCS metadata directories (\`.git\` and similar) are always skipped, even when this is true. Defaults to false.", "type": "boolean" } }, "required": [ "pattern" ], "additionalProperties": false } }, { "name": "Read", "description": "Read a text file from the local filesystem.\\n\\nIf the user provides a concrete file path to a text file, call Read directly. Do not \`Glob\`, \`ls\`, or otherwise pre-check known text file paths; missing or invalid file paths return errors you can handle. Do not use Read for directories; use \`ls\` via Bash for a known directory, or Glob when you need files matching a name pattern (Glob lists files only, never directories). Use \`Grep\` only when the task is to search for unknown content or locations.\\n\\nWhen you need several files, prefer to read them in parallel: emit multiple \`Read\` calls in a single response instead of reading one file per turn.\\n\\n- Relative paths resolve against the working directory; a path outside the working directory must be absolute.\\n- Returns up to 1000 lines or 100 KB per call, whichever comes first; lines longer than 2000 chars are truncated mid-line.\\n- Page larger files with \`line_offset\` (1-based start line) and \`n_lines\`. Omit \`n_lines\` to read up to the 1000-line cap.\\n- Sensitive files (\`.env\` files, credential stores, SSH private keys, and similar secrets) are refused to protect secrets; do not attempt to read them. Templates and public keys are exempt: \`.env.example\` / \`.env.sample\` / \`.env.template\` and public SSH keys such as \`id_rsa.pub\` read normally.\\n- Only UTF-8 text files can be read. Non-UTF-8 encodings, binary files, and files containing NUL bytes are refused; use \`ReadMediaFile\` for images or video, and Bash or an MCP tool for other binary formats.\\n- Negative line_offset reads from the end of the file (for example, -100 reads the last 100 lines); the absolute value cannot exceed 1000.\\n- Output format: \`<line-number>\\\\t<content>\` per line.\\n- A \`<system>...</system>\` status block is appended after the file content; it summarizes how much was read (line and byte counts, truncation, line-ending notes) and is not part of the file itself.\\n- Pure CRLF files are displayed with LF line endings; \`Edit\` matches this output and preserves CRLF when writing back.\\n- Mixed or lone carriage-return line endings are shown as \`\\\\r\` and require exact \`Edit.old_string\` escapes.\\n- After a successful \`Edit\`/\`Write\`, do not re-read solely to prove the write landed. When the task depends on an exact file, API, or output shape, inspect the final external contract before finishing.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to a text file. Relative paths resolve against the working directory; a path outside the working directory must be absolute. Directories are not supported; use \`ls\` via Bash for a known directory, or Glob for pattern search." }, "line_offset": { "description": "The line number to start reading from. Omit to start at line 1. Negative values read from the end of the file; the absolute value cannot exceed 1000.", "anyOf": [ { "type": "integer", "minimum": 1, "maximum": 9007199254740991 }, { "type": "integer", "minimum": -1000, "maximum": -1 } ] }, "n_lines": { "description": "The number of lines to read; the tool also applies its internal cap. Omit to read up to the internal cap of 1000 lines.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 } }, "required": [ "path" ], "additionalProperties": false } }, { "name": "SetGoalBudget", "description": "Set a hard budget limit for the current goal.\\n\\nUse this only when the user clearly gives a runtime limit, such as:\\n\\n- \\"stop after 20 turns\\"\\n- \\"use no more than 500k tokens\\"\\n- \\"finish within 30 minutes\\"\\n\\nDo not invent limits. Do not call this for vague wording such as \\"spend some time\\" or\\n\\"try to be quick\\".\\n\\nIf the user gives a compound time, convert it to one supported unit before calling this tool.\\nFor example, \\"2 hours and 3 minutes\\" can be set as \`value: 123, unit: \\"minutes\\"\`.\\n\\nA time budget must be between 1 second and 24 hours — the tool rejects anything shorter or\\nlonger, telling the user it is not a reasonable goal budget. Turn and token budgets are not\\nbounded this way; they must be positive and are rounded to the nearest whole number (minimum 1).\\n\\nSupported units:\\n\\n- \`turns\`\\n- \`tokens\`\\n- \`milliseconds\`\\n- \`seconds\`\\n- \`minutes\`\\n- \`hours\`\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "value": { "type": "number", "exclusiveMinimum": 0, "description": "The positive numeric budget value." }, "unit": { "type": "string", "enum": [ "turns", "tokens", "milliseconds", "seconds", "minutes", "hours" ] } }, "required": [ "value", "unit" ], "additionalProperties": false } }, { "name": "Skill", "description": "Invoke a registered skill from the current skill listing. BLOCKING REQUIREMENT: when a skill from the listing matches the user's request, you MUST call this tool (not free-form text). Do not re-invoke a skill to repeat work already done: if a \`<kimi-skill-loaded>\` block for it with the same \`args\` is already present in the conversation, follow those instructions directly instead of calling the tool again. Do call the tool again when you need the skill with different arguments — the loaded block was expanded with the earlier \`args\` and will not reflect new inputs. Do NOT call the same skill repeatedly inside one turn — recursive depth is capped at 3.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "skill": { "type": "string", "description": "The exact name of the skill to invoke, spelled as it appears in the current skill listing (e.g. \\"commit\\", \\"pdf\\")." }, "args": { "description": "Optional argument string for the skill, written like a command line (e.g. \`-m \\"fix bug\\"\`, \`123\`, a file path). It is split on whitespace (quotes group a token) and expanded into the skill's placeholders ($NAME, $1, $ARGUMENTS); if the skill body has no placeholders, the whole string is still appended as a trailing \`ARGUMENTS:\` line. Omit it only when there is nothing to pass.", "type": "string" } }, "required": [ "skill" ], "additionalProperties": false } }, { "name": "TaskList", "description": "List background tasks and their current status.\\n\\nUse this tool to discover which background tasks exist and where each one\\nstands. It is the entry point for inspecting background work: it returns a\\ntask ID, status, and description for every task it reports, plus the command,\\nPID, and (once finished) exit code for shell tasks, and a stop reason for any\\ntask that ended early.\\n\\nGuidelines:\\n\\n- After a context compaction, or whenever you are unsure which background\\n  tasks are running or what their task IDs are, call this tool to\\n  re-enumerate them instead of guessing a task ID.\\n- Prefer the default \`active_only=true\`, which lists only non-terminal tasks.\\n  Pass \`active_only=false\` only when you specifically need to see tasks that\\n  have already finished. With \`active_only=false\` the result may also include\\n  \`lost\` tasks — tasks left over from a previous process that can no longer be\\n  inspected or controlled; treat them as already terminated.\\n- \`limit\` caps how many tasks are returned. It accepts a value between 1 and\\n  100 and defaults to 20 when omitted.\\n- This tool only lists tasks; it does not return their output. Use it first\\n  to locate the task ID you need, then call \`TaskOutput\` with that ID to read\\n  the task's output and details.\\n- This tool is read-only and does not change any state, so it is always safe\\n  to call, including in plan mode.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "active_only": { "default": true, "description": "Whether to list only non-terminal background tasks.", "type": "boolean" }, "limit": { "default": 20, "description": "Maximum number of tasks to return.", "type": "integer", "minimum": 1, "maximum": 100 } }, "additionalProperties": false } }, { "name": "TaskOutput", "description": "Retrieve output from a running or completed background task.\\n\\nUse this after \`Bash(run_in_background=true)\` or \`Agent(run_in_background=true)\` when you need to inspect progress or explicitly wait for completion.\\n\\nGuidelines:\\n- Prefer relying on automatic completion notifications. Use this tool only when you need task output before the automatic notification arrives.\\n- Do not use TaskOutput to wait for a result you need before continuing — if your next step depends on the task's result, run that task in the foreground instead. TaskOutput is for a deliberate progress check you will act on without blocking, not a way to sit and wait for a background task you just launched.\\n- By default this tool is non-blocking and returns a current status/output snapshot.\\n- Use block=true only when you intentionally want to wait for completion or timeout.\\n- This tool returns structured task metadata, a fixed-size output preview, and an output_path for the full log.\\n- For a terminal task, the metadata also explains why it ended. A shell command that runs to completion reports \`status: completed\` on a zero exit, or \`status: failed\` with its non-zero \`exit_code\` — judge that failure from the \`exit_code\`, because a plain command failure carries no \`stop_reason\` and no \`terminal_reason\`. \`terminal_reason\` is a categorical label emitted only when the end is not an ordinary exit: \`timed_out\` when the deadline aborted it, \`stopped\` when it was explicitly stopped, or \`failed\` when it errored without producing an exit code; the \`stopped\` and \`failed\` cases also carry a human-readable \`stop_reason\`. A task that finished on its own with a clean exit carries neither \`stop_reason\` nor \`terminal_reason\`.\\n- The full, never-truncated log is always available at output_path; use the \`Read\` tool with that path to page through it, whether or not the preview was truncated.\\n- This tool works with the generic background task system and should remain the primary read path for future task types, not just bash.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "task_id": { "type": "string", "description": "The background task ID to inspect." }, "block": { "default": false, "description": "Whether to wait for the task to finish before returning.", "type": "boolean" }, "timeout": { "default": 30, "description": "Maximum number of seconds to wait when block=true.", "type": "integer", "minimum": 0, "maximum": 3600 } }, "required": [ "task_id" ], "additionalProperties": false } }, { "name": "TaskStop", "description": "Stop a running background task.\\n\\nOnly use this when a task must genuinely be cancelled — for a task that is\\nfinishing normally, wait for its completion notification or inspect it with\\n\`TaskOutput\` instead of stopping it.\\n\\nGuidelines:\\n- This is a general-purpose stop capability for any background task. It is not\\n  a bash-specific kill.\\n- Stopping a task is destructive: it may leave partial side effects behind.\\n  Use it with care.\\n- If the task has already finished, this tool simply returns its current\\n  status.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "task_id": { "type": "string", "description": "The background task ID to stop." }, "reason": { "default": "Stopped by TaskStop", "description": "Short reason recorded when the task is stopped.", "type": "string" } }, "required": [ "task_id" ], "additionalProperties": false } }, { "name": "TodoList", "description": "Use this tool to maintain a structured TODO list as you work through a multi-step task. Use it proactively and often when progress tracking helps the current work. This is especially useful in long-running investigations and implementation tasks with several tool calls; in plan mode, write the plan to the plan file rather than tracking it here.\\n\\n**When to use:**\\n- Multi-step tasks that span several tool calls\\n- Tracking investigation progress across a large codebase search\\n- Planning a sequence of edits before making them\\n- After receiving new multi-step instructions, capture the requirements as todos\\n- Before starting a tracked task, mark exactly one item as \`in_progress\`\\n- Immediately after finishing a tracked task, mark it \`done\`; do not batch completions at the end\\n\\n**When NOT to use:**\\n- Single-shot answers that complete in one or two tool calls\\n- Trivial requests where tracking adds no clarity\\n- Purely conversational or informational replies\\n\\n**Avoid churn:**\\n- Do not re-call this tool when nothing meaningful has changed since the last call — update the list only after real progress.\\n- When unsure of the current state, call query mode first (omit \`todos\`) to check the list before deciding what to update.\\n- If no available tool can move any task forward, tell the user where you are stuck instead of repeatedly re-ordering the same todos.\\n\\n**How to use:**\\n- Call with \`todos: [...]\` to replace the full list. Statuses: pending / in_progress / done.\\n- Call with no \`todos\` argument to retrieve the current list without changing it.\\n- Call with \`todos: []\` to clear the list.\\n- Keep titles short and actionable (e.g. \\"Read session-control.ts\\", \\"Add planMode flag to TurnManager\\").\\n- Update statuses as you make progress.\\n- When work is underway, keep exactly one task \`in_progress\`.\\n- Only mark a task \`done\` when it is fully accomplished.\\n- Never mark a task \`done\` if tests are failing, implementation is partial, unresolved errors remain, or required files/dependencies could not be found.\\n- If you encounter a blocker, keep the blocked task \`in_progress\` or add a new pending task describing what must be resolved.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "todos": { "description": "The updated todo list. Omit to read the current todo list without making changes. Pass an empty array to clear the list.", "type": "array", "items": { "type": "object", "properties": { "title": { "type": "string", "minLength": 1, "description": "Short, actionable title for the todo." }, "status": { "type": "string", "enum": [ "pending", "in_progress", "done" ], "description": "Current status of the todo." } }, "required": [ "title", "status" ], "additionalProperties": false } } }, "additionalProperties": false } }, { "name": "UpdateGoal", "description": "Set the status of the current goal. This is how you resume, complete, or block an autonomous goal.\\n\\n- \`active\` — resume a paused or blocked goal when the user explicitly asks you to work on that goal.\\n- \`complete\` — the objective is satisfied and any stated validation has passed. The goal ends and a completion summary is recorded. Before using this, verify the current state against the actual objective and every explicit requirement. Treat weak or indirect evidence as not complete. Do not use \`complete\` merely because a budget is nearly exhausted or you want to stop.\\n- \`blocked\` — a genuine impasse prevents useful progress: an external condition, required user input, missing credentials or permissions, a persistent technical failure, or an impossible, unsafe, or contradictory objective. For non-terminal blockers, do not use \`blocked\` the first time you hit the blocker. The same blocking condition must repeat for at least 3 consecutive goal turns before you call \`blocked\`, counting the original/user-triggered turn and automatic continuations. If a previously blocked goal is resumed, treat the resumed run as a fresh blocked audit. If the objective itself is impossible, unsafe, or contradictory, call \`blocked\` in the same turn instead of running more goal turns. Do not use \`blocked\` because the work is large, hard, slow, uncertain, incomplete, still needs validation, would benefit from clarification, or needs more goal turns. Once the 3-turn threshold is met and you cannot make meaningful progress without user input or an external-state change, call \`blocked\` instead of leaving the goal active.\\n\\nMost active goal turns should not call this tool. If you complete one useful slice of work and material work remains, end the turn normally without calling UpdateGoal; the runtime will prompt you to continue in the next goal turn. Call \`complete\` only when all required work is done, any stated validation has passed, and there is no useful next action. Do not call \`complete\` after only producing a plan, summary, first pass, or partial result. Call \`blocked\` only after the blocked audit threshold is met. If you call \`blocked\`, you will be prompted to explain the blocker in your next message. Setting the status is the machine-readable signal; the completion summary or blocker explanation is yours to write in the following message.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "status": { "type": "string", "enum": [ "active", "complete", "blocked" ], "description": "The lifecycle status to set for the current goal. Use \`blocked\` for impossible, unsafe, or contradictory objectives, or after the same non-terminal blocking condition repeats for at least 3 consecutive goal turns." } }, "required": [ "status" ], "additionalProperties": false } }, { "name": "Write", "description": "Create, append to, or replace a file entirely.\\n\\n- Missing parent directories are created automatically (like \`mkdir(parents=True, exist_ok=True)\`).\\n- Mode defaults to overwrite; append adds content at EOF without adding a newline.\\n- Write is NOT ALLOWED for incremental changes to existing files, including trivial, one-line, quick, or cosmetic edits. Use Edit instead.\\n- Use Write only when the file does not exist, you intend a complete replacement, or the new contents have little continuity with the old contents.\\n- Do not create unsolicited documentation files (\`*.md\` write-ups, \`README\`s, summaries) just because a task finished — write one only when the user asks for it, or when a task or project instruction requires it (e.g. the plan-mode plan file, created with Write when plan mode directs you to, or a changeset the repo mandates).\\n- Read before overwriting an existing file.\\n- Write ignores the Read/Edit line-number view. NEVER include line prefixes.\\n- Write outputs content literally, including supplied line endings: \\\\n stays LF, \\\\r\\\\n stays CRLF.\\n- For new content too large for one call, overwrite the first chunk, then append subsequent chunks. Never chunk Write to modify an existing file.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to the file to create, append to, or completely overwrite. Relative paths resolve against the working directory; a path outside the working directory must be absolute. Missing parent directories are created automatically." }, "content": { "type": "string", "description": "Raw full file content to write exactly as provided. This does not use the Read/Edit text view." }, "mode": { "description": "Write mode. Defaults to overwrite. append adds content to the end exactly as provided and does not add a newline.", "type": "string", "enum": [ "overwrite", "append" ] } }, "required": [ "path", "content" ], "additionalProperties": false } } ], "time": "<time>" }
      [wire] llm.request                 { "kind": "loop", "provider": "kimi", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 1000000, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "11648f47860177e1e5af084aa9af31d519309a860df84eeb0864b1c050dc87ca", "messageCount": 1, "turnStep": "0.1", "time": "<time>" }
      [emit] turn.step.interrupted       { "turnId": 0, "step": 1, "reason": "error", "message": "Unexpected generate call #1" }
      [emit] turn.ended                  { "turnId": 0, "reason": "failed", "error": { "code": "internal", "message": "Unexpected generate call #1", "name": "Error", "retryable": false } }
    `);
    expect(ctx.newEvents()).toMatchInlineSnapshot(
      `[emit] error   { "code": "internal", "message": "Unexpected generate call #1", "name": "Error", "retryable": false }`,
    );
    await ctx.expectResumeMatches();
  });

  it('replays swarm exit popping the enter reminder without synthesizing cleanup records', async () => {
    const ctx = testAgent();
    const enterReminder: ContextMessage = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: '<system-reminder>\nlegacy swarm enter reminder\n</system-reminder>',
        },
      ],
      toolCalls: [],
      origin: { kind: 'injection', variant: 'swarm_mode' },
    };

    await ctx.restore([
      { type: 'swarm_mode.enter', trigger: 'manual' },
      { type: 'context.append_message', message: enterReminder },
      { type: 'swarm_mode.exit' },
    ]);

    expect(ctx.get(IAgentSwarmService).isActive).toBe(false);
    // The ContextModel cross-reducer on `swarm_mode.exit` pops the enter
    // reminder during replay — no synthesized cleanup record is needed.
    expect(ctx.contextData().history).toEqual([]);
    expect(ctx.newEvents()).toMatchInlineSnapshot(`
      [wire] swarm_mode.enter         { "trigger": "manual" }
      [wire] context.append_message   { "message": { "role": "user", "content": [ { "type": "text", "text": "<system-reminder>\\nlegacy swarm enter reminder\\n</system-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "swarm_mode" } } }
      [wire] swarm_mode.exit          {}
    `);
  });

  it('keeps manual swarm mode active after a turn completes normally', async () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'swarm done' });

    await ctx.rpc.enterSwarm({ trigger: 'manual' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run a swarm task' }] });
    await ctx.untilTurnEnd();

    expect(ctx.get(IAgentSwarmService).isActive).toBe(true);
    expect(eventIndex(ctx, '[wire]', 'swarm_mode.exit')).toBe(-1);
    await ctx.expectResumeMatches();
  });

  it('exits task swarm mode after a turn completes normally', async () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'swarm done' });

    await ctx.rpc.enterSwarm({ trigger: 'task' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run a swarm task' }] });
    await ctx.untilTurnEnd();

    const turnEndedIndex = eventIndex(ctx, '[rpc]', 'turn.ended');
    const swarmExitIndex = eventIndex(ctx, '[wire]', 'swarm_mode.exit');
    const inactiveStatusIndex = ctx.allEvents.findIndex((entry, index) => {
      return (
        index > turnEndedIndex &&
        entry.type === '[rpc]' &&
        entry.event === 'agent.status.updated' &&
        (entry.args as { readonly swarmMode?: boolean }).swarmMode === false
      );
    });

    expect(ctx.get(IAgentSwarmService).isActive).toBe(false);
    expect(swarmExitIndex).toBeGreaterThan(turnEndedIndex);
    expect(inactiveStatusIndex).toBeGreaterThan(turnEndedIndex);
    expect(ctx.contextData().history.at(-1)?.origin).toEqual({
      kind: 'injection',
      variant: 'swarm_mode_exit',
    });
    await ctx.expectResumeMatches();
  });

  it('exits task swarm mode when the swarm turn fails', async () => {
    const ctx = testAgent();
    ctx.configure();

    await ctx.rpc.enterSwarm({ trigger: 'task' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Fail a swarm task' }] });
    await ctx.untilTurnEnd();

    expect(ctx.get(IAgentSwarmService).isActive).toBe(false);
    expect(eventIndex(ctx, '[wire]', 'swarm_mode.exit')).toBeGreaterThan(-1);
  });

  it('exits task swarm mode when the user cancels the swarm turn', async () => {
    const ctx = testAgent({ generate: abortableGenerate });
    ctx.configure();

    const stepStarted = ctx.once('turn.step.started');
    await ctx.rpc.enterSwarm({ trigger: 'task' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Cancel a swarm task' }] });
    await stepStarted;
    await ctx.rpc.cancel({ turnId: 0 });
    await ctx.untilTurnEnd();

    expect(ctx.get(IAgentSwarmService).isActive).toBe(false);
    expect(eventIndex(ctx, '[wire]', 'swarm_mode.exit')).toBeGreaterThan(-1);
  });

  it('enters silent swarm mode when the agent calls AgentSwarm', async () => {
    const runQueued = vi.fn(async <T>(
      { tasks }: { tasks: readonly QueuedSubagentTask<T>[] },
    ): Promise<Array<QueuedSubagentRunResult<T>>> => {
      return tasks.map((task, index) => ({
        task,
        agentId: `agent-${String(index + 1)}`,
        status: 'completed' as const,
        result: `result ${String(index + 1)}`,
      }));
    });
    const ctx = testAgent(swarmServices(runQueued as never));
    ctx.configure({ tools: ['AgentSwarm'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });

    ctx.mockNextResponse(
      { type: 'text', text: 'I will launch a swarm.' },
      agentSwarmCall(),
    );
    ctx.mockNextResponse({ type: 'text', text: 'Swarm results reviewed.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Use AgentSwarm' }] });
    await ctx.untilTurnEnd();

    const enterEvent = ctx.allEvents.find(
      (entry) => entry.type === '[wire]' && entry.event === 'swarm_mode.enter',
    );
    const reminderOrigins = ctx.contextData().history
      .map((message) => message.origin)
      .filter((origin) => origin?.kind === 'injection');

    expect(runQueued).toHaveBeenCalledTimes(1);
    expect(enterEvent?.args).toMatchObject({ trigger: 'tool' });
    expect(ctx.get(IAgentSwarmService).isActive).toBe(false);
    expect(eventIndex(ctx, '[wire]', 'swarm_mode.exit')).toBeGreaterThan(
      eventIndex(ctx, '[rpc]', 'turn.ended'),
    );
    expect(reminderOrigins).not.toContainEqual({ kind: 'injection', variant: 'swarm_mode' });
    expect(reminderOrigins).not.toContainEqual({
      kind: 'injection',
      variant: 'swarm_mode_exit',
    });
    await ctx.expectResumeMatches();
  });

  it('includes provider finish reason details on empty response failures', async () => {
    const generate: GenerateFn = async () => {
      throw new APIEmptyResponseError(
        'The API returned a response containing only thinking content without any text or tool calls. ' +
          'Provider stop details: finishReason=filtered, rawFinishReason=content_filter.',
        {
          finishReason: 'filtered',
          rawFinishReason: 'content_filter',
        },
      );
    };
    const ctx = testAgent({
      generate,
      ...singleAttemptAgentOptions(),
    });
    ctx.configure();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Trigger filtered response' }] });
    const events = await ctx.untilTurnEnd();

    expect(events).toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'turn.ended',
        args: expect.objectContaining({
          reason: 'failed',
          error: expect.objectContaining({
            code: 'provider.filtered',
            name: 'APIEmptyResponseError',
            details: expect.objectContaining({
              finishReason: 'filtered',
              rawFinishReason: 'content_filter',
              turnId: 0,
            }),
          }),
        }),
      }),
    );
    expect(ctx.newEvents()).toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'error',
        args: expect.objectContaining({
          code: 'provider.filtered',
          name: 'APIEmptyResponseError',
          details: expect.objectContaining({
            finishReason: 'filtered',
            rawFinishReason: 'content_filter',
            turnId: 0,
          }),
        }),
      }),
    );
  });

  it('ends the turn with a provider.filtered error when the provider filters a non-empty response', async () => {
    const generate: GenerateFn = async () => ({
      id: null,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'some filtered text' }],
        toolCalls: [],
      },
      usage: {
        inputOther: 10,
        output: 5,
        inputCacheRead: 0,
        inputCacheCreation: 0,
      },
      finishReason: 'filtered',
      rawFinishReason: 'content_filter',
    });
    const ctx = testAgent({
      generate,
      ...singleAttemptAgentOptions(),
    });
    ctx.configure();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Trigger filtered response' }] });
    const events = await ctx.untilTurnEnd();

    expect(events).toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'turn.ended',
        args: expect.objectContaining({
          reason: 'failed',
          error: expect.objectContaining({
            code: 'provider.filtered',
            details: expect.objectContaining({
              finishReason: 'filtered',
              turnId: 0,
            }),
          }),
        }),
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: '[rpc]',
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'completed' }),
      }),
    );
  });

  it('emits a model.not_configured error when no model is configured', async () => {
    const ctx = testAgent(configServices(() => ({ providers: {} })), { autoConfigure: false });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello without login' }] });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] turn.prompt              { "input": [ { "type": "text", "text": "Hello without login" } ], "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started             { "turnId": 0, "origin": { "kind": "user" } }
      [wire] context.append_message   { "message": { "role": "user", "content": [ { "type": "text", "text": "Hello without login" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [emit] context.spliced          { "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Hello without login" } ], "toolCalls": [], "origin": { "kind": "user" } } ] }
      [emit] turn.step.interrupted    { "turnId": 0, "step": 1, "reason": "error", "message": "Model not set" }
      [emit] turn.ended               { "turnId": 0, "reason": "failed", "error": { "code": "model.not_configured", "message": "Model not set", "name": "KimiError", "retryable": false } }
    `);
    expect(ctx.newEvents()).toMatchInlineSnapshot(
      `[emit] error   { "code": "model.not_configured", "message": "Model not set", "name": "KimiError", "retryable": false }`,
    );
  });

  it('continues the turn after projecting UserPromptSubmit hook output', async () => {
    const hookEngine = makeHookRunner([
      {
        event: 'UserPromptSubmit',
        matcher: 'hooked input',
        command:
          'node -e "let s=\\\"\\\";process.stdin.on(\\\"data\\\",d=>s+=d);process.stdin.on(\\\"end\\\",()=>{const o=JSON.parse(s);if(Array.isArray(o.prompt)&&o.prompt[0]?.text===\\\"hooked input\\\"){process.stdout.write(\\\"hook response 1\\\");process.exit(0);}console.error(\\\"bad prompt\\\");process.exit(1);})"',
      },
      {
        event: 'UserPromptSubmit',
        matcher: 'hooked input',
        command: "echo 'hook response 2'",
      },
    ]);
    const ctx = testAgent({ hookEngine });
    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'model saw original prompt only' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hooked input' }] });
    const events = await ctx.untilTurnEnd();

    const hookResult =
      '<hook_result hook_event="UserPromptSubmit">\nhook response 1\n</hook_result>\n<hook_result hook_event="UserPromptSubmit">\nhook response 2\n</hook_result>';
    expect(ctx.llmCalls).toHaveLength(1);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: Agent, AgentSwarm, AskUserQuestion, Bash, CreateGoal, Edit, EnterPlanMode, ExitPlanMode, FetchURL, GetGoal, Glob, Grep, Read, SetGoalBudget, Skill, TaskList, TaskOutput, TaskStop, TodoList, UpdateGoal, Write
      messages:
        user: text "<hook_result hook_event=\\"UserPromptSubmit\\">\\nhook response 1\\n</hook_result>\\n<hook_result hook_event=\\"UserPromptSubmit\\">\\nhook response 2\\n</hook_result>"
        user: text "hooked input"
    `);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'hook.result',
        args: expect.objectContaining({
          hookEvent: 'UserPromptSubmit',
          content: 'hook response 1\n\nhook response 2',
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'assistant.delta',
        args: expect.objectContaining({ delta: 'model saw original prompt only' }),
      }),
    );
    expect(ctx.contextData().history).toMatchObject([
      {
        role: 'user',
        content: [{ type: 'text', text: 'hooked input' }],
        toolCalls: [],
      },
      {
        role: 'user',
        content: [{ type: 'text', text: hookResult }],
        toolCalls: [],
        origin: { kind: 'hook_result', event: 'UserPromptSubmit' },
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'model saw original prompt only' }],
        toolCalls: [],
      },
    ]);
  });

  it('projects structured UserPromptSubmit stdout', async () => {
    const hookEngine = makeHookRunner([
      {
        event: 'UserPromptSubmit',
        matcher: 'hooked input',
        command: "echo '{}'",
      },
      {
        event: 'UserPromptSubmit',
        matcher: 'hooked input',
        command: 'echo \'{"hookSpecificOutput":{}}\'',
      },
    ]);
    const ctx = testAgent({ hookEngine });
    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'model saw original prompt only' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hooked input' }] });
    const events = await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(1);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: Agent, AgentSwarm, AskUserQuestion, Bash, CreateGoal, Edit, EnterPlanMode, ExitPlanMode, FetchURL, GetGoal, Glob, Grep, Read, SetGoalBudget, Skill, TaskList, TaskOutput, TaskStop, TodoList, UpdateGoal, Write
      messages:
        user: text "<hook_result hook_event=\\"UserPromptSubmit\\">\\n{}\\n</hook_result>\\n<hook_result hook_event=\\"UserPromptSubmit\\">\\n{\\"hookSpecificOutput\\":{}}\\n</hook_result>"
        user: text "hooked input"
    `);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'hook.result',
        args: expect.objectContaining({
          hookEvent: 'UserPromptSubmit',
          content: '{}\n\n{"hookSpecificOutput":{}}',
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'completed' }),
      }),
    );
    expect(ctx.contextData().history).toMatchObject([
      {
        role: 'user',
        content: [{ type: 'text', text: 'hooked input' }],
        toolCalls: [],
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '<hook_result hook_event="UserPromptSubmit">\n{}\n</hook_result>\n<hook_result hook_event="UserPromptSubmit">\n{"hookSpecificOutput":{}}\n</hook_result>',
          },
        ],
        toolCalls: [],
        origin: { kind: 'hook_result', event: 'UserPromptSubmit' },
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'model saw original prompt only' }],
        toolCalls: [],
      },
    ]);
  });

  it('stops the turn when a UserPromptSubmit hook blocks', async () => {
    const hookEngine = makeHookRunner([
      {
        event: 'UserPromptSubmit',
        matcher: 'bad words',
        command: "echo 'no profanity' >&2; exit 2",
      },
    ]);
    const ctx = testAgent({ hookEngine });
    ctx.configure();

    const result = await ctx.rpc.prompt({ input: [{ type: 'text', text: 'bad words here' }] });
    const events = ctx.newEvents();

    const hookResult = '<hook_result hook_event="UserPromptSubmit">\nno profanity\n</hook_result>';
    expect(result).toBeUndefined();
    expect(ctx.llmCalls).toHaveLength(0);
    expect(events).not.toContainEqual(
      expect.objectContaining({
        event: 'turn.started',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'hook.result',
        args: expect.objectContaining({
          hookEvent: 'UserPromptSubmit',
          content: 'no profanity',
          blocked: true,
        }),
      }),
    );
    expect(ctx.contextData().history).toMatchObject([
      {
        role: 'user',
        content: [{ type: 'text', text: 'bad words here' }],
        toolCalls: [],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: hookResult }],
        toolCalls: [],
        origin: { kind: 'hook_result', event: 'UserPromptSubmit', blocked: true },
      },
    ]);

    ctx.mockNextResponse({ type: 'text', text: 'safe answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'safe followup' }] });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(1);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: Agent, AgentSwarm, AskUserQuestion, Bash, CreateGoal, CronCreate, CronDelete, CronList, Edit, EnterPlanMode, ExitPlanMode, FetchURL, GetGoal, Glob, Grep, Read, SetGoalBudget, Skill, TaskList, TaskOutput, TaskStop, UpdateGoal, Write
      messages:
        user: text "bad words here"
        assistant: text "<hook_result hook_event=\\"UserPromptSubmit\\">\\nno profanity\\n</hook_result>"
        user: text "safe followup"
    `);
  });

  it('ignores timed out UserPromptSubmit hook output before launching the turn', async () => {
    const hookEngine = makeHookRunner([
      {
        event: 'UserPromptSubmit',
        command: 'node -e "setTimeout(() => process.stdout.write(\\"late hook\\"), 250)"',
        timeout: 0.01,
      },
    ]);
    const ctx = testAgent({ hookEngine });
    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'model after timeout' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hook will sleep' }] });
    const events = await ctx.untilTurnEnd();

    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'completed' }),
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        event: 'hook.result',
      }),
    );
    expect(ctx.contextData().history).toMatchObject([
      {
        role: 'user',
        content: [{ type: 'text', text: 'hook will sleep' }],
        toolCalls: [],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'model after timeout' }],
        toolCalls: [],
      },
    ]);
  });

  it('uses a Stop hook block reason as a one-shot turn continuation', async () => {
    const hookEngine = makeHookRunner([
      {
        event: 'Stop',
        command: "echo 'continue from hook' >&2; exit 2",
      },
    ]);
    const ctx = testAgent({ hookEngine });
    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'First answer.' });
    ctx.mockNextResponse({ type: 'text', text: 'Second answer.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(2);
    const stopHookMessage = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'continue from hook',
        },
      ],
      toolCalls: [],
      origin: { kind: 'system_trigger', name: 'stop_hook' },
    };
    const llmStopHookMessage = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'continue from hook',
        },
      ],
      toolCalls: [],
    };
    expect(JSON.stringify(ctx.contextData().history)).toContain('continue from hook');
    expect(ctx.contextData().history).toContainEqual(expect.objectContaining(stopHookMessage));
    expect(ctx.llmCalls[1]?.history).toContainEqual(expect.objectContaining(llmStopHookMessage));
    expect(JSON.stringify(ctx.contextData().history)).toContain('Second answer.');
  });

  it('fails with max steps when a Stop hook continuation exceeds step budget', async () => {
    const hookEngine = makeHookRunner([
      {
        event: 'Stop',
        command: "echo 'continue from hook' >&2; exit 2",
      },
    ]);
    const ctx = testAgent({
      hookEngine,
      initialConfig: {
        providers: {},
        loopControl: { maxStepsPerTurn: 1 },
      },
    });
    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'Only answer.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    const events = await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(1);
    expect(JSON.stringify(ctx.contextData().history)).toContain('continue from hook');
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({
          reason: 'failed',
          error: expect.objectContaining({
            code: 'loop.max_steps_exceeded',
            details: expect.objectContaining({
              maxSteps: 1,
            }),
          }),
        }),
      }),
    );
  });

  it('cancels while waiting for a Stop hook', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-stop-hook-'));
    const marker = join(dir, 'started');
    const script = [
      "const fs=require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(marker)}, 'started');`,
      "setTimeout(() => process.stderr.write('late stop hook'), 250);",
    ].join('');
    const hookEngine = makeHookRunner([
      {
        event: 'Stop',
        command: `node -e ${JSON.stringify(script)}`,
        timeout: 5,
      },
    ]);
    const ctx = testAgent({ hookEngine });
    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'Answer before stop hook.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    await waitForFile(marker);
    await ctx.rpc.cancel({ turnId: 0 });
    const events = await ctx.untilTurnEnd();

    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'cancelled' }),
      }),
    );
    expect(ctx.llmCalls).toHaveLength(1);
    expect(JSON.stringify(ctx.contextData().history)).not.toContain('late stop hook');
  });

  it('cancels while waiting for a PreToolUse hook before permission evaluation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-pre-tool-hook-'));
    const marker = join(dir, 'started');
    const script = [
      "const fs=require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(marker)}, 'started');`,
      "setTimeout(() => process.stdout.write('late pre tool hook'), 250);",
    ].join('');
    const execWithEnv = vi.fn().mockRejectedValue(new Error('Bash should not execute'));
    const hookEngine = makeHookRunner([
      {
        event: 'PreToolUse',
        matcher: 'Bash',
        command: `node -e ${JSON.stringify(script)}`,
        timeout: 5,
      },
    ]);
    const ctx = testAgent(execEnvServices({ processRunner: createFakeProcessRunner({ exec: execWithEnv }) }), {
      hookEngine,
    });
    const authorize = vi.spyOn(ctx.get(IAgentPermissionGate), 'authorize');
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'auto' });
    ctx.newEvents();
    ctx.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run Bash while hook sleeps' }] });
    await waitForFile(marker);
    await ctx.rpc.cancel({ turnId: 0 });
    const events = await ctx.untilTurnEnd();

    expect(authorize).not.toHaveBeenCalled();
    expect(execWithEnv).not.toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'cancelled' }),
      }),
    );
    expect(JSON.stringify(ctx.contextData().history)).not.toContain('late pre tool hook');
  });

  it('fires StopFailure when a turn fails', async () => {
    const triggered: Array<[string, string, number]> = [];
    const hookEngine = makeHookRunner(
      [
        {
          event: 'StopFailure',
          matcher: 'Error',
          command: 'exit 0',
        },
      ],
      {
        onTriggered: (event, target, count) => {
          triggered.push([event, target, count]);
        },
      },
    );
    const ctx = testAgent({ hookEngine });
    ctx.configure();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Trigger generate failure' }] });
    await ctx.untilTurnEnd();

    expect(triggered).toEqual([['StopFailure', 'Error', 1]]);
  });

  it('fires Interrupt when the user cancels an active turn', async () => {
    const triggered: Array<[string, string, number]> = [];
    const hookEngine = makeHookRunner(
      [
        {
          event: 'Interrupt',
          command: 'exit 0',
        },
      ],
      {
        onTriggered: (event, target, count) => {
          triggered.push([event, target, count]);
        },
      },
    );
    const ctx = testAgent({ generate: abortableGenerate, hookEngine });
    ctx.configure();

    const stepStarted = ctx.once('turn.step.started');
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run a command' }] });
    await stepStarted;

    await ctx.rpc.cancel({ turnId: 0 });
    await ctx.untilTurnEnd();
    await vi.waitFor(() => {
      expect(triggered).toEqual([['Interrupt', '', 1]]);
    });

    expect(triggered).toEqual([['Interrupt', '', 1]]);
  });

  it('does not fire Interrupt for a non-user (programmatic) abort', async () => {
    const triggered: Array<[string, string, number]> = [];
    const hookEngine = makeHookRunner(
      [
        {
          event: 'Interrupt',
          command: 'exit 0',
        },
      ],
      {
        onTriggered: (event, target, count) => {
          triggered.push([event, target, count]);
        },
      },
    );
    const ctx = testAgent({ generate: abortableGenerate, hookEngine });
    ctx.configure();

    const stepStarted = ctx.once('turn.step.started');
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run a command' }] });
    await stepStarted;

    // A programmatic abort (e.g. a subagent deadline timeout) carries a plain
    // AbortError as its reason, not a UserCancellationError, so it must not be
    // reported as a user interrupt.
    ctx.get(IAgentTurnService).cancel(undefined, abortError());
    await ctx.untilTurnEnd();

    expect(triggered).toEqual([]);
  });

  it('resolves the latest request-scoped OAuth auth before each generation', async () => {
    const tokenCalls: Array<boolean | undefined> = [];
    const authKeys: string[] = [];
    const tokens = ['first-turn-token', 'second-turn-token'];
    const oauthOptions = oauthAgentOptions(async (options) => {
      tokenCalls.push(options?.force);
      const token = tokens.shift();
      if (token === undefined) throw new Error('unexpected token request');
      return token;
    });
    const generate: GenerateFn = async (
      _provider,
      _system,
      _tools,
      _history,
      callbacks,
      options,
    ) => {
      const apiKey = options?.auth?.apiKey ?? '<missing>';
      authKeys.push(apiKey);
      const text = `Generated with ${apiKey}`;
      await callbacks?.onMessagePart?.({ type: 'text', text });
      return textResult(text);
    };
    const ctx = testAgent(oauthOptions.services, {
      initialConfig: oauthOptions.initialConfig,
      generate,
    });
    ctx.configure();
    await ctx.rpc.setModel({ model: 'kimi-code' });
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    const firstEvents = await ctx.untilTurnEnd();
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello again' }] });
    const secondEvents = await ctx.untilTurnEnd();

    expect(authKeys).toEqual(['first-turn-token', 'second-turn-token']);
    expect(tokenCalls).toEqual([undefined, undefined]);
    expect(firstEvents).toContainEqual(
      expect.objectContaining({
        event: 'assistant.delta',
        args: { turnId: 0, delta: 'Generated with first-turn-token' },
      }),
    );
    expect(secondEvents).toContainEqual(
      expect.objectContaining({
        event: 'assistant.delta',
        args: { turnId: 1, delta: 'Generated with second-turn-token' },
      }),
    );
    expect(firstEvents).not.toContainEqual(
      expect.objectContaining({ event: 'turn.step.interrupted' }),
    );
    expect(secondEvents).not.toContainEqual(
      expect.objectContaining({ event: 'turn.step.interrupted' }),
    );
  });

  it('emits LLM stream timing on step completion', async () => {
    const ctx = testAgent();
    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'timed answer' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    await ctx.untilTurnEnd();

    const stepCompleted = ctx.allEvents.find(
      (event) => event.type === '[rpc]' && event.event === 'turn.step.completed',
    );
    expect(stepCompleted?.args).toMatchObject({
      llmFirstTokenLatencyMs: expect.any(Number),
      llmStreamDurationMs: expect.any(Number),
    });
  });

  it('logs LLM request metadata without message bodies', async () => {
    const { logger, entries } = captureLogs();
    const ctx = testAgent(logServices(logger));
    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({
      input: [{ type: 'text', text: 'secret prompt body should stay out of logs' }],
    });
    await ctx.untilTurnEnd();

    const configLogs = entries.filter((entry) => entry.message === 'llm config');
    expect(configLogs).toHaveLength(1);
    const configPayload = configLogs[0]?.payload as Record<string, unknown>;
    expect(configPayload).toMatchObject({
      turnStep: '0.1',
      provider: 'kimi',
      model: 'mock-model',
      modelAlias: 'mock-model',
      toolCount: 21,
    });
    expect(configPayload['systemPromptChars']).toEqual(expect.any(Number));

    const requestLogs = entries.filter((entry) => entry.message === 'llm request');
    expect(requestLogs).toHaveLength(1);
    const payload = requestLogs[0]?.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      turnStep: '0.1',
    });
    expect(payload).not.toHaveProperty('estimatedInputTokens');
    expect(payload).not.toHaveProperty('turnId');
    expect(payload).not.toHaveProperty('step');
    expect(payload).not.toHaveProperty('attempt');
    expect(payload).not.toHaveProperty('maxAttempts');
    expect(payload).not.toHaveProperty('stepUuid');
    expect(payload).not.toHaveProperty('model');
    expect(payload).not.toHaveProperty('provider');
    expect(payload).not.toHaveProperty('modelAlias');
    expect(payload).not.toHaveProperty('thinkingEffort');
    expect(payload).not.toHaveProperty('systemPromptChars');
    expect(payload).not.toHaveProperty('partialMessageCount');
    expect(payload).not.toHaveProperty('messageCount');
    expect(payload).not.toHaveProperty('toolCallCount');
    expect(payload).not.toHaveProperty('toolCount');
    expect(payload).not.toHaveProperty('systemPromptHash');
    expect(payload).not.toHaveProperty('toolsHash');
    expect(payload).not.toHaveProperty('messageRoles');
    expect(payload).not.toHaveProperty('contentPartTypes');
    expect(payload).not.toHaveProperty('toolNames');
    expect(payload).not.toHaveProperty('history');
    expect(payload).not.toHaveProperty('systemPrompt');
    expect(JSON.stringify(entries)).not.toContain('secret prompt body should stay out of logs');
  });

  it('logs an llm response line with the timing split', async () => {
    const { logger, entries } = captureLogs();
    const ctx = testAgent(logServices(logger));
    ctx.configure();
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    await ctx.untilTurnEnd();

    const responseLogs = entries.filter((entry) => entry.message === 'llm response');
    expect(responseLogs).toHaveLength(1);
    const payload = responseLogs[0]?.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      turnStep: '0.1',
      ttftMs: expect.any(Number),
      streamDurationMs: expect.any(Number),
      outputTokens: expect.any(Number),
      serverDecodeMs: expect.any(Number),
      clientConsumeMs: expect.any(Number),
    });
    // The scripted provider does not report the request-dispatch boundary, so
    // the TTFT split is omitted from the log.
    expect(payload).not.toHaveProperty('requestBuildMs');
    expect(payload).not.toHaveProperty('serverFirstTokenMs');
  });

  it('does not repeat unchanged LLM config metadata', async () => {
    const { logger, entries } = captureLogs();
    const ctx = testAgent(logServices(logger));
    ctx.configure();

    ctx.mockNextResponse({ type: 'text', text: 'first' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'first prompt' }] });
    await ctx.untilTurnEnd();

    ctx.mockNextResponse({ type: 'text', text: 'second' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'second prompt' }] });
    await ctx.untilTurnEnd();

    expect(entries.filter((entry) => entry.message === 'llm config')).toHaveLength(1);
    expect(entries.filter((entry) => entry.message === 'llm request')).toHaveLength(2);
  });

  it('logs changed LLM config when same-size system prompt content changes', async () => {
    const { logger, entries } = captureLogs();
    const ctx = testAgent(logServices(logger));
    ctx.configure();

    ctx.get(IAgentProfileService).update({ systemPrompt: 'alpha' });
    ctx.mockNextResponse({ type: 'text', text: 'first' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'first prompt' }] });
    await ctx.untilTurnEnd();

    ctx.get(IAgentProfileService).update({ systemPrompt: 'bravo' });
    ctx.mockNextResponse({ type: 'text', text: 'second' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'second prompt' }] });
    await ctx.untilTurnEnd();

    const configPayloads = entries
      .filter((entry) => entry.message === 'llm config')
      .map((entry) => entry.payload as Record<string, unknown>);
    expect(configPayloads).toHaveLength(2);
    expect(configPayloads.map((payload) => payload['systemPromptChars'])).toEqual([5, 5]);
    for (const payload of configPayloads) {
      expect(payload).not.toHaveProperty('systemPromptHash');
      expect(payload).not.toHaveProperty('toolsHash');
    }
  });

  it('does not log estimated LLM request tokens when tools are present', async () => {
    const { logger, entries } = captureLogs();
    const ctx = testAgent(logServices(logger));
    ctx.configure();
    await ctx.rpc.setActiveTools({ names: ['Bash'] });
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'use bash' }] });
    await ctx.untilTurnEnd();

    const input = ctx.llmCalls[0];
    expect(input?.tools.length).toBeGreaterThan(0);
    const requestPayload = entries.find((entry) => entry.message === 'llm request')?.payload as
      | Record<string, unknown>
      | undefined;
    expect(requestPayload).not.toHaveProperty('estimatedInputTokens');
  });

  it('classifies OAuth resolver connection failures as provider connection errors without retrying', async () => {
    const tokenCalls: Array<boolean | undefined> = [];
    const oauthOptions = oauthAgentOptions(async (options) => {
      tokenCalls.push(options?.force);
      throw new KimiError(
        ErrorCodes.PROVIDER_CONNECTION_ERROR,
        'OAuth provider "managed:kimi-code" failed to fetch an access token: fetch failed',
      );
    });
    const generate = vi.fn<GenerateFn>();
    const ctx = testAgent(oauthOptions.services, {
      initialConfig: oauthOptions.initialConfig,
      generate,
    });
    ctx.configure();
    await ctx.rpc.setModel({ model: 'kimi-code' });
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello after token expiry' }] });
    const events = await ctx.untilTurnEnd();

    expect(tokenCalls).toEqual([undefined]);
    expect(generate).not.toHaveBeenCalled();
    expect(events).not.toContainEqual(expect.objectContaining({ event: 'assistant.delta' }));
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({
          reason: 'failed',
          error: expect.objectContaining({
            code: ErrorCodes.PROVIDER_CONNECTION_ERROR,
            message: expect.stringContaining('fetch failed'),
            retryable: true,
          }),
        }),
      }),
    );
  });

  it('classifies explicit OAuth login-required resolver failures as auth errors', async () => {
    const tokenCalls: Array<boolean | undefined> = [];
    const oauthOptions = oauthAgentOptions(async (options) => {
      tokenCalls.push(options?.force);
      throw new KimiError(ErrorCodes.AUTH_LOGIN_REQUIRED, 'not logged in');
    });
    const generate = vi.fn<GenerateFn>();
    const ctx = testAgent(oauthOptions.services, {
      initialConfig: oauthOptions.initialConfig,
      generate,
    });
    ctx.configure();
    await ctx.rpc.setModel({ model: 'kimi-code' });
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello after token expiry' }] });
    const events = await ctx.untilTurnEnd();

    expect(tokenCalls).toEqual([undefined]);
    expect(generate).not.toHaveBeenCalled();
    expect(events).not.toContainEqual(expect.objectContaining({ event: 'assistant.delta' }));
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({
          reason: 'failed',
          error: expect.objectContaining({
            code: ErrorCodes.AUTH_LOGIN_REQUIRED,
            retryable: false,
          }),
        }),
      }),
    );
  });

  it('honors configured maxStepsPerTurn in agent turns', async () => {
    const ctx = testAgent(execEnvServices({ processRunner: createCommandRunner('loop-output') }), {
      initialConfig: {
        providers: {},
        loopControl: { maxStepsPerTurn: 1 },
      },
    });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });
    ctx.newEvents();

    const bashCall: ToolCall = {
      id: 'call_bash',
      type: 'function',
      name: 'Bash',
      arguments: '{"command":"printf loop-output","timeout":60}',
    };
    ctx.mockNextResponse(bashCall);

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run a command once' }] });
    const events = await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({
          reason: 'failed',
          error: expect.objectContaining({
            code: 'loop.max_steps_exceeded',
            details: expect.objectContaining({
              maxSteps: 1,
            }),
          }),
        }),
      }),
    );
    const maxStepsMessage = (
      ctx.allEvents.find((event) => event.type === '[rpc]' && event.event === 'turn.ended')?.args as
        | { error?: { message?: unknown } }
        | undefined
    )?.error?.message;
    expect(maxStepsMessage).toEqual(expect.stringContaining('loop_control.max_steps_per_turn'));
    expect(maxStepsMessage).toEqual(expect.stringContaining('/update-config'));
    expect(maxStepsMessage).toEqual(expect.stringContaining('/reload'));
  });

  it('force-refreshes OAuth credentials and replays the request on 401', async () => {
    const tokenCalls: Array<boolean | undefined> = [];
    const authKeys: string[] = [];
    const oauthOptions = oauthAgentOptions(async (options) => {
      tokenCalls.push(options?.force);
      return options?.force === true ? 'forced-refresh-token' : 'fresh-token';
    });
    const generate: GenerateFn = async (
      _provider,
      _system,
      _tools,
      _history,
      callbacks,
      options,
    ) => {
      const apiKey = options?.auth?.apiKey ?? '<missing>';
      authKeys.push(apiKey);
      if (authKeys.length === 1) throw new APIStatusError(401, 'Unauthorized', 'req-401');
      const text = `Generated with ${apiKey}`;
      await callbacks?.onMessagePart?.({ type: 'text', text });
      return textResult(text);
    };
    const ctx = testAgent(oauthOptions.services, {
      initialConfig: oauthOptions.initialConfig,
      generate,
    });
    ctx.configure();
    await ctx.rpc.setModel({ model: 'kimi-code' });
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello after token expiry' }] });
    const events = await ctx.untilTurnEnd();

    expect(authKeys).toEqual(['fresh-token', 'forced-refresh-token']);
    expect(tokenCalls).toEqual([undefined, true]);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'assistant.delta',
        args: { turnId: 0, delta: 'Generated with forced-refresh-token' },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'completed' }),
      }),
    );
  });

  it('falls back to login_required when force-refresh and replay both 401', async () => {
    const tokenCalls: Array<boolean | undefined> = [];
    const authKeys: string[] = [];
    const oauthOptions = oauthAgentOptions(
      async (options) => {
        tokenCalls.push(options?.force);
        return options?.force === true ? 'forced-refresh-token' : 'fresh-token';
      },
      ['image_in', 'video_in', 'tool_use'],
    );
    const generate: GenerateFn = async (
      _provider,
      _system,
      _tools,
      _history,
      _callbacks,
      options,
    ) => {
      authKeys.push(options?.auth?.apiKey ?? '<missing>');
      throw new APIStatusError(401, 'Unauthorized', 'req-401');
    };
    const ctx = testAgent(oauthOptions.services, {
      initialConfig: oauthOptions.initialConfig,
      generate,
    });
    ctx.configure();
    await ctx.rpc.setModel({ model: 'kimi-code' });
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    const events = await ctx.untilTurnEnd();

    expect(authKeys).toEqual(['fresh-token', 'forced-refresh-token']);
    expect(tokenCalls).toEqual([undefined, true]);
    expect(events).not.toContainEqual(expect.objectContaining({ event: 'assistant.delta' }));
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({
          reason: 'failed',
          error: expect.objectContaining({
            code: 'auth.login_required',
            details: expect.objectContaining({
              statusCode: 401,
              requestId: 'req-401',
            }),
          }),
        }),
      }),
    );
  });

  it('keeps non-OAuth provider 401 as provider auth error', async () => {
    const generate: GenerateFn = async () => {
      throw new APIStatusError(401, 'Unauthorized', 'req-api-key-401');
    };
    const ctx = testAgent({ generate });
    ctx.configure();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    const events = await ctx.untilTurnEnd();

    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({
          reason: 'failed',
          error: expect.objectContaining({
            code: 'provider.auth_error',
            details: expect.objectContaining({
              statusCode: 401,
              requestId: 'req-api-key-401',
            }),
          }),
        }),
      }),
    );
  });

  it.each<ApiErrorTelemetryCase>([
    {
      name: '429 status',
      createError: () => new APIStatusError(429, 'Rate limited', 'req-429'),
      errorType: 'rate_limit',
      statusCode: 429,
    },
    {
      name: '401 status',
      createError: () => new APIStatusError(401, 'Unauthorized', 'req-401'),
      errorType: 'auth',
      statusCode: 401,
    },
    {
      name: '403 status',
      createError: () => new APIStatusError(403, 'Forbidden', 'req-403'),
      errorType: 'auth',
      statusCode: 403,
    },
    {
      name: '500 status',
      createError: () => new APIStatusError(500, 'Internal server error', 'req-500'),
      errorType: '5xx_server',
      statusCode: 500,
    },
    {
      name: '400 status',
      createError: () => new APIStatusError(400, 'Bad request', 'req-400'),
      errorType: '4xx_client',
      statusCode: 400,
    },
    {
      name: 'context overflow status',
      createError: () => new APIStatusError(422, 'Maximum context window exceeded', 'req-422'),
      errorType: 'context_overflow',
      statusCode: 422,
    },
    {
      name: 'context overflow token count status',
      createError: () =>
        new APIStatusError(
          400,
          'input token count 131072 exceeds the maximum number of tokens allowed',
          'req-token-count',
        ),
      errorType: 'context_overflow',
      statusCode: 400,
    },
    {
      name: 'connection error',
      createError: () => new APIConnectionError('socket hang up'),
      errorType: 'network',
    },
    {
      name: 'timeout error',
      createError: () => new APITimeoutError('request timed out'),
      errorType: 'timeout',
    },
    {
      name: 'empty response error',
      createError: () => new APIEmptyResponseError('empty response'),
      errorType: 'empty_response',
    },
    {
      name: 'generic step error',
      createError: () => new Error('unexpected step failure'),
      errorType: 'other',
    },
  ])('tracks api_error telemetry for $name', async ({ createError, errorType, statusCode }) => {
    const records: TelemetryRecord[] = [];
    const generate: GenerateFn = async () => {
      throw createError();
    };
    const ctx = testAgent({
      generate,
      ...singleAttemptAgentOptions(),
      telemetry: recordingTelemetry(records),
    });
    ctx.configure();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'trigger provider error' }] });
    await ctx.untilTurnEnd();

    const expectedProperties: Record<string, unknown> = {
      error_type: errorType,
      model: 'mock-model',
      retryable: expect.any(Boolean),
      duration_ms: expect.any(Number),
    };
    if (statusCode !== undefined) {
      expectedProperties['status_code'] = statusCode;
    }

    const record = records.find((candidate) => candidate.event === 'api_error');
    expect(record).toEqual({
      event: 'api_error',
      properties: expect.objectContaining(expectedProperties),
    });
    if (statusCode === undefined) {
      expect(record?.properties).not.toHaveProperty('status_code');
    }
  });

  it('keeps transient retry handling with request-scoped OAuth auth', async () => {
    const { logger, entries } = captureLogs();
    const authKeys: string[] = [];
    const oauthOptions = oauthAgentOptions(async () => 'fresh-token');
    const generate: GenerateFn = async (
      _provider,
      _system,
      _tools,
      _history,
      callbacks,
      options,
    ) => {
      options?.onRequestStart?.();
      authKeys.push(options?.auth?.apiKey ?? '<missing>');
      if (authKeys.length === 1) {
        throw new APIConnectionError('socket hang up');
      }
      await callbacks?.onMessagePart?.({ type: 'text', text: 'Recovered after retry' });
      options?.onStreamEnd?.();
      return textResult('Recovered after retry');
    };
    const ctx = testAgent(oauthOptions.services, logServices(logger), {
      initialConfig: oauthOptions.initialConfig,
      generate,
    });
    ctx.configure();
    await ctx.rpc.setModel({ model: 'kimi-code' });
    ctx.newEvents();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    const events = await ctx.untilTurnEnd();

    expect(authKeys).toEqual(['fresh-token', 'fresh-token']);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'turn.step.retrying',
        args: expect.objectContaining({
          failedAttempt: 1,
          nextAttempt: 2,
          errorName: 'APIConnectionError',
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'assistant.delta',
        args: { turnId: 0, delta: 'Recovered after retry' },
      }),
    );
    const requestLogs = entries.filter((entry) => entry.message === 'llm request');
    const payloads = requestLogs.map((entry) => entry.payload as Record<string, unknown>);
    expect(payloads[0]).toMatchObject({ turnStep: '0.1' });
    expect(payloads[0]).not.toHaveProperty('attempt');
    expect(payloads[1]).toMatchObject({ turnStep: '0.1', attempt: '2/3' });
  });

  it('force-refreshes OAuth credentials on video upload 401 and falls back to login_required when replay 401', async () => {
    const tokenCalls: Array<boolean | undefined> = [];
    const authKeys: string[] = [];
    const oauthOptions = oauthAgentOptions(
      async (options) => {
        tokenCalls.push(options?.force);
        return options?.force === true ? 'forced-refresh-token' : 'fresh-token';
      },
      ['image_in', 'video_in', 'tool_use'],
    );
    const provider = {
      uploadVideo: vi.fn().mockImplementation(async (_input, options) => {
        authKeys.push(options?.auth?.apiKey ?? '<missing>');
        throw new APIStatusError(401, 'Unauthorized', 'req-upload-401');
      }),
    } as unknown as ChatProvider;
    // The OAuth force-refresh-on-401 behavior now lives inside the `Model`
    // god-object (`uploadVideo` runs the provider call through the auth-refresh
    // wrapper). Inject the fake provider via the protocol registry so the
    // resolved Model uses it, then bind `model.uploadVideo` into the media
    // tool's `VideoUploader` shape the way the production wiring does.
    const fakeRegistry = {
      _serviceBrand: undefined,
      supportedProtocols: () => ['vertexai'] as const,
      createChatProvider: () => provider,
    } satisfies IProtocolAdapterRegistry & { createChatProvider: () => ChatProvider };
    const ctx = testAgent(
      oauthOptions.services,
      appServices((reg) => {
        reg.defineInstance(IProtocolAdapterRegistry, fakeRegistry);
      }),
      execEnvServices({ hostFs: createVideoHostFs() }),
      {
        initialConfig: oauthOptions.initialConfig,
        autoConfigure: false,
      },
    );
    const profile = ctx.get(IAgentProfileService);
    profile.update({
      cwd: '/workspace',
      modelAlias: 'kimi-code',
      systemPrompt: 'test system prompt',
      thinkingLevel: 'off',
    });
    const videoUploader = createVideoUploader(ctx.modelResolver.resolve('kimi-code'));
    if (videoUploader === undefined) throw new Error('OAuth model did not resolve a video uploader');
    const registration = registerMediaTools(ctx.get(IAgentToolRegistryService), {
      fs: ctx.get(IHostFileSystem),
      env: ctx.get(IHostEnvironment),
      workspace: { workspaceDir: '/workspace', additionalDirs: [] },
      capabilities: mediaCapabilities(),
      videoUploader,
    });
    profile.update({ activeToolNames: ['ReadMediaFile'] });

    try {
      const tool = ctx.get(IAgentToolRegistryService).resolve('ReadMediaFile');
      if (tool === undefined) throw new Error('ReadMediaFile tool was not initialized');
      const result = await executeTool(tool, {
        turnId: 1,
        toolCallId: 'call_media',
        args: { path: '/workspace/sample.mp4' },
        signal: new AbortController().signal,
      });

      expect(result.isError).toBe(true);
      expect(authKeys).toEqual(['fresh-token', 'forced-refresh-token']);
      expect(tokenCalls).toEqual([undefined, true]);
      expect(result.output).toContain('OAuth provider credentials were rejected');
      expect(result.output).toContain('Send /login to login');
    } finally {
      registration.dispose();
    }
  });

  it('cancels an active turn', async () => {
    const records: TelemetryRecord[] = [];
    const ctx = testAgent(execEnvServices({ processRunner: createCommandRunner('should-not-run') }), {
      telemetry: recordingTelemetry(records),
    });
    ctx.configure({ tools: ['Bash'] });

    ctx.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run a command' }] });

    expect(await ctx.untilApprovalRequest()).toMatchInlineSnapshot(`
      [wire] turn.prompt                     { "input": [ { "type": "text", "text": "Run a command" } ], "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started                    { "turnId": 0, "origin": { "kind": "user" } }
      [wire] context.append_message          { "message": { "role": "user", "content": [ { "type": "text", "text": "Run a command" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [emit] context.spliced                 { "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Run a command" } ], "toolCalls": [], "origin": { "kind": "user" } } ] }
      [emit] turn.step.started               { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [wire] context.append_loop_event       { "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
      [wire] llm.tools_snapshot              { "hash": "878fc967171856c1b535c0bc43b4b06aa8141d637871c13f40f965cdaaa45df9", "tools": [ { "name": "Bash", "description": "Execute a \`bash\` command. Use this for shell semantics — pipes, env, processes, git, package managers, build/test runners, anything genuinely interactive or multi-step.\\n\\n**Translate these to a dedicated tool instead:**\\n- \`cat\` / \`head\` / \`tail\` (known path) → \`Read\`\\n- \`sed\` / \`awk\` (in-place edit) → \`Edit\`\\n- \`echo > file\` / \`cat <<EOF\` → \`Write\`\\n- \`find\` / recursive \`ls\` to locate files by name pattern → \`Glob\` (plain \`ls <known-directory>\` is fine for listing a directory)\\n- \`grep\` / \`rg\` (search file contents) → \`Grep\`\\n- \`echo\` / \`printf\` (talk to the user) → just output text directly\\n\\nThe dedicated tools render in the per-tool permission UI and keep raw stdout out of the conversation; that is why they are worth reaching for whenever one fits.\\n\\n**Output:**\\nThe stdout and stderr will be combined and returned as a string. The output may be truncated if it is too long. If the command exits non-zero, the output ends with a \`Command failed with exit code: N\` line; a command killed by its timeout or interrupted by the user ends with its own message instead.\\n\\nBackground execution is disabled for this agent. Do not set \`run_in_background=true\`.\\n\\n**Guidelines for safety and security:**\\n- Each shell tool call will be executed in a fresh shell environment. The shell variables, current working directory changes, and the shell history is not preserved between calls. To run a command in a particular directory, pass the \`cwd\` argument (or use absolute paths) rather than relying on a \`cd\` from an earlier call.\\n- The tool call will return after the command is finished. You shall not use this tool to execute an interactive command or a command that may run forever. For possibly long-running commands, set the \`timeout\` argument in seconds. The default is 60s; foreground commands allow up to 300s.\\n- Avoid using \`..\` to access files or directories outside of the working directory.\\n- Avoid modifying files outside of the working directory unless explicitly instructed to do so.\\n- Never run commands that require superuser privileges unless explicitly instructed to do so.\\n\\n**Guidelines for efficiency:**\\n- Use \`&&\` to chain commands that genuinely depend on each other, e.g. \`npm install && npm test\`. Independent read-only commands (separate \`git show\`, \`ls\`, or status checks) should be issued as separate parallel Bash calls in one response, not chained into a single call — chaining serializes their execution and mixes their output. Do not stitch outputs together with \`echo\` separators.\\n- Use \`;\` to run commands sequentially regardless of success/failure\\n- Use \`||\` for conditional execution (run second command only if first fails)\\n- Use pipe operations (\`|\`) and redirections (\`>\`, \`>>\`) to chain input and output between commands\\n- Always quote file paths containing spaces with double quotes (e.g., cd \\"/path with spaces/\\")\\n- Compose multi-step logic in a single call with \`if\` / \`case\` / \`for\` / \`while\` control flows.\\n- Do not set \`run_in_background=true\`; background task management tools are not available.\\n\\n**Commands available:**\\nThe following common command categories are usually available. Availability still depends on the host, so when in doubt run \`which <command>\` first to confirm a command exists before relying on it.\\n- Navigation and inspection: \`ls\`, \`pwd\`, \`cd\`, \`stat\`, \`file\`, \`du\`, \`df\`, \`tree\`\\n- File and directory management: \`cp\`, \`mv\`, \`rm\`, \`mkdir\`, \`touch\`, \`ln\`, \`chmod\`, \`chown\`\\n- Text and data processing: \`wc\`, \`sort\`, \`uniq\`, \`cut\`, \`tr\`, \`diff\`, \`xargs\`\\n- Archives and compression: \`tar\`, \`gzip\`, \`gunzip\`, \`zip\`, \`unzip\`\\n- Networking and transfer: \`curl\`, \`wget\`, \`ping\`, \`ssh\`, \`scp\`\\n- Version control: \`git\`; for GitHub-hosted work (PRs, issues, CI runs, API queries) prefer the \`gh\` CLI when installed — it carries the user's GitHub auth and can return structured JSON\\n- Process and system: \`ps\`, \`kill\`, \`top\`, \`env\`, \`date\`, \`uname\`, \`whoami\`\\n- Language and package toolchains: \`node\`, \`npm\`, \`pnpm\`, \`yarn\`, \`python\`, \`pip\` (use whichever the project actually relies on)\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "command": { "type": "string", "minLength": 1, "description": "The command to execute." }, "cwd": { "description": "The working directory in which to run the command. When omitted, the command runs in the session's working directory.", "type": "string" }, "timeout": { "default": 60, "description": "Optional timeout in seconds for the command to execute. Foreground default 60s, max 300s. Background default 600s, max 86400s. Ignored for background commands when disable_timeout=true.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 }, "description": { "description": "A short description for the background task. Required when run_in_background is true.", "type": "string" }, "run_in_background": { "description": "Whether to run the command as a background task.", "type": "boolean" }, "disable_timeout": { "description": "If true, do not apply a timeout to the command. Only applies when run_in_background is true.", "type": "boolean" } }, "required": [ "command" ], "additionalProperties": false } } ], "time": "<time>" }
      [wire] llm.request                     { "kind": "loop", "provider": "kimi", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 1000000, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "878fc967171856c1b535c0bc43b4b06aa8141d637871c13f40f965cdaaa45df9", "messageCount": 1, "turnStep": "0.1", "time": "<time>" }
      [emit] assistant.delta                 { "turnId": 0, "delta": "I will run Bash." }
      [emit] tool.call.delta                 { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "argumentsPart": "{\\"command\\":\\"printf should-not-run\\",\\"timeout\\":60}" }
      [emit] agent.status.updated            { "contextTokens": 27 }
      [wire] context.append_loop_event       { "event": { "type": "content.part", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "I will run Bash." } }, "time": "<time>" }
      [emit] permission.approval.requested   { "sessionId": "test-session", "agentId": "main", "turnId": 0, "toolCallId": "call_bash", "toolName": "Bash", "action": "Running: printf should-not-run", "display": { "kind": "command", "command": "printf should-not-run", "cwd": "<cwd>", "language": "bash" }, "toolInput": { "command": "printf should-not-run", "timeout": 60 } }
      [emit] requestApproval                 { "turnId": 0, "toolCallId": "call_bash", "toolName": "Bash", "action": "Running: printf should-not-run", "display": { "kind": "command", "command": "printf should-not-run", "cwd": "<cwd>", "language": "bash" } }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: Bash
      messages:
        user: text "Run a command"
    `);
    records.length = 0;
    await ctx.rpc.cancel({ turnId: 0 });
    expect(records).toContainEqual({
      event: 'cancel',
      properties: { from: 'streaming' },
    });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] turn.cancel             { "turnId": 0, "time": "<time>" }
      [emit] turn.step.interrupted   { "turnId": 0, "step": 1, "reason": "aborted" }
      [emit] turn.ended              { "turnId": 0, "reason": "cancelled" }
    `);
    expect(records.some((record) => record.event === 'tool_call')).toBe(false);
    await ctx.expectResumeMatches();
  });

  it('buffers steer input and includes it in the same turn after approval', async () => {
    const bashCall: ToolCall = {
      type: 'function',
      id: 'call_bash',
      name: 'Bash',
      arguments: '{"command":"printf approved","timeout":60}',
    };
    const ctx = testAgent(execEnvServices({ processRunner: createCommandRunner('approved') }));
    ctx.configure({ tools: ['Bash'] });

    ctx.mockNextResponse({ type: 'text', text: 'I will ask first.' }, bashCall);
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run Bash, then listen' }] });

    const approval = await ctx.takeApprovalRequest();
    expect(approval.events).toMatchInlineSnapshot(`
      [wire] turn.prompt                     { "input": [ { "type": "text", "text": "Run Bash, then listen" } ], "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started                    { "turnId": 0, "origin": { "kind": "user" } }
      [wire] context.append_message          { "message": { "role": "user", "content": [ { "type": "text", "text": "Run Bash, then listen" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [emit] context.spliced                 { "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Run Bash, then listen" } ], "toolCalls": [], "origin": { "kind": "user" } } ] }
      [emit] turn.step.started               { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [wire] context.append_loop_event       { "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
      [wire] llm.tools_snapshot              { "hash": "878fc967171856c1b535c0bc43b4b06aa8141d637871c13f40f965cdaaa45df9", "tools": [ { "name": "Bash", "description": "Execute a \`bash\` command. Use this for shell semantics — pipes, env, processes, git, package managers, build/test runners, anything genuinely interactive or multi-step.\\n\\n**Translate these to a dedicated tool instead:**\\n- \`cat\` / \`head\` / \`tail\` (known path) → \`Read\`\\n- \`sed\` / \`awk\` (in-place edit) → \`Edit\`\\n- \`echo > file\` / \`cat <<EOF\` → \`Write\`\\n- \`find\` / recursive \`ls\` to locate files by name pattern → \`Glob\` (plain \`ls <known-directory>\` is fine for listing a directory)\\n- \`grep\` / \`rg\` (search file contents) → \`Grep\`\\n- \`echo\` / \`printf\` (talk to the user) → just output text directly\\n\\nThe dedicated tools render in the per-tool permission UI and keep raw stdout out of the conversation; that is why they are worth reaching for whenever one fits.\\n\\n**Output:**\\nThe stdout and stderr will be combined and returned as a string. The output may be truncated if it is too long. If the command exits non-zero, the output ends with a \`Command failed with exit code: N\` line; a command killed by its timeout or interrupted by the user ends with its own message instead.\\n\\nBackground execution is disabled for this agent. Do not set \`run_in_background=true\`.\\n\\n**Guidelines for safety and security:**\\n- Each shell tool call will be executed in a fresh shell environment. The shell variables, current working directory changes, and the shell history is not preserved between calls. To run a command in a particular directory, pass the \`cwd\` argument (or use absolute paths) rather than relying on a \`cd\` from an earlier call.\\n- The tool call will return after the command is finished. You shall not use this tool to execute an interactive command or a command that may run forever. For possibly long-running commands, set the \`timeout\` argument in seconds. The default is 60s; foreground commands allow up to 300s.\\n- Avoid using \`..\` to access files or directories outside of the working directory.\\n- Avoid modifying files outside of the working directory unless explicitly instructed to do so.\\n- Never run commands that require superuser privileges unless explicitly instructed to do so.\\n\\n**Guidelines for efficiency:**\\n- Use \`&&\` to chain commands that genuinely depend on each other, e.g. \`npm install && npm test\`. Independent read-only commands (separate \`git show\`, \`ls\`, or status checks) should be issued as separate parallel Bash calls in one response, not chained into a single call — chaining serializes their execution and mixes their output. Do not stitch outputs together with \`echo\` separators.\\n- Use \`;\` to run commands sequentially regardless of success/failure\\n- Use \`||\` for conditional execution (run second command only if first fails)\\n- Use pipe operations (\`|\`) and redirections (\`>\`, \`>>\`) to chain input and output between commands\\n- Always quote file paths containing spaces with double quotes (e.g., cd \\"/path with spaces/\\")\\n- Compose multi-step logic in a single call with \`if\` / \`case\` / \`for\` / \`while\` control flows.\\n- Do not set \`run_in_background=true\`; background task management tools are not available.\\n\\n**Commands available:**\\nThe following common command categories are usually available. Availability still depends on the host, so when in doubt run \`which <command>\` first to confirm a command exists before relying on it.\\n- Navigation and inspection: \`ls\`, \`pwd\`, \`cd\`, \`stat\`, \`file\`, \`du\`, \`df\`, \`tree\`\\n- File and directory management: \`cp\`, \`mv\`, \`rm\`, \`mkdir\`, \`touch\`, \`ln\`, \`chmod\`, \`chown\`\\n- Text and data processing: \`wc\`, \`sort\`, \`uniq\`, \`cut\`, \`tr\`, \`diff\`, \`xargs\`\\n- Archives and compression: \`tar\`, \`gzip\`, \`gunzip\`, \`zip\`, \`unzip\`\\n- Networking and transfer: \`curl\`, \`wget\`, \`ping\`, \`ssh\`, \`scp\`\\n- Version control: \`git\`; for GitHub-hosted work (PRs, issues, CI runs, API queries) prefer the \`gh\` CLI when installed — it carries the user's GitHub auth and can return structured JSON\\n- Process and system: \`ps\`, \`kill\`, \`top\`, \`env\`, \`date\`, \`uname\`, \`whoami\`\\n- Language and package toolchains: \`node\`, \`npm\`, \`pnpm\`, \`yarn\`, \`python\`, \`pip\` (use whichever the project actually relies on)\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "command": { "type": "string", "minLength": 1, "description": "The command to execute." }, "cwd": { "description": "The working directory in which to run the command. When omitted, the command runs in the session's working directory.", "type": "string" }, "timeout": { "default": 60, "description": "Optional timeout in seconds for the command to execute. Foreground default 60s, max 300s. Background default 600s, max 86400s. Ignored for background commands when disable_timeout=true.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 }, "description": { "description": "A short description for the background task. Required when run_in_background is true.", "type": "string" }, "run_in_background": { "description": "Whether to run the command as a background task.", "type": "boolean" }, "disable_timeout": { "description": "If true, do not apply a timeout to the command. Only applies when run_in_background is true.", "type": "boolean" } }, "required": [ "command" ], "additionalProperties": false } } ], "time": "<time>" }
      [wire] llm.request                     { "kind": "loop", "provider": "kimi", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 1000000, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "878fc967171856c1b535c0bc43b4b06aa8141d637871c13f40f965cdaaa45df9", "messageCount": 1, "turnStep": "0.1", "time": "<time>" }
      [emit] assistant.delta                 { "turnId": 0, "delta": "I will ask first." }
      [emit] tool.call.delta                 { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "argumentsPart": "{\\"command\\":\\"printf approved\\",\\"timeout\\":60}" }
      [emit] agent.status.updated            { "contextTokens": 29 }
      [wire] context.append_loop_event       { "event": { "type": "content.part", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "I will ask first." } }, "time": "<time>" }
      [emit] permission.approval.requested   { "sessionId": "test-session", "agentId": "main", "turnId": 0, "toolCallId": "call_bash", "toolName": "Bash", "action": "Running: printf approved", "display": { "kind": "command", "command": "printf approved", "cwd": "<cwd>", "language": "bash" }, "toolInput": { "command": "printf approved", "timeout": 60 } }
      [emit] requestApproval                 { "turnId": 0, "toolCallId": "call_bash", "toolName": "Bash", "action": "Running: printf approved", "display": { "kind": "command", "command": "printf approved", "cwd": "<cwd>", "language": "bash" } }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: Bash
      messages:
        user: text "Run Bash, then listen"
    `);
    expect(ctx.llmCalls).toHaveLength(1);

    await ctx.rpc.steer({ input: [{ type: 'text', text: 'Also mention the steer.' }] });
    expect(ctx.llmCalls).toHaveLength(1);
    expect(ctx.newEvents()).toMatchInlineSnapshot(`[]`);

    ctx.mockNextResponse({ type: 'text', text: 'Approved, and I saw the steer.' });
    approval.respond({
      decision: 'approved',
      selectedLabel: 'approve',
    });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [emit] permission.approval.resolved        { "sessionId": "test-session", "agentId": "main", "turnId": 0, "toolCallId": "call_bash", "toolName": "Bash", "action": "Running: printf approved", "display": { "kind": "command", "command": "printf approved", "cwd": "<cwd>", "language": "bash" }, "toolInput": { "command": "printf approved", "timeout": 60 }, "decision": "approved", "selectedLabel": "approve" }
      [wire] permission.record_approval_result   { "turnId": 0, "toolCallId": "call_bash", "toolName": "Bash", "action": "Running: printf approved", "result": { "decision": "approved", "selectedLabel": "approve" }, "time": "<time>" }
      [emit] tool.call.started                   { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf approved", "timeout": 60 }, "description": "Running: printf approved", "display": { "kind": "command", "command": "printf approved", "cwd": "<cwd>", "language": "bash" } }
      [wire] context.append_loop_event           { "event": { "type": "tool.call", "uuid": "<uuid-3>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf approved", "timeout": 60 } }, "time": "<time>" }
      [emit] tool.progress                       { "turnId": 0, "toolCallId": "call_bash", "update": { "kind": "stdout", "text": "approved" } }
      [emit] tool.result                         { "turnId": 0, "toolCallId": "call_bash", "output": "approved" }
      [wire] context.append_loop_event           { "event": { "type": "tool.result", "parentUuid": "<uuid-3>", "toolCallId": "call_bash", "result": { "output": "approved" } }, "time": "<time>" }
      [wire] context.append_loop_event           { "event": { "type": "step.end", "uuid": "<uuid-1>", "turnId": "0", "step": 1, "finishReason": "tool_use", "usage": { "inputOther": 7, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-1", "providerFinishReason": "tool_calls", "rawFinishReason": "tool_calls" }, "time": "<time>" }
      [wire] usage.record                        { "model": "mock-model", "usage": { "inputOther": 7, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated                { "usage": { "byModel": { "mock-model": { "inputOther": 7, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 7, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 7, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [emit] turn.step.completed                 { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 7, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use", "providerFinishReason": "tool_calls", "rawFinishReason": "tool_calls" }
      [wire] turn.steer                          { "input": [ { "type": "text", "text": "Also mention the steer." } ], "origin": { "kind": "user" }, "time": "<time>" }
      [wire] context.append_message              { "message": { "role": "user", "content": [ { "type": "text", "text": "Also mention the steer." } ], "toolCalls": [] }, "time": "<time>" }
      [emit] context.spliced                     { "start": 3, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Also mention the steer." } ], "toolCalls": [] } ] }
      [emit] turn.step.started                   { "turnId": 0, "step": 2, "stepId": "<uuid-4>" }
      [wire] context.append_loop_event           { "event": { "type": "step.begin", "uuid": "<uuid-4>", "turnId": "0", "step": 2 }, "time": "<time>" }
      [wire] llm.request                         { "kind": "loop", "provider": "kimi", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 999971, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "878fc967171856c1b535c0bc43b4b06aa8141d637871c13f40f965cdaaa45df9", "messageCount": 4, "turnStep": "0.2", "time": "<time>" }
      [emit] assistant.delta                     { "turnId": 0, "delta": "Approved, and I saw the steer." }
      [emit] agent.status.updated                { "contextTokens": 50 }
      [wire] context.append_loop_event           { "event": { "type": "content.part", "uuid": "<uuid-5>", "turnId": "0", "step": 2, "stepUuid": "<uuid-4>", "part": { "type": "text", "text": "Approved, and I saw the steer." } }, "time": "<time>" }
      [wire] context.append_loop_event           { "event": { "type": "step.end", "uuid": "<uuid-4>", "turnId": "0", "step": 2, "finishReason": "end_turn", "usage": { "inputOther": 39, "output": 11, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-2", "providerFinishReason": "completed", "rawFinishReason": "stop" }, "time": "<time>" }
      [wire] usage.record                        { "model": "mock-model", "usage": { "inputOther": 39, "output": 11, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated                { "usage": { "byModel": { "mock-model": { "inputOther": 46, "output": 33, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 46, "output": 33, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 46, "output": 33, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [emit] turn.step.completed                 { "turnId": 0, "step": 2, "stepId": "<uuid-4>", "usage": { "inputOther": 39, "output": 11, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn", "providerFinishReason": "completed", "rawFinishReason": "stop" }
      [emit] turn.ended                          { "turnId": 0, "reason": "completed" }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      messages:
        <last>
        assistant: text "I will ask first."  calls call_bash:Bash { "command": "printf approved", "timeout": 60 }
        tool[call_bash]: text "approved"
        user: text "Also mention the steer."
    `);
    expect(ctx.llmCalls).toHaveLength(2);
    await ctx.expectResumeMatches();
  });

  it('rejects a non-steer prompt while a turn is active', async () => {
    const ctx = testAgent(execEnvServices({ processRunner: createCommandRunner('should-not-run') }));
    ctx.configure({ tools: ['Bash'] });

    ctx.mockNextResponse({ type: 'text', text: 'I will wait for approval.' }, bashCall());
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Start the active turn' }] });

    const approval = await ctx.takeApprovalRequest();
    expect(approval.events).toMatchInlineSnapshot(`
      [wire] turn.prompt                     { "input": [ { "type": "text", "text": "Start the active turn" } ], "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started                    { "turnId": 0, "origin": { "kind": "user" } }
      [wire] context.append_message          { "message": { "role": "user", "content": [ { "type": "text", "text": "Start the active turn" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [emit] context.spliced                 { "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Start the active turn" } ], "toolCalls": [], "origin": { "kind": "user" } } ] }
      [emit] turn.step.started               { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [wire] context.append_loop_event       { "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
      [wire] llm.tools_snapshot              { "hash": "878fc967171856c1b535c0bc43b4b06aa8141d637871c13f40f965cdaaa45df9", "tools": [ { "name": "Bash", "description": "Execute a \`bash\` command. Use this for shell semantics — pipes, env, processes, git, package managers, build/test runners, anything genuinely interactive or multi-step.\\n\\n**Translate these to a dedicated tool instead:**\\n- \`cat\` / \`head\` / \`tail\` (known path) → \`Read\`\\n- \`sed\` / \`awk\` (in-place edit) → \`Edit\`\\n- \`echo > file\` / \`cat <<EOF\` → \`Write\`\\n- \`find\` / recursive \`ls\` to locate files by name pattern → \`Glob\` (plain \`ls <known-directory>\` is fine for listing a directory)\\n- \`grep\` / \`rg\` (search file contents) → \`Grep\`\\n- \`echo\` / \`printf\` (talk to the user) → just output text directly\\n\\nThe dedicated tools render in the per-tool permission UI and keep raw stdout out of the conversation; that is why they are worth reaching for whenever one fits.\\n\\n**Output:**\\nThe stdout and stderr will be combined and returned as a string. The output may be truncated if it is too long. If the command exits non-zero, the output ends with a \`Command failed with exit code: N\` line; a command killed by its timeout or interrupted by the user ends with its own message instead.\\n\\nBackground execution is disabled for this agent. Do not set \`run_in_background=true\`.\\n\\n**Guidelines for safety and security:**\\n- Each shell tool call will be executed in a fresh shell environment. The shell variables, current working directory changes, and the shell history is not preserved between calls. To run a command in a particular directory, pass the \`cwd\` argument (or use absolute paths) rather than relying on a \`cd\` from an earlier call.\\n- The tool call will return after the command is finished. You shall not use this tool to execute an interactive command or a command that may run forever. For possibly long-running commands, set the \`timeout\` argument in seconds. The default is 60s; foreground commands allow up to 300s.\\n- Avoid using \`..\` to access files or directories outside of the working directory.\\n- Avoid modifying files outside of the working directory unless explicitly instructed to do so.\\n- Never run commands that require superuser privileges unless explicitly instructed to do so.\\n\\n**Guidelines for efficiency:**\\n- Use \`&&\` to chain commands that genuinely depend on each other, e.g. \`npm install && npm test\`. Independent read-only commands (separate \`git show\`, \`ls\`, or status checks) should be issued as separate parallel Bash calls in one response, not chained into a single call — chaining serializes their execution and mixes their output. Do not stitch outputs together with \`echo\` separators.\\n- Use \`;\` to run commands sequentially regardless of success/failure\\n- Use \`||\` for conditional execution (run second command only if first fails)\\n- Use pipe operations (\`|\`) and redirections (\`>\`, \`>>\`) to chain input and output between commands\\n- Always quote file paths containing spaces with double quotes (e.g., cd \\"/path with spaces/\\")\\n- Compose multi-step logic in a single call with \`if\` / \`case\` / \`for\` / \`while\` control flows.\\n- Do not set \`run_in_background=true\`; background task management tools are not available.\\n\\n**Commands available:**\\nThe following common command categories are usually available. Availability still depends on the host, so when in doubt run \`which <command>\` first to confirm a command exists before relying on it.\\n- Navigation and inspection: \`ls\`, \`pwd\`, \`cd\`, \`stat\`, \`file\`, \`du\`, \`df\`, \`tree\`\\n- File and directory management: \`cp\`, \`mv\`, \`rm\`, \`mkdir\`, \`touch\`, \`ln\`, \`chmod\`, \`chown\`\\n- Text and data processing: \`wc\`, \`sort\`, \`uniq\`, \`cut\`, \`tr\`, \`diff\`, \`xargs\`\\n- Archives and compression: \`tar\`, \`gzip\`, \`gunzip\`, \`zip\`, \`unzip\`\\n- Networking and transfer: \`curl\`, \`wget\`, \`ping\`, \`ssh\`, \`scp\`\\n- Version control: \`git\`; for GitHub-hosted work (PRs, issues, CI runs, API queries) prefer the \`gh\` CLI when installed — it carries the user's GitHub auth and can return structured JSON\\n- Process and system: \`ps\`, \`kill\`, \`top\`, \`env\`, \`date\`, \`uname\`, \`whoami\`\\n- Language and package toolchains: \`node\`, \`npm\`, \`pnpm\`, \`yarn\`, \`python\`, \`pip\` (use whichever the project actually relies on)\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "command": { "type": "string", "minLength": 1, "description": "The command to execute." }, "cwd": { "description": "The working directory in which to run the command. When omitted, the command runs in the session's working directory.", "type": "string" }, "timeout": { "default": 60, "description": "Optional timeout in seconds for the command to execute. Foreground default 60s, max 300s. Background default 600s, max 86400s. Ignored for background commands when disable_timeout=true.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 }, "description": { "description": "A short description for the background task. Required when run_in_background is true.", "type": "string" }, "run_in_background": { "description": "Whether to run the command as a background task.", "type": "boolean" }, "disable_timeout": { "description": "If true, do not apply a timeout to the command. Only applies when run_in_background is true.", "type": "boolean" } }, "required": [ "command" ], "additionalProperties": false } } ], "time": "<time>" }
      [wire] llm.request                     { "kind": "loop", "provider": "kimi", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 1000000, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "878fc967171856c1b535c0bc43b4b06aa8141d637871c13f40f965cdaaa45df9", "messageCount": 1, "turnStep": "0.1", "time": "<time>" }
      [emit] assistant.delta                 { "turnId": 0, "delta": "I will wait for approval." }
      [emit] tool.call.delta                 { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "argumentsPart": "{\\"command\\":\\"printf should-not-run\\",\\"timeout\\":60}" }
      [emit] agent.status.updated            { "contextTokens": 32 }
      [wire] context.append_loop_event       { "event": { "type": "content.part", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "I will wait for approval." } }, "time": "<time>" }
      [emit] permission.approval.requested   { "sessionId": "test-session", "agentId": "main", "turnId": 0, "toolCallId": "call_bash", "toolName": "Bash", "action": "Running: printf should-not-run", "display": { "kind": "command", "command": "printf should-not-run", "cwd": "<cwd>", "language": "bash" }, "toolInput": { "command": "printf should-not-run", "timeout": 60 } }
      [emit] requestApproval                 { "turnId": 0, "toolCallId": "call_bash", "toolName": "Bash", "action": "Running: printf should-not-run", "display": { "kind": "command", "command": "printf should-not-run", "cwd": "<cwd>", "language": "bash" } }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: Bash
      messages:
        user: text "Start the active turn"
    `);
    await expect(
      ctx.rpc.prompt({ input: [{ type: 'text', text: 'This should not start a new turn' }] }),
    ).rejects.toMatchObject({
      code: ErrorCodes.ACTIVITY_AGENT_BUSY,
      details: { turnId: 0 },
    });

    expect(ctx.newEvents()).toMatchInlineSnapshot(`[]`);
    ctx.mockNextResponse({ type: 'text', text: 'I will not run it.' });
    approval.respond({
      decision: 'rejected',
      selectedLabel: 'reject',
    });
    const turnEndEvents = await ctx.untilTurnEnd();
    expect(turnEndEvents).not.toContain('[wire] turn.launch');
    expect(turnEndEvents).toContain('[emit] turn.ended');
    expect(turnEndEvents).toContain('"turnId": 0');
    await ctx.expectResumeMatches();
  });
});

const abortableGenerate: GenerateFn = async (
  _chat,
  _systemPrompt,
  _tools,
  _history,
  _callbacks,
  options,
) => {
  await new Promise<void>((_resolve, reject) => {
    const rejectAbort = () => {
      const error = new Error('Aborted');
      error.name = 'AbortError';
      reject(error);
    };
    if (options?.signal?.aborted === true) {
      rejectAbort();
      return;
    }
    options?.signal?.addEventListener('abort', rejectAbort, { once: true });
  });
  throw new Error('abortableGenerate unexpectedly completed');
};

function eventIndex(
  ctx: Pick<ReturnType<typeof testAgent>, 'allEvents'>,
  type: string,
  event: string,
): number {
  return ctx.allEvents.findIndex((entry) => entry.type === type && entry.event === event);
}

function bashCall(): ToolCall {
  return bashCallWithId('call_bash', 'printf should-not-run');
}

function bashCallWithId(id: string, command: string): ToolCall {
  return {
    type: 'function',
    id,
    name: 'Bash',
    arguments: JSON.stringify({ command, timeout: 60 }),
  };
}

function agentSwarmCall(): ToolCall {
  return {
    type: 'function',
    id: 'call_swarm',
    name: 'AgentSwarm',
    arguments: JSON.stringify({
      description: 'Review files',
      prompt_template: 'Review {{item}}',
      items: ['src/a.ts', 'src/b.ts'],
    }),
  };
}

interface ApiErrorTelemetryCase {
  readonly name: string;
  readonly createError: () => Error;
  readonly errorType: string;
  readonly statusCode?: number;
}

function singleAttemptAgentOptions(): Pick<TestAgentOptions, 'initialConfig'> {
  return {
    initialConfig: {
      providers: {},
      loopControl: { maxRetriesPerStep: 1 },
    },
  };
}

const MP4_HEADER = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftyp'),
  Buffer.from('mp42'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('mp42isom'),
]);

const DEFAULT_MEDIA_STAT = {
  stMode: 0o100644,
  stIno: 0,
  stDev: 0,
  stNlink: 1,
  stUid: 0,
  stGid: 0,
  stSize: MP4_HEADER.length,
  stAtime: 0,
  stMtime: 0,
  stCtime: 0,
};

function createExecRunner(output: string): {
  readonly runner: ISessionProcessRunner;
  readonly exec: ReturnType<typeof vi.fn>;
} {
  const exec = vi.fn(async (): Promise<IProcess> => ({
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as IProcess['stdin'],
    stdout: Readable.from([output]),
    stderr: Readable.from(['']),
    pid: 42,
    exitCode: 0,
    wait: vi.fn().mockResolvedValue(0) as IProcess['wait'],
    kill: vi.fn().mockResolvedValue(undefined) as IProcess['kill'],
    dispose: vi.fn().mockResolvedValue(undefined) as IProcess['dispose'],
  }));
  return { runner: createFakeProcessRunner({ exec }), exec };
}

function createVideoHostFs(): IHostFileSystem {
  return createFakeHostFs({
    stat: vi.fn(async () => ({
      isFile: true,
      isDirectory: false,
      size: MP4_HEADER.length,
    })),
    readBytes: vi.fn(async () => MP4_HEADER),
  });
}

async function waitForFile(path: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (existsSync(path)) return;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function mediaCapabilities(): ModelCapability {
  return {
    image_in: true,
    video_in: true,
    audio_in: false,
    thinking: false,
    tool_use: true,
    max_context_tokens: 1_000_000,
  };
}

function oauthAgentOptions(
  getAccessToken: (options?: { readonly force?: boolean }) => Promise<string>,
  capabilities?: readonly string[] | undefined,
): {
  readonly initialConfig: TestAgentOptions['initialConfig'];
  readonly services: TestAgentServiceOverride;
} {
  return {
    initialConfig: {
      defaultModel: 'kimi-code',
      providers: {
        'managed:kimi-code': {
          type: 'vertexai',
          baseUrl: 'https://api.example/v1',
          oauth: { storage: 'file', key: 'oauth/kimi-code' },
        },
      },
      models: {
        'kimi-code': {
          provider: 'managed:kimi-code',
          model: 'kimi-for-coding',
          maxContextSize: 1_000_000,
          capabilities: capabilities === undefined ? undefined : [...capabilities],
        },
      },
    },
    services: appServices((reg) => {
      reg.definePartialInstance(IOAuthService, {
        resolveTokenProvider: () => ({ getAccessToken }),
      });
    }),
  };
}

function textResult(text: string): Awaited<ReturnType<GenerateFn>> {
  return {
    id: 'mock-oauth-retry',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      toolCalls: [],
    },
    usage: {
      inputOther: 1,
      output: 1,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    },
    finishReason: 'completed',
    rawFinishReason: 'stop',
  };
}
