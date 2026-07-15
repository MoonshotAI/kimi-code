import type { ToolCall } from '@moonshot-ai/kosong';
import { describe, expect, it, vi } from 'vitest';

import { createFakeKaos } from '../tools/fixtures/fake-kaos';
import { createCommandKaos, testAgent } from './harness/agent';

function createPlanKaos(overrides: Parameters<typeof createFakeKaos>[0] = {}) {
  return createFakeKaos({
    mkdir: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  });
}

describe('manual plan entry', () => {
  it('keeps permission gating out of the PlanMode state object', () => {
    const ctx = testAgent();

    expect('beforeToolCall' in ctx.agent.planMode).toBe(false);
  });

  it('enters plan mode without starting a model turn and prepares the plan directory', async () => {
    const mkdir = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn().mockResolvedValue(0);
    const ctx = testAgent({
      kaos: createFakeKaos({ mkdir, writeText }),
    });

    await ctx.rpc.enterPlan({});
    await delay(10);

    expect(ctx.agent.planMode.isActive).toBe(true);
    expect(ctx.agent.planMode.planFilePath).toMatch(/\.md$/);
    expect(mkdir).toHaveBeenCalledWith('/workspace/plan', { parents: true, existOk: true });
    expect(writeText).not.toHaveBeenCalled();
    expect(ctx.allEvents.some((event) => event.event === 'turn.started')).toBe(false);
    expect(ctx.llmCalls).toHaveLength(0);
  });

  it('derives the no-homedir plan path from cwd on enter and restore', async () => {
    const ctx = testAgent({
      kaos: createPlanKaos({
        writeText: vi.fn(async (_path: string, content: string) => content.length),
      }),
    });
    await ctx.agent.planMode.enter('stable-plan');

    const livePath = ctx.agent.planMode.planFilePath;
    if (livePath === null) throw new Error('expected active plan path');
    expect(livePath).toBe('/workspace/plan/stable-plan.md');

    const enterRecord = ctx.allEvents.find(
      (event) => event.type === '[wire]' && event.event === 'plan_mode.enter',
    );
    expect(enterRecord?.args).toEqual({
      id: 'stable-plan',
      time: expect.any(Number),
    });

    const resumed = testAgent({ kaos: createFakeKaos() });
    resumed.dispatch({
      type: 'plan_mode.enter',
      id: 'stable-plan',
    });

    expect(resumed.agent.planMode.planFilePath).toBe(livePath);
  });

  it('enters plan mode through the EnterPlanMode tool and reminds the next step', async () => {
    const enterPlanModeCall: ToolCall = {
      type: 'function',
      id: 'call_enter_plan',
      name: 'EnterPlanMode',
      arguments: '{}',
    };
    const ctx = testAgent({
      kaos: createPlanKaos({
        writeText: vi.fn(async (_path: string, content: string) => content.length),
      }),
    });
    ctx.configure({ tools: ['EnterPlanMode'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });

    ctx.mockNextResponse({ type: 'text', text: 'I will enter plan mode.' }, enterPlanModeCall);
    ctx.mockNextResponse({ type: 'text', text: 'Plan mode is active now.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Plan first' }] });

    await ctx.untilTurnEnd();
    await delay(10);
    expect(ctx.agent.planMode.isActive).toBe(true);
    expect(ctx.llmCalls).toHaveLength(2);
    expect(toolResultText(ctx.llmCalls[1]!.history)).toContain('Plan mode is now active');
    await ctx.expectResumeMatches();
  });
});

describe('plan clear', () => {
  it('empties the current plan file without leaving plan mode', async () => {
    const files = new Map<string, string>();
    const mkdir = vi.fn().mockResolvedValue(undefined);
    const readText = vi.fn(async (path: string) => files.get(path) ?? '');
    const writeText = vi.fn(async (path: string, content: string) => {
      files.set(path, content);
      return content.length;
    });

    const ctx = testAgent({
      kaos: createPlanKaos({ mkdir, readText, writeText }),
    });
    await ctx.agent.planMode.enter('test-plan', false);

    const planPath = ctx.agent.planMode.planFilePath;
    if (planPath === null) throw new Error('expected active plan path');
    files.set(planPath, '# Plan\n\n- Step 1');

    await ctx.rpc.clearPlan({});

    expect(writeText).toHaveBeenCalledWith(planPath, '');
    expect(files.get(planPath)).toBe('');
    expect(ctx.agent.planMode.isActive).toBe(true);
    expect(ctx.agent.planMode.planFilePath).toBe(planPath);
    await expect(ctx.rpc.getPlan({})).resolves.toMatchObject({
      id: 'test-plan',
      content: '',
      path: planPath,
    });
    await ctx.expectResumeMatches();
  });
});

describe('plan exit tool', () => {
  it('reads the current plan file and exits plan mode directly in auto mode', async () => {
    const files = new Map<string, string>();
    const readText = vi.fn(async (path: string) => files.get(path) ?? '');
    const ctx = testAgent({
      kaos: createPlanKaos({ readText }),
    });
    ctx.configure({ tools: ['ExitPlanMode'] });
    await ctx.rpc.setPermission({ mode: 'auto' });
    await ctx.agent.planMode.enter('test-plan', false);

    const planPath = ctx.agent.planMode.planFilePath;
    if (planPath === null) throw new Error('expected active plan path');
    files.set(planPath, '# Plan\n\n- Inspect\n- Change\n- Verify');

    const exitPlanModeCall: ToolCall = {
      type: 'function',
      id: 'call_exit_plan',
      name: 'ExitPlanMode',
      arguments: '{}',
    };
    ctx.mockNextResponse({ type: 'text', text: 'I will present the plan.' }, exitPlanModeCall);
    ctx.mockNextResponse({ type: 'text', text: 'I can execute after approval.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Show the plan' }] });

    await ctx.untilTurnEnd();
    expect(
      ctx.allEvents.some((event) => event.type === '[rpc]' && event.event === 'requestApproval'),
    ).toBe(false);
    expect(readText).toHaveBeenCalledWith(planPath);
    expect(ctx.agent.planMode.isActive).toBe(false);
    const llmInput = ctx.llmCalls[1]!;
    expect(toolResultText(llmInput.history)).toContain('Plan mode deactivated');
    expect(toolResultText(llmInput.history)).toContain('# Plan');
    await ctx.expectResumeMatches();
  });

  it('stops the turn and stays in plan mode when the user rejects the plan', async () => {
    const files = new Map<string, string>();
    const readText = vi.fn(async (path: string) => files.get(path) ?? '');
    const ctx = testAgent({
      kaos: createPlanKaos({ readText }),
    });
    ctx.configure({ tools: ['ExitPlanMode'] });
    await ctx.rpc.setPermission({ mode: 'manual' });
    await ctx.agent.planMode.enter('reject-plan', false);

    const planPath = ctx.agent.planMode.planFilePath;
    if (planPath === null) throw new Error('expected active plan path');
    files.set(planPath, '# Plan\n\n- Inspect\n- Change\n- Verify');

    const exitPlanModeCall: ToolCall = {
      type: 'function',
      id: 'call_exit_reject',
      name: 'ExitPlanMode',
      arguments: '{}',
    };
    ctx.mockNextResponse({ type: 'text', text: 'I will present the plan.' }, exitPlanModeCall);
    ctx.mockNextResponse({ type: 'text', text: 'This response must not be requested.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Show the plan' }] });

    const approval = await ctx.takeApprovalRequest();
    approval.respond({ decision: 'rejected', selectedLabel: 'Reject' });

    await ctx.untilTurnEnd();
    expect(readText).toHaveBeenCalledWith(planPath);
    expect(ctx.agent.planMode.isActive).toBe(true);
    expect(ctx.llmCalls).toHaveLength(1);
    expect(toolResultText(ctx.agent.context.history)).toContain('Plan rejected by user');
    await ctx.expectResumeMatches();
  });

  it('does not execute later tool calls in the same batch after plan rejection', async () => {
    const files = new Map<string, string>();
    const readText = vi.fn(async (path: string) => files.get(path) ?? '');
    const execWithEnv = vi.fn(() => {
      throw new Error('Bash should not execute after plan rejection');
    });
    const ctx = testAgent({
      kaos: createPlanKaos({ readText, execWithEnv }),
    });
    ctx.configure({ tools: ['ExitPlanMode', 'Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });
    await ctx.agent.planMode.enter('reject-and-exit-plan', false);

    const planPath = ctx.agent.planMode.planFilePath;
    if (planPath === null) throw new Error('expected active plan path');
    files.set(planPath, '# Plan\n\n- Inspect\n- Change\n- Verify');

    const exitPlanModeCall: ToolCall = {
      type: 'function',
      id: 'call_exit_reject_and_exit',
      name: 'ExitPlanMode',
      arguments: '{}',
    };
    const bashCall: ToolCall = {
      type: 'function',
      id: 'call_bash_after_reject',
      name: 'Bash',
      arguments: '{"command":"touch should-not-run","timeout":60}',
    };
    ctx.mockNextResponse(
      { type: 'text', text: 'I will present the plan and then run a command.' },
      exitPlanModeCall,
      bashCall,
    );
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Show the plan' }] });

    const approval = await ctx.takeApprovalRequest();
    approval.respond({ decision: 'rejected', selectedLabel: 'Reject' });

    await ctx.untilTurnEnd();
    expect(ctx.agent.planMode.isActive).toBe(true);
    expect(execWithEnv).not.toHaveBeenCalled();
    expect(ctx.llmCalls).toHaveLength(1);
    expect(toolResultText(ctx.agent.context.history)).toContain('Plan rejected by user');
    expect(toolResultText(ctx.agent.context.history)).toContain(
      'Tool skipped because a previous tool call stopped the turn.',
    );
    await ctx.expectResumeMatches();
  });

  it('refuses to exit when the current plan file is empty', async () => {
    const readText = vi.fn(async () => '');
    const ctx = testAgent({
      kaos: createPlanKaos({ readText }),
    });
    ctx.configure({ tools: ['ExitPlanMode'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });
    await ctx.agent.planMode.enter('empty-plan', false);

    const exitPlanModeCall: ToolCall = {
      type: 'function',
      id: 'call_exit_empty_plan',
      name: 'ExitPlanMode',
      arguments: '{}',
    };
    ctx.mockNextResponse(
      { type: 'text', text: 'I will present the empty plan.' },
      exitPlanModeCall,
    );
    ctx.mockNextResponse({ type: 'text', text: 'I need to write the plan first.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Show an empty plan' }] });

    await ctx.untilTurnEnd();
    expect(ctx.agent.planMode.isActive).toBe(true);
    expect(toolResultText(ctx.llmCalls[1]!.history)).toContain('No plan file found');
    await ctx.expectResumeMatches();
  });
});

describe('plan exit tool options', () => {
  it('keeps options for approval when an option omits the optional description', async () => {
    const files = new Map<string, string>();
    const readText = vi.fn(async (path: string) => files.get(path) ?? '');
    const ctx = testAgent({
      kaos: createPlanKaos({ readText }),
    });
    ctx.configure({ tools: ['ExitPlanMode'] });
    await ctx.rpc.setPermission({ mode: 'manual' });
    await ctx.agent.planMode.enter('options-plan', false);

    const planPath = ctx.agent.planMode.planFilePath;
    if (planPath === null) throw new Error('expected active plan path');
    files.set(planPath, '# Plan\n\n- Inspect\n- Change\n- Verify');

    const exitPlanModeCall: ToolCall = {
      type: 'function',
      id: 'call_exit_options',
      name: 'ExitPlanMode',
        // The second option omits `description` — valid input after the
        // schema relaxation. The approval policy must still surface both.
        arguments: JSON.stringify({
          options: [
            { label: 'Approach A', description: 'Smaller refactor.' },
            { label: 'Approach B' },
          ],
        }),
    };
    ctx.mockNextResponse({ type: 'text', text: 'I will present the plan.' }, exitPlanModeCall);
    ctx.mockNextResponse({ type: 'text', text: 'I can execute after approval.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Show the plan' }] });

    const approval = await ctx.takeApprovalRequest();
    const rpcArgs = (
      ctx.allEvents.find(
        (event) => event.type === '[rpc]' && event.event === 'requestApproval',
      ) as { args: { action?: string; display?: { options?: readonly unknown[] } } } | undefined
    )?.args;

    expect(rpcArgs?.action).toBe('Presenting plan and exiting plan mode');
    expect(rpcArgs?.display?.options).toHaveLength(2);

    approval.respond({ decision: 'approved', selectedLabel: 'Approach A' });
    await ctx.untilTurnEnd();
  });
});

describe('plan allows safe tool flow', () => {
  it.each(['Write', 'Edit'] as const)(
    'runs %s on the active plan file without approval in manual mode',
    async (toolName) => {
      const files = new Map<string, string>();
      const readText = vi.fn(async (path: string) => files.get(path) ?? '');
      const writeText = vi.fn(async (path: string, content: string) => {
        files.set(path, content);
        return content.length;
      });
      const ctx = testAgent({
        kaos: createPlanKaos({ readText, writeText }),
      });
      ctx.configure({ tools: [toolName] });
      await ctx.agent.planMode.enter('test-plan', false);

      const planPath = ctx.agent.planMode.planFilePath;
      if (planPath === null) throw new Error('expected active plan path');
      files.set(planPath, '# Plan\n\n- Draft');

      const expectedContent =
        toolName === 'Write' ? '# Plan\n\n- Inspect\n- Verify' : '# Plan\n\n- Draft\n- Verify';
      const args =
        toolName === 'Write'
          ? { path: planPath, content: expectedContent }
          : { path: planPath, old_string: '- Draft', new_string: '- Draft\n- Verify' };
      const writePlanCall: ToolCall = {
        type: 'function',
        id: `call_${toolName.toLowerCase()}_plan`,
        name: toolName,
          arguments: JSON.stringify(args),
      };

      ctx.mockNextResponse({ type: 'text', text: 'I will update the plan file.' }, writePlanCall);
      ctx.mockNextResponse({ type: 'text', text: 'Plan file updated.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Update the plan file' }] });

      await ctx.untilTurnEnd();

      expect(files.get(planPath)).toBe(expectedContent);
      expect(writeText).toHaveBeenCalledWith(planPath, expectedContent);
      expect(
        ctx.allEvents.some((event) => event.type === '[rpc]' && event.event === 'requestApproval'),
      ).toBe(false);
      await ctx.expectResumeMatches();
    },
  );

  it('keeps explicit deny rules above active plan file writes', async () => {
    const files = new Map<string, string>();
    const writeText = vi.fn(async (path: string, content: string) => {
      files.set(path, content);
      return content.length;
    });
    const ctx = testAgent({
      kaos: createPlanKaos({ writeText }),
    });
    ctx.configure({ tools: ['Write'] });
    ctx.agent.permission.rules.push({
      decision: 'deny',
      scope: 'user',
      pattern: 'Write',
      reason: 'blocked by test',
    });
    await ctx.agent.planMode.enter('test-plan', false);

    const planPath = ctx.agent.planMode.planFilePath;
    if (planPath === null) throw new Error('expected active plan path');
    const content = '# Plan\n\n- Inspect\n- Verify';
    const writePlanCall: ToolCall = {
      type: 'function',
      id: 'call_write_plan_with_deny',
      name: 'Write',
      arguments: JSON.stringify({ path: planPath, content }),
    };

    ctx.mockNextResponse({ type: 'text', text: 'I will update the plan file.' }, writePlanCall);
    ctx.mockNextResponse({ type: 'text', text: 'Plan file updated.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Update the plan file' }] });

    await ctx.untilTurnEnd();

    expect(files.get(planPath)).toBeUndefined();
    expect(writeText).not.toHaveBeenCalled();
    expect(toolResultText(ctx.agent.context.history)).toContain(
      'Tool "Write" was denied by permission rule. Reason: blocked by test',
    );
    expect(
      ctx.allEvents.some((event) => event.type === '[rpc]' && event.event === 'requestApproval'),
    ).toBe(false);
  });

  it('allows read-only Bash to continue through permission and execution', async () => {
    const bashCall: ToolCall = {
      type: 'function',
      id: 'call_bash',
      name: 'Bash',
      arguments: '{"command":"printf plan-safe","timeout":60}',
    };
    const ctx = testAgent({ kaos: createCommandKaos('plan-safe') });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });
    await ctx.agent.planMode.enter('test-plan', false);

    ctx.mockNextResponse({ type: 'text', text: 'I will inspect safely.' }, bashCall);
    ctx.mockNextResponse({ type: 'text', text: 'The safe command printed plan-safe.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Inspect without mutating files' }] });
    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] permission.set_mode         { "mode": "yolo", "time": "<time>" }
      [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 0, "maxContextTokens": 1000000, "contextUsage": 0, "planMode": false, "swarmMode": false, "permission": "yolo" }
      [wire] plan_mode.enter             { "id": "test-plan", "time": "<time>" }
      [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 0, "maxContextTokens": 1000000, "contextUsage": 0, "planMode": true, "swarmMode": false, "permission": "yolo" }
      [wire] turn.prompt                 { "input": [ { "type": "text", "text": "Inspect without mutating files" } ], "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started                { "turnId": 0, "origin": { "kind": "user" } }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Inspect without mutating files" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "<plan-mode-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "plan_mode" } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
      [emit] turn.step.started           { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [wire] llm.tools_snapshot          { "hash": "aca3041121ee711028f726fed37e7b999f7e8885c05dbece76ef97eb43e2ec1e", "tools": [ { "name": "Bash", "description": "Execute a \`bash\` command. Use this for shell semantics — pipes, env, processes, git, package managers, build/test runners, anything genuinely interactive or multi-step.\\n\\n**Translate these to a dedicated tool instead:**\\n- \`cat\` / \`head\` / \`tail\` (known path) → \`Read\`\\n- \`sed\` / \`awk\` (in-place edit) → \`Edit\`\\n- \`echo > file\` / \`cat <<EOF\` → \`Write\`\\n- \`find\` / recursive \`ls\` to locate files by name pattern → \`Glob\` (plain \`ls <known-directory>\` is fine for listing a directory)\\n- \`grep\` / \`rg\` (search file contents) → \`Grep\`\\n- \`echo\` / \`printf\` (talk to the user) → just output text directly\\n\\nThe dedicated tools render in the per-tool permission UI and keep raw stdout out of the conversation; that is why they are worth reaching for whenever one fits.\\n\\n**Output:**\\nThe stdout and stderr will be combined and returned as a string. The output may be truncated if it is too long. If the command exits non-zero, the output ends with a \`Command failed with exit code: N\` line; a command killed by its timeout or interrupted by the user ends with its own message instead.\\n\\nBackground execution is disabled for this agent. Do not set \`run_in_background=true\`.\\n\\n**Guidelines for safety and security:**\\n- Each shell tool call will be executed in a fresh shell environment. The shell variables, current working directory changes, and the shell history is not preserved between calls. To run a command in a particular directory, pass the \`cwd\` argument (or use absolute paths) rather than relying on a \`cd\` from an earlier call.\\n- The tool call will return after the command is finished. You shall not use this tool to execute an interactive command or a command that may run forever. For possibly long-running commands, set the \`timeout\` argument in seconds. The default is 60s; foreground commands allow up to 300s; a foreground command that hits its timeout is killed.\\n- Avoid using \`..\` to access files or directories outside of the working directory.\\n- Avoid modifying files outside of the working directory unless explicitly instructed to do so.\\n- Never run commands that require superuser privileges unless explicitly instructed to do so.\\n\\n**Guidelines for efficiency:**\\n- Use \`&&\` to chain commands that genuinely depend on each other, e.g. \`npm install && npm test\`. Independent read-only commands (separate \`git show\`, \`ls\`, or status checks) should be issued as separate parallel Bash calls in one response, not chained into a single call — chaining serializes their execution and mixes their output. Do not stitch outputs together with \`echo\` separators.\\n- Use \`;\` to run commands sequentially regardless of success/failure\\n- Use \`||\` for conditional execution (run second command only if first fails)\\n- Use pipe operations (\`|\`) and redirections (\`>\`, \`>>\`) to chain input and output between commands\\n- Always quote file paths containing spaces with double quotes (e.g., cd \\"/path with spaces/\\")\\n- Compose multi-step logic in a single call with \`if\` / \`case\` / \`for\` / \`while\` control flows.\\n- Do not set \`run_in_background=true\`; background task management tools are not available.\\n\\n**Commands available:**\\nThe following common command categories are usually available. Availability still depends on the host, so when in doubt run \`which <command>\` first to confirm a command exists before relying on it.\\n- Navigation and inspection: \`ls\`, \`pwd\`, \`cd\`, \`stat\`, \`file\`, \`du\`, \`df\`, \`tree\`\\n- File and directory management: \`cp\`, \`mv\`, \`rm\`, \`mkdir\`, \`touch\`, \`ln\`, \`chmod\`, \`chown\`\\n- Text and data processing: \`wc\`, \`sort\`, \`uniq\`, \`cut\`, \`tr\`, \`diff\`, \`xargs\`\\n- Archives and compression: \`tar\`, \`gzip\`, \`gunzip\`, \`zip\`, \`unzip\`\\n- Networking and transfer: \`curl\`, \`wget\`, \`ping\`, \`ssh\`, \`scp\`\\n- Version control: \`git\`; for GitHub-hosted work (PRs, issues, CI runs, API queries) prefer the \`gh\` CLI when installed — it carries the user's GitHub auth and can return structured JSON\\n- Process and system: \`ps\`, \`kill\`, \`top\`, \`env\`, \`date\`, \`uname\`, \`whoami\`\\n- Language and package toolchains: \`node\`, \`npm\`, \`pnpm\`, \`yarn\`, \`python\`, \`pip\` (use whichever the project actually relies on)\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "command": { "type": "string", "minLength": 1, "description": "The command to execute." }, "cwd": { "description": "The working directory in which to run the command. When omitted, the command runs in the session's working directory.", "type": "string" }, "timeout": { "default": 60, "description": "Optional timeout in seconds for the command to execute. Foreground default 60s, max 300s. Background default 600s, max 86400s. Ignored for background commands when disable_timeout=true.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 }, "description": { "description": "A short description for the background task. Required when run_in_background is true.", "type": "string" }, "run_in_background": { "description": "Whether to run the command as a background task.", "type": "boolean" }, "disable_timeout": { "description": "If true, do not apply a timeout to the command. Only applies when run_in_background is true.", "type": "boolean" } }, "required": [ "command" ], "additionalProperties": false } } ], "time": "<time>" }
      [wire] llm.request                 { "kind": "loop", "provider": "kimi", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 1000000, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "aca3041121ee711028f726fed37e7b999f7e8885c05dbece76ef97eb43e2ec1e", "messageCount": 2, "turnStep": "0.1", "time": "<time>" }
      [emit] assistant.delta             { "turnId": 0, "delta": "I will inspect safely." }
      [emit] tool.call.delta             { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "argumentsPart": "{\\"command\\":\\"printf plan-safe\\",\\"timeout\\":60}" }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "I will inspect safely." } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "tool.call", "uuid": "call_bash", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf plan-safe", "timeout": 60 }, "description": "Running: printf plan-safe", "display": { "kind": "command", "command": "printf plan-safe", "cwd": "<cwd>", "language": "bash" } }, "time": "<time>" }
      [emit] tool.call.started           { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf plan-safe", "timeout": 60 }, "description": "Running: printf plan-safe", "display": { "kind": "command", "command": "printf plan-safe", "cwd": "<cwd>", "language": "bash" } }
      [emit] tool.progress               { "turnId": 0, "toolCallId": "call_bash", "update": { "kind": "stdout", "text": "plan-safe" } }
      [wire] context.append_loop_event   { "event": { "type": "tool.result", "parentUuid": "call_bash", "toolCallId": "call_bash", "result": { "output": "plan-safe" } }, "time": "<time>" }
      [emit] tool.result                 { "turnId": 0, "toolCallId": "call_bash", "output": "plan-safe" }
      [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-1>", "turnId": "0", "step": 1, "usage": { "inputOther": 565, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use", "messageId": "mock-1" }, "time": "<time>" }
      [emit] turn.step.completed         { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 565, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use" }
      [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 565, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 588, "maxContextTokens": 1000000, "contextUsage": 0.000588, "planMode": true, "swarmMode": false, "permission": "yolo", "usage": { "byModel": { "mock-model": { "inputOther": 565, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 565, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 565, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-3>", "turnId": "0", "step": 2 }, "time": "<time>" }
      [emit] turn.step.started           { "turnId": 0, "step": 2, "stepId": "<uuid-3>" }
      [wire] llm.request                 { "kind": "loop", "provider": "kimi", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 999412, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "aca3041121ee711028f726fed37e7b999f7e8885c05dbece76ef97eb43e2ec1e", "messageCount": 4, "turnStep": "0.2", "time": "<time>" }
      [emit] assistant.delta             { "turnId": 0, "delta": "The safe command printed plan-safe." }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-4>", "turnId": "0", "step": 2, "stepUuid": "<uuid-3>", "part": { "type": "text", "text": "The safe command printed plan-safe." } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-3>", "turnId": "0", "step": 2, "usage": { "inputOther": 592, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn", "messageId": "mock-2" }, "time": "<time>" }
      [emit] turn.step.completed         { "turnId": 0, "step": 2, "stepId": "<uuid-3>", "usage": { "inputOther": 592, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }
      [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 592, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 604, "maxContextTokens": 1000000, "contextUsage": 0.000604, "planMode": true, "swarmMode": false, "permission": "yolo", "usage": { "byModel": { "mock-model": { "inputOther": 1157, "output": 35, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 1157, "output": 35, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 1157, "output": 35, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [emit] turn.ended                  { "turnId": 0, "reason": "completed" }
    `);
    await ctx.expectResumeMatches();
  });
});

describe('plan mode Bash ordinary permission behavior', () => {
  it('allows Bash through ordinary yolo permission behavior', async () => {
    const bashCall: ToolCall = {
      type: 'function',
      id: 'call_bash',
      name: 'Bash',
      arguments: '{"command":"rm forbidden.txt","timeout":60}',
    };
    const ctx = testAgent({ kaos: createCommandKaos('removed') });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });
    await ctx.agent.planMode.enter('test-plan', false);

    ctx.mockNextResponse({ type: 'text', text: 'I will mutate a file.' }, bashCall);
    ctx.mockNextResponse({ type: 'text', text: 'The command completed.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Remove forbidden.txt' }] });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] permission.set_mode         { "mode": "yolo", "time": "<time>" }
      [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 0, "maxContextTokens": 1000000, "contextUsage": 0, "planMode": false, "swarmMode": false, "permission": "yolo" }
      [wire] plan_mode.enter             { "id": "test-plan", "time": "<time>" }
      [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 0, "maxContextTokens": 1000000, "contextUsage": 0, "planMode": true, "swarmMode": false, "permission": "yolo" }
      [wire] turn.prompt                 { "input": [ { "type": "text", "text": "Remove forbidden.txt" } ], "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started                { "turnId": 0, "origin": { "kind": "user" } }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Remove forbidden.txt" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "<plan-mode-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "plan_mode" } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
      [emit] turn.step.started           { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [wire] llm.tools_snapshot          { "hash": "aca3041121ee711028f726fed37e7b999f7e8885c05dbece76ef97eb43e2ec1e", "tools": [ { "name": "Bash", "description": "Execute a \`bash\` command. Use this for shell semantics — pipes, env, processes, git, package managers, build/test runners, anything genuinely interactive or multi-step.\\n\\n**Translate these to a dedicated tool instead:**\\n- \`cat\` / \`head\` / \`tail\` (known path) → \`Read\`\\n- \`sed\` / \`awk\` (in-place edit) → \`Edit\`\\n- \`echo > file\` / \`cat <<EOF\` → \`Write\`\\n- \`find\` / recursive \`ls\` to locate files by name pattern → \`Glob\` (plain \`ls <known-directory>\` is fine for listing a directory)\\n- \`grep\` / \`rg\` (search file contents) → \`Grep\`\\n- \`echo\` / \`printf\` (talk to the user) → just output text directly\\n\\nThe dedicated tools render in the per-tool permission UI and keep raw stdout out of the conversation; that is why they are worth reaching for whenever one fits.\\n\\n**Output:**\\nThe stdout and stderr will be combined and returned as a string. The output may be truncated if it is too long. If the command exits non-zero, the output ends with a \`Command failed with exit code: N\` line; a command killed by its timeout or interrupted by the user ends with its own message instead.\\n\\nBackground execution is disabled for this agent. Do not set \`run_in_background=true\`.\\n\\n**Guidelines for safety and security:**\\n- Each shell tool call will be executed in a fresh shell environment. The shell variables, current working directory changes, and the shell history is not preserved between calls. To run a command in a particular directory, pass the \`cwd\` argument (or use absolute paths) rather than relying on a \`cd\` from an earlier call.\\n- The tool call will return after the command is finished. You shall not use this tool to execute an interactive command or a command that may run forever. For possibly long-running commands, set the \`timeout\` argument in seconds. The default is 60s; foreground commands allow up to 300s; a foreground command that hits its timeout is killed.\\n- Avoid using \`..\` to access files or directories outside of the working directory.\\n- Avoid modifying files outside of the working directory unless explicitly instructed to do so.\\n- Never run commands that require superuser privileges unless explicitly instructed to do so.\\n\\n**Guidelines for efficiency:**\\n- Use \`&&\` to chain commands that genuinely depend on each other, e.g. \`npm install && npm test\`. Independent read-only commands (separate \`git show\`, \`ls\`, or status checks) should be issued as separate parallel Bash calls in one response, not chained into a single call — chaining serializes their execution and mixes their output. Do not stitch outputs together with \`echo\` separators.\\n- Use \`;\` to run commands sequentially regardless of success/failure\\n- Use \`||\` for conditional execution (run second command only if first fails)\\n- Use pipe operations (\`|\`) and redirections (\`>\`, \`>>\`) to chain input and output between commands\\n- Always quote file paths containing spaces with double quotes (e.g., cd \\"/path with spaces/\\")\\n- Compose multi-step logic in a single call with \`if\` / \`case\` / \`for\` / \`while\` control flows.\\n- Do not set \`run_in_background=true\`; background task management tools are not available.\\n\\n**Commands available:**\\nThe following common command categories are usually available. Availability still depends on the host, so when in doubt run \`which <command>\` first to confirm a command exists before relying on it.\\n- Navigation and inspection: \`ls\`, \`pwd\`, \`cd\`, \`stat\`, \`file\`, \`du\`, \`df\`, \`tree\`\\n- File and directory management: \`cp\`, \`mv\`, \`rm\`, \`mkdir\`, \`touch\`, \`ln\`, \`chmod\`, \`chown\`\\n- Text and data processing: \`wc\`, \`sort\`, \`uniq\`, \`cut\`, \`tr\`, \`diff\`, \`xargs\`\\n- Archives and compression: \`tar\`, \`gzip\`, \`gunzip\`, \`zip\`, \`unzip\`\\n- Networking and transfer: \`curl\`, \`wget\`, \`ping\`, \`ssh\`, \`scp\`\\n- Version control: \`git\`; for GitHub-hosted work (PRs, issues, CI runs, API queries) prefer the \`gh\` CLI when installed — it carries the user's GitHub auth and can return structured JSON\\n- Process and system: \`ps\`, \`kill\`, \`top\`, \`env\`, \`date\`, \`uname\`, \`whoami\`\\n- Language and package toolchains: \`node\`, \`npm\`, \`pnpm\`, \`yarn\`, \`python\`, \`pip\` (use whichever the project actually relies on)\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "command": { "type": "string", "minLength": 1, "description": "The command to execute." }, "cwd": { "description": "The working directory in which to run the command. When omitted, the command runs in the session's working directory.", "type": "string" }, "timeout": { "default": 60, "description": "Optional timeout in seconds for the command to execute. Foreground default 60s, max 300s. Background default 600s, max 86400s. Ignored for background commands when disable_timeout=true.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 }, "description": { "description": "A short description for the background task. Required when run_in_background is true.", "type": "string" }, "run_in_background": { "description": "Whether to run the command as a background task.", "type": "boolean" }, "disable_timeout": { "description": "If true, do not apply a timeout to the command. Only applies when run_in_background is true.", "type": "boolean" } }, "required": [ "command" ], "additionalProperties": false } } ], "time": "<time>" }
      [wire] llm.request                 { "kind": "loop", "provider": "kimi", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 1000000, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "aca3041121ee711028f726fed37e7b999f7e8885c05dbece76ef97eb43e2ec1e", "messageCount": 2, "turnStep": "0.1", "time": "<time>" }
      [emit] assistant.delta             { "turnId": 0, "delta": "I will mutate a file." }
      [emit] tool.call.delta             { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "argumentsPart": "{\\"command\\":\\"rm forbidden.txt\\",\\"timeout\\":60}" }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "I will mutate a file." } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "tool.call", "uuid": "call_bash", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "toolCallId": "call_bash", "name": "Bash", "args": { "command": "rm forbidden.txt", "timeout": 60 }, "description": "Running: rm forbidden.txt", "display": { "kind": "command", "command": "rm forbidden.txt", "cwd": "<cwd>", "language": "bash" } }, "time": "<time>" }
      [emit] tool.call.started           { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "args": { "command": "rm forbidden.txt", "timeout": 60 }, "description": "Running: rm forbidden.txt", "display": { "kind": "command", "command": "rm forbidden.txt", "cwd": "<cwd>", "language": "bash" } }
      [emit] tool.progress               { "turnId": 0, "toolCallId": "call_bash", "update": { "kind": "stdout", "text": "removed" } }
      [wire] context.append_loop_event   { "event": { "type": "tool.result", "parentUuid": "call_bash", "toolCallId": "call_bash", "result": { "output": "removed" } }, "time": "<time>" }
      [emit] tool.result                 { "turnId": 0, "toolCallId": "call_bash", "output": "removed" }
      [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-1>", "turnId": "0", "step": 1, "usage": { "inputOther": 562, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use", "messageId": "mock-1" }, "time": "<time>" }
      [emit] turn.step.completed         { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 562, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use" }
      [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 562, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 585, "maxContextTokens": 1000000, "contextUsage": 0.000585, "planMode": true, "swarmMode": false, "permission": "yolo", "usage": { "byModel": { "mock-model": { "inputOther": 562, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 562, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 562, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-3>", "turnId": "0", "step": 2 }, "time": "<time>" }
      [emit] turn.step.started           { "turnId": 0, "step": 2, "stepId": "<uuid-3>" }
      [wire] llm.request                 { "kind": "loop", "provider": "kimi", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 999415, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "aca3041121ee711028f726fed37e7b999f7e8885c05dbece76ef97eb43e2ec1e", "messageCount": 4, "turnStep": "0.2", "time": "<time>" }
      [emit] assistant.delta             { "turnId": 0, "delta": "The command completed." }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-4>", "turnId": "0", "step": 2, "stepUuid": "<uuid-3>", "part": { "type": "text", "text": "The command completed." } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-3>", "turnId": "0", "step": 2, "usage": { "inputOther": 588, "output": 9, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn", "messageId": "mock-2" }, "time": "<time>" }
      [emit] turn.step.completed         { "turnId": 0, "step": 2, "stepId": "<uuid-3>", "usage": { "inputOther": 588, "output": 9, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }
      [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 588, "output": 9, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 597, "maxContextTokens": 1000000, "contextUsage": 0.000597, "planMode": true, "swarmMode": false, "permission": "yolo", "usage": { "byModel": { "mock-model": { "inputOther": 1150, "output": 32, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 1150, "output": 32, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 1150, "output": 32, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [emit] turn.ended                  { "turnId": 0, "reason": "completed" }
    `);
    expect(toolResultText(ctx.agent.context.history)).toContain('removed');
    await ctx.expectResumeMatches();
  });
});

describe('plan mode injection cadence', () => {
  it('dedupes immediate repeats and emits sparse reminders after assistant turns', async () => {
    const ctx = testAgent();
    ctx.configure();
    await ctx.agent.planMode.enter('test-plan', false);

    await ctx.agent.injection.inject();
    const afterFull = ctx.agent.context.history.length;
    expect(lastUserText(ctx.agent.context.history)).toContain('Plan mode is active');
    expect(lastUserText(ctx.agent.context.history)).toContain('Plan file:');

    await ctx.agent.injection.inject();
    expect(ctx.agent.context.history).toHaveLength(afterFull);

    ctx.appendAssistantTurn(1, 'assistant one');
    ctx.appendAssistantTurn(2, 'assistant two');
    await ctx.agent.injection.inject();

    expect(lastUserText(ctx.agent.context.history)).toContain('Plan mode still active');
    expect(lastUserText(ctx.agent.context.history)).toContain('Plan file:');
    await ctx.expectResumeMatches();
  });

  it('emits a reentry reminder when restored plan mode already has plan content', async () => {
    const ctx = testAgent({
      kaos: createFakeKaos({
        readText: vi.fn(async () => '# Existing Plan\n\n- Keep this context'),
      }),
    });
    ctx.configure();
    ctx.dispatch({
      type: 'plan_mode.enter',
      id: 'restored-plan',
    });

    await ctx.agent.injection.inject();

    expect(lastUserText(ctx.agent.context.history)).toContain('Re-entering Plan Mode');
    expect(lastUserText(ctx.agent.context.history)).toContain('Read the existing plan file');
    await ctx.expectResumeMatches();
  });

  it('emits one exit reminder after leaving plan mode', async () => {
    const ctx = testAgent();
    ctx.configure();
    await ctx.agent.planMode.enter('test-plan', false);
    await ctx.agent.injection.inject();

    ctx.agent.planMode.exit();
    await ctx.agent.injection.inject();
    const afterExit = ctx.agent.context.history.length;
    expect(lastUserText(ctx.agent.context.history)).toContain('Plan mode is no longer active');

    await ctx.agent.injection.inject();
    expect(ctx.agent.context.history).toHaveLength(afterExit);
    await ctx.expectResumeMatches();
  });

  it('keeps the preserved injection index aligned after undo removes earlier messages', async () => {
    const ctx = testAgent();
    ctx.configure();
    await ctx.agent.planMode.enter('test-plan', false);

    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'draft the plan' }]);
    await ctx.agent.injection.inject();
    ctx.appendAssistantTurn(1, 'Plan drafted.');

    ctx.agent.context.undo(1);
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'new plan request' }]);
    await ctx.agent.injection.inject();

    expect(lastUserText(ctx.agent.context.history)).toContain('Plan mode is active');
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lastUserText(history: readonly { role: string; content: readonly unknown[] }[]): string {
  const message = history.findLast((item) => item.role === 'user');
  if (message === undefined) return '';
  return message.content
    .map((part) => {
      if (
        part !== null &&
        typeof part === 'object' &&
        (part as { type?: unknown }).type === 'text'
      ) {
        const text = (part as { text?: unknown }).text;
        return typeof text === 'string' ? text : '';
      }
      return '';
    })
    .join('');
}

function toolResultText(history: readonly { role: string; content: readonly unknown[] }[]): string {
  return history
    .filter((message) => message.role === 'tool')
    .flatMap((message) => message.content)
    .map((part) => {
      if (
        part !== null &&
        typeof part === 'object' &&
        (part as { type?: unknown }).type === 'text'
      ) {
        const text = (part as { text?: unknown }).text;
        return typeof text === 'string' ? text : '';
      }
      return '';
    })
    .join('\n');
}
