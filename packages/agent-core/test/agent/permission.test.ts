import type { Kaos } from '@moonshot-ai/kaos';
import type { ToolCall } from '@moonshot-ai/kosong';
import * as posixPath from 'node:path/posix';
import { describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../src/agent';
import { PermissionModeInjector } from '../../src/agent/injection/permission-mode';
import {
  PermissionManager,
  type ApprovalResponse,
  type PermissionMode,
  type PermissionPolicyContext,
  type PermissionRule,
} from '../../src/agent/permission';
import {
  matchPermissionRule,
  parsePattern,
  type PermissionRuleMatchExecution,
} from '../../src/agent/permission/matches-rule';
import { AutoModeApprovePermissionPolicy } from '../../src/agent/permission/policies/auto-mode-approve';
import { AutoModeAskUserQuestionDenyPermissionPolicy } from '../../src/agent/permission/policies/auto-mode-ask-user-question-deny';
import { FallbackAskPermissionPolicy } from '../../src/agent/permission/policies/fallback-ask';
import { createPermissionDecisionPolicies } from '../../src/agent/permission/policies';
import { YoloModeApprovePermissionPolicy } from '../../src/agent/permission/policies/yolo-mode-approve';
import { ToolAccesses } from '../../src/loop';
import type { ToolInputDisplay } from '../../src/tools/display';
import {
  literalRulePattern,
  matchesPathRuleSubject,
  matchesGlobRuleSubject,
} from '../../src/tools/support/rule-match';
import { createFakeKaos } from '../tools/fixtures/fake-kaos';
import { createCommandKaos, testAgent } from './harness/agent';

describe('Agent permission', () => {
  it('auto mode bypasses approval for ordinary builtin tools', async () => {
    const ctx = testAgent({ kaos: createCommandKaos('auto-output') });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'auto' });

    ctx.mockNextResponse({ type: 'text', text: 'Running without asking.' }, bashCall());
    ctx.mockNextResponse({ type: 'text', text: 'The command printed auto-output.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run Bash in auto mode' }] });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] permission.set_mode         { "mode": "auto", "time": "<time>" }
      [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 0, "maxContextTokens": 1000000, "contextUsage": 0, "planMode": false, "permission": "auto" }
      [wire] turn.prompt                 { "input": [ { "type": "text", "text": "Run Bash in auto mode" } ], "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started                { "turnId": 0, "origin": { "kind": "user" } }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Run Bash in auto mode" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "<auto-mode-enter-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "permission_mode" } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
      [emit] turn.step.started           { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [emit] assistant.delta             { "turnId": 0, "delta": "Running without asking." }
      [emit] tool.call.delta             { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "argumentsPart": "{\\"command\\":\\"printf permission-output\\",\\"timeout\\":60}" }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "Running without asking." } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "tool.call", "uuid": "call_bash", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf permission-output", "timeout": 60 }, "description": "Running: printf permission-output", "display": { "kind": "command", "command": "printf permission-output", "cwd": "<cwd>", "language": "bash" } }, "time": "<time>" }
      [emit] tool.call.started           { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf permission-output", "timeout": 60 }, "description": "Running: printf permission-output", "display": { "kind": "command", "command": "printf permission-output", "cwd": "<cwd>", "language": "bash" } }
      [wire] context.append_loop_event   { "event": { "type": "tool.result", "parentUuid": "call_bash", "toolCallId": "call_bash", "result": { "output": "auto-output" } }, "time": "<time>" }
      [emit] tool.result                 { "turnId": 0, "toolCallId": "call_bash", "output": "auto-output" }
      [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-1>", "turnId": "0", "step": 1, "usage": { "inputOther": 91, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use" }, "time": "<time>" }
      [emit] turn.step.completed         { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 91, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use" }
      [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 91, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 116, "maxContextTokens": 1000000, "contextUsage": 0.000116, "planMode": false, "permission": "auto", "usage": { "byModel": { "mock-model": { "inputOther": 91, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 91, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 91, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-3>", "turnId": "0", "step": 2 }, "time": "<time>" }
      [emit] turn.step.started           { "turnId": 0, "step": 2, "stepId": "<uuid-3>" }
      [emit] assistant.delta             { "turnId": 0, "delta": "The command printed auto-output." }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-4>", "turnId": "0", "step": 2, "stepUuid": "<uuid-3>", "part": { "type": "text", "text": "The command printed auto-output." } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-3>", "turnId": "0", "step": 2, "usage": { "inputOther": 120, "output": 11, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }, "time": "<time>" }
      [emit] turn.step.completed         { "turnId": 0, "step": 2, "stepId": "<uuid-3>", "usage": { "inputOther": 120, "output": 11, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }
      [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 120, "output": 11, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 131, "maxContextTokens": 1000000, "contextUsage": 0.000131, "planMode": false, "permission": "auto", "usage": { "byModel": { "mock-model": { "inputOther": 211, "output": 36, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 211, "output": 36, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 211, "output": 36, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [emit] turn.ended                  { "turnId": 0, "reason": "completed" }
    `);
    expect(ctx.llmInputs()).toMatchInlineSnapshot(`
      call 1:
        system: <system-prompt>
        tools: Bash
        messages:
          user: text "Run Bash in auto mode"
          user: text <auto-mode-enter-reminder>

      call 2:
        messages:
          <last>
          assistant: text "Running without asking."  calls call_bash:Bash { "command": "printf permission-output", "timeout": 60 }
          tool[call_bash]: text "auto-output"
    `);
    await ctx.expectResumeMatches();
  });

  it('yolo mode bypasses approval for ordinary builtin tools', async () => {
    const ctx = testAgent({ kaos: createCommandKaos('yolo-output') });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });

    ctx.mockNextResponse({ type: 'text', text: 'Running in yolo mode.' }, bashCall());
    ctx.mockNextResponse({ type: 'text', text: 'The command printed yolo-output.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run Bash in yolo mode' }] });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] permission.set_mode         { "mode": "yolo", "time": "<time>" }
      [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 0, "maxContextTokens": 1000000, "contextUsage": 0, "planMode": false, "permission": "yolo" }
      [wire] turn.prompt                 { "input": [ { "type": "text", "text": "Run Bash in yolo mode" } ], "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started                { "turnId": 0, "origin": { "kind": "user" } }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Run Bash in yolo mode" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
      [emit] turn.step.started           { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [emit] assistant.delta             { "turnId": 0, "delta": "Running in yolo mode." }
      [emit] tool.call.delta             { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "argumentsPart": "{\\"command\\":\\"printf permission-output\\",\\"timeout\\":60}" }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "Running in yolo mode." } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "tool.call", "uuid": "call_bash", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf permission-output", "timeout": 60 }, "description": "Running: printf permission-output", "display": { "kind": "command", "command": "printf permission-output", "cwd": "<cwd>", "language": "bash" } }, "time": "<time>" }
      [emit] tool.call.started           { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf permission-output", "timeout": 60 }, "description": "Running: printf permission-output", "display": { "kind": "command", "command": "printf permission-output", "cwd": "<cwd>", "language": "bash" } }
      [wire] context.append_loop_event   { "event": { "type": "tool.result", "parentUuid": "call_bash", "toolCallId": "call_bash", "result": { "output": "yolo-output" } }, "time": "<time>" }
      [emit] tool.result                 { "turnId": 0, "toolCallId": "call_bash", "output": "yolo-output" }
      [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-1>", "turnId": "0", "step": 1, "usage": { "inputOther": 7, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use" }, "time": "<time>" }
      [emit] turn.step.completed         { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 7, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use" }
      [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 7, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 32, "maxContextTokens": 1000000, "contextUsage": 0.000032, "planMode": false, "permission": "yolo", "usage": { "byModel": { "mock-model": { "inputOther": 7, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 7, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 7, "output": 25, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-3>", "turnId": "0", "step": 2 }, "time": "<time>" }
      [emit] turn.step.started           { "turnId": 0, "step": 2, "stepId": "<uuid-3>" }
      [emit] assistant.delta             { "turnId": 0, "delta": "The command printed yolo-output." }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-4>", "turnId": "0", "step": 2, "stepUuid": "<uuid-3>", "part": { "type": "text", "text": "The command printed yolo-output." } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-3>", "turnId": "0", "step": 2, "usage": { "inputOther": 36, "output": 11, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }, "time": "<time>" }
      [emit] turn.step.completed         { "turnId": 0, "step": 2, "stepId": "<uuid-3>", "usage": { "inputOther": 36, "output": 11, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }
      [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 36, "output": 11, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 47, "maxContextTokens": 1000000, "contextUsage": 0.000047, "planMode": false, "permission": "yolo", "usage": { "byModel": { "mock-model": { "inputOther": 43, "output": 36, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 43, "output": 36, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 43, "output": 36, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [emit] turn.ended                  { "turnId": 0, "reason": "completed" }
    `);
    expect(ctx.llmInputs()).toMatchInlineSnapshot(`
      call 1:
        system: <system-prompt>
        tools: Bash
        messages:
          user: text "Run Bash in yolo mode"

      call 2:
        messages:
          <last>
          assistant: text "Running in yolo mode."  calls call_bash:Bash { "command": "printf permission-output", "timeout": 60 }
          tool[call_bash]: text "yolo-output"
    `);
    await ctx.expectResumeMatches();
  });
  it('injects a reminder when leaving auto mode', async () => {
    const ctx = testAgent();
    ctx.configure();
    await ctx.rpc.setPermission({ mode: 'auto' });

    ctx.mockNextResponse({ type: 'text', text: 'Auto turn done.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Use auto first' }] });
    await ctx.untilTurnEnd();

    await ctx.rpc.setPermission({ mode: 'manual' });
    ctx.mockNextResponse({ type: 'text', text: 'Manual turn done.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Back to manual' }] });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] permission.set_mode         { "mode": "manual", "time": "<time>" }
      [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 96, "maxContextTokens": 1000000, "contextUsage": 0.000096, "planMode": false, "permission": "manual", "usage": { "byModel": { "mock-model": { "inputOther": 89, "output": 7, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 89, "output": 7, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] turn.prompt                 { "input": [ { "type": "text", "text": "Back to manual" } ], "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started                { "turnId": 1, "origin": { "kind": "user" } }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Back to manual" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "<auto-mode-exit-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "permission_mode" } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-3>", "turnId": "1", "step": 1 }, "time": "<time>" }
      [emit] turn.step.started           { "turnId": 1, "step": 1, "stepId": "<uuid-3>" }
      [emit] assistant.delta             { "turnId": 1, "delta": "Manual turn done." }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-4>", "turnId": "1", "step": 1, "stepUuid": "<uuid-3>", "part": { "type": "text", "text": "Manual turn done." } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-3>", "turnId": "1", "step": 1, "usage": { "inputOther": 161, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }, "time": "<time>" }
      [emit] turn.step.completed         { "turnId": 1, "step": 1, "stepId": "<uuid-3>", "usage": { "inputOther": 161, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }
      [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 161, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 169, "maxContextTokens": 1000000, "contextUsage": 0.000169, "planMode": false, "permission": "manual", "usage": { "byModel": { "mock-model": { "inputOther": 250, "output": 15, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 250, "output": 15, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 161, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [emit] turn.ended                  { "turnId": 1, "reason": "completed" }
    `);
    expect(ctx.llmInputs()).toMatchInlineSnapshot(`
      call 1:
        system: <system-prompt>
        tools: []
        messages:
          user: text "Use auto first"
          user: text <auto-mode-enter-reminder>

      call 2:
        messages:
          <last>
          assistant: text "Auto turn done."
          user: text "Back to manual"
          user: text <auto-mode-exit-reminder>
    `);
    await ctx.expectResumeMatches();
  });

  it('does not execute rejected builtin tools and feeds the rejection back to the LLM', async () => {
    const execWithEnv = vi.fn().mockRejectedValue(new Error('Bash should not execute'));
    const bashCall: ToolCall = {
      type: 'function',
      id: 'call_bash',
      name: 'Bash',
      arguments: '{"command":"printf should-not-run","timeout":60}',
    };
    const ctx = testAgent({
      kaos: createFakeKaos({ execWithEnv }),
    });
    ctx.configure({ tools: ['Bash'] });

    ctx.mockNextResponse({ type: 'text', text: 'I will try Bash.' }, bashCall);
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Try to run Bash' }] });
    expect(await ctx.untilApproval(false)).toMatchInlineSnapshot(`
      [wire] turn.prompt                 { "input": [ { "type": "text", "text": "Try to run Bash" } ], "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started                { "turnId": 0, "origin": { "kind": "user" } }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Try to run Bash" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
      [emit] turn.step.started           { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [emit] assistant.delta             { "turnId": 0, "delta": "I will try Bash." }
      [emit] tool.call.delta             { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "argumentsPart": "{\\"command\\":\\"printf should-not-run\\",\\"timeout\\":60}" }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "I will try Bash." } }, "time": "<time>" }
      [emit] requestApproval             { "turnId": 0, "toolCallId": "call_bash", "toolName": "Bash", "action": "Running: printf should-not-run", "display": { "kind": "command", "command": "printf should-not-run", "cwd": "<cwd>", "language": "bash" } }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: Bash
      messages:
        user: text "Try to run Bash"
    `);

    ctx.mockNextResponse({ type: 'text', text: 'I will not run the command.' });
    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] permission.record_approval_result   { "turnId": 0, "toolCallId": "call_bash", "toolName": "Bash", "action": "Running: printf should-not-run", "result": { "decision": "rejected", "selectedLabel": "reject" }, "time": "<time>" }
      [wire] context.append_loop_event           { "event": { "type": "tool.call", "uuid": "call_bash", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf should-not-run", "timeout": 60 }, "description": "Running: printf should-not-run", "display": { "kind": "command", "command": "printf should-not-run", "cwd": "<cwd>", "language": "bash" } }, "time": "<time>" }
      [emit] tool.call.started                   { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf should-not-run", "timeout": 60 }, "description": "Running: printf should-not-run", "display": { "kind": "command", "command": "printf should-not-run", "cwd": "<cwd>", "language": "bash" } }
      [wire] context.append_loop_event           { "event": { "type": "tool.result", "parentUuid": "call_bash", "toolCallId": "call_bash", "result": { "output": "Tool \\"Bash\\" was not run because the user rejected the approval request.", "isError": true } }, "time": "<time>" }
      [emit] tool.result                         { "turnId": 0, "toolCallId": "call_bash", "output": "Tool \\"Bash\\" was not run because the user rejected the approval request.", "isError": true }
      [wire] context.append_loop_event           { "event": { "type": "step.end", "uuid": "<uuid-1>", "turnId": "0", "step": 1, "usage": { "inputOther": 5, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use" }, "time": "<time>" }
      [emit] turn.step.completed                 { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 5, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use" }
      [wire] usage.record                        { "model": "mock-model", "usage": { "inputOther": 5, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated                { "model": "mock-model", "contextTokens": 27, "maxContextTokens": 1000000, "contextUsage": 0.000027, "planMode": false, "permission": "manual", "usage": { "byModel": { "mock-model": { "inputOther": 5, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 5, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 5, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] context.append_loop_event           { "event": { "type": "step.begin", "uuid": "<uuid-3>", "turnId": "0", "step": 2 }, "time": "<time>" }
      [emit] turn.step.started                   { "turnId": 0, "step": 2, "stepId": "<uuid-3>" }
      [emit] assistant.delta                     { "turnId": 0, "delta": "I will not run the command." }
      [wire] context.append_loop_event           { "event": { "type": "content.part", "uuid": "<uuid-4>", "turnId": "0", "step": 2, "stepUuid": "<uuid-3>", "part": { "type": "text", "text": "I will not run the command." } }, "time": "<time>" }
      [wire] context.append_loop_event           { "event": { "type": "step.end", "uuid": "<uuid-3>", "turnId": "0", "step": 2, "usage": { "inputOther": 58, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }, "time": "<time>" }
      [emit] turn.step.completed                 { "turnId": 0, "step": 2, "stepId": "<uuid-3>", "usage": { "inputOther": 58, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }
      [wire] usage.record                        { "model": "mock-model", "usage": { "inputOther": 58, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated                { "model": "mock-model", "contextTokens": 68, "maxContextTokens": 1000000, "contextUsage": 0.000068, "planMode": false, "permission": "manual", "usage": { "byModel": { "mock-model": { "inputOther": 63, "output": 32, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 63, "output": 32, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 63, "output": 32, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [emit] turn.ended                          { "turnId": 0, "reason": "completed" }
    `);
    expect(execWithEnv).not.toHaveBeenCalled();
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      messages:
        <last>
        assistant: text "I will try Bash."  calls call_bash:Bash { "command": "printf should-not-run", "timeout": 60 }
        tool[call_bash]: text "<system>ERROR: Tool execution failed.</system>\\nTool \\"Bash\\" was not run because the user rejected the approval request."
    `);
    await ctx.expectResumeMatches();
  });
});

describe('Permission auto mode', () => {
  it('tells the agent not to ask questions in auto mode', async () => {
    const appendSystemReminder = vi.fn();
    const agent = {
      permission: { mode: 'auto' },
      context: { history: [], appendSystemReminder },
    } as unknown as Agent;
    const injector = new PermissionModeInjector(agent);

    await injector.inject();

    expect(appendSystemReminder).toHaveBeenCalledWith(
      expect.stringContaining('Do NOT call AskUserQuestion while auto mode is active'),
      { kind: 'injection', variant: 'permission_mode' },
    );
  });

  it('blocks AskUserQuestion in auto mode before execution', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.setMode('auto');

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_question',
          toolName: 'AskUserQuestion',
          args: { questions: [] },
        }),
      ),
    ).resolves.toMatchObject({
      block: true,
      reason: expect.stringContaining(
        'AskUserQuestion is disabled while auto permission mode is active',
      ),
    });
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('allows AskUserQuestion in yolo mode so it can reach question rpc', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.setMode('yolo');

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_question',
          toolName: 'AskUserQuestion',
          args: { questions: [] },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it.each(['auto', 'yolo'] as const)('applies deny rules before %s mode bypass', async (mode) => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.setMode(mode);
    manager.rules.push({
      decision: 'deny',
      scope: 'user',
      pattern: 'Bash',
      reason: 'blocked by test',
    });

    await expect(manager.beforeToolCall(hookContext({ id: 'call_1' }))).resolves.toMatchObject({
      block: true,
      reason: 'Tool "Bash" was denied by permission rule. Reason: blocked by test',
    });
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it.each([
    ['auto', 'auto-mode-approve'],
    ['yolo', 'yolo-mode-approve'],
  ] as const)('tracks %s mode bypass through %s', async (mode, policyName) => {
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.setMode(mode);

    await expect(manager.beforeToolCall(hookContext({ id: 'call_1' }))).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    expect(telemetryTrack).toHaveBeenCalledWith('permission_policy_decision', {
      policy_name: policyName,
      tool_name: 'Bash',
      permission_mode: mode,
      decision: 'approve',
    });
  });

  it('tracks plan-mode Bash bypass in auto mode through auto-mode-approve', async () => {
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(
      async () => ({
        decision: 'approved',
      }),
      { planModeActive: true },
    );
    manager.setMode('auto');

    await expect(manager.beforeToolCall(hookContext({ id: 'call_plan_bash' }))).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    expect(telemetryTrack).toHaveBeenCalledWith('permission_policy_decision', {
      policy_name: 'auto-mode-approve',
      tool_name: 'Bash',
      permission_mode: 'auto',
      decision: 'approve',
    });
  });

  it.each(['auto', 'yolo'] as const)(
    'tracks mode policy for default-allowed tools in %s mode',
    async (mode) => {
      const { manager, requestApproval, telemetryTrack } = makePermissionManager(async () => ({
        decision: 'approved',
      }));
      manager.setMode(mode);

      await expect(
        manager.beforeToolCall(
          hookContext({
            id: 'call_read',
            toolName: 'Read',
            args: { path: '/workspace/notes.md' },
          }),
        ),
      ).resolves.toBeUndefined();

      expect(requestApproval).not.toHaveBeenCalled();
      expect(telemetryTrack).toHaveBeenCalledWith(
        'permission_policy_decision',
        expect.objectContaining({
          policy_name: mode === 'auto' ? 'auto-mode-approve' : 'yolo-mode-approve',
          tool_name: 'Read',
          permission_mode: mode,
          decision: 'approve',
        }),
      );
    },
  );

  it.each(
    (['manual', 'yolo'] as const).flatMap((mode) =>
      [
        [mode, 'Write', { path: '/tmp/notes.md', content: 'x' }, 'write', 'write file'],
        [mode, 'Edit', { path: '/tmp/notes.md', old_string: 'a', new_string: 'b' }, 'edit', 'edit file'],
      ] as const,
    ),
  )(
    'requests approval in %s mode for %s outside the cwd',
    async (mode, toolName, args, operation, action) => {
      const { manager, requestApproval } = makePermissionManager(async () => ({
        decision: 'approved',
      }));
      manager.setMode(mode);

      await expect(
        manager.beforeToolCall(hookContext({ id: `call_${toolName}`, toolName, args })),
      ).resolves.toBeUndefined();

      expect(requestApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName,
          action,
          display: {
            kind: 'file_io',
            operation,
            path: args.path,
          },
        }),
        expect.any(Object),
      );
    },
  );

  it.each(
    (['manual', 'yolo'] as const).flatMap((mode) =>
      [
        [mode, 'Read', { path: '/tmp/notes.md' }],
        [mode, 'ReadMediaFile', { path: '/tmp/image.png' }],
        [mode, 'Grep', { pattern: 'TODO', path: '/tmp' }],
      ] as const,
    ),
  )(
    'does not ask in %s mode for %s outside the cwd (read/search are not write)',
    async (mode, toolName, args) => {
      const { manager, requestApproval } = makePermissionManager(async () => ({
        decision: 'approved',
      }));
      manager.setMode(mode);

      await expect(
        manager.beforeToolCall(hookContext({ id: `call_${toolName}_${mode}`, toolName, args })),
      ).resolves.toBeUndefined();

      expect(requestApproval).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['Read', { path: '/tmp/notes.md' }],
    ['ReadMediaFile', { path: '/tmp/image.png' }],
    ['Write', { path: '/tmp/notes.md', content: 'x' }],
    ['Edit', { path: '/tmp/notes.md', old_string: 'a', new_string: 'b' }],
  ] as const)('approves %s outside the cwd in auto mode', async (toolName, args) => {
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.setMode('auto');

    await expect(
      manager.beforeToolCall(hookContext({ id: `call_${toolName}`, toolName, args })),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    expect(telemetryTrack).toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({
        policy_name: 'auto-mode-approve',
        tool_name: toolName,
        permission_mode: 'auto',
        decision: 'approve',
      }),
    );
  });

  it.each([
    ['Read', { path: '/workspace/notes.md' }],
    ['ReadMediaFile', { path: '/workspace/image.png' }],
    ['Write', { path: '/workspace/notes.md', content: 'x' }],
    ['Edit', { path: '/workspace/notes.md', old_string: 'a', new_string: 'b' }],
    ['Grep', { pattern: 'TODO', path: '/workspace' }],
  ] as const)(
    'does not request approval for %s inside the workspace in yolo mode',
    async (toolName, args) => {
      const { manager, requestApproval } = makePermissionManager(async () => ({
        decision: 'approved',
      }));
      manager.setMode('yolo');

      await expect(
        manager.beforeToolCall(hookContext({ id: `call_${toolName}`, toolName, args })),
      ).resolves.toBeUndefined();

      expect(requestApproval).not.toHaveBeenCalled();
    },
  );

  it('approves Grep search outside the cwd in auto mode', async () => {
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.setMode('auto');

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_grep_auto',
          toolName: 'Grep',
          args: { pattern: 'TODO', path: '/tmp' },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    expect(telemetryTrack).toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({
        policy_name: 'auto-mode-approve',
        tool_name: 'Grep',
      }),
    );
  });

  it('keeps explicit deny rules higher priority than yolo outside-workspace approval', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.setMode('yolo');
    manager.rules.push({
      decision: 'deny',
      scope: 'user',
      pattern: 'Read',
      reason: 'reads disabled',
    });

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_read_denied',
          toolName: 'Read',
          args: { path: '/tmp/notes.md' },
        }),
      ),
    ).resolves.toMatchObject({
      block: true,
      reason: 'Tool "Read" was denied by permission rule. Reason: reads disabled',
    });
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('keeps ask rules higher priority than matching allow rules', async () => {
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.rules.push(
      {
        decision: 'allow',
        scope: 'project',
        pattern: 'Bash',
      },
      {
        decision: 'ask',
        scope: 'user',
        pattern: 'Bash',
      },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_bash_ask_allow',
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(telemetryTrack).toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({
        policy_name: 'user-configured-ask',
        tool_name: 'Bash',
        decision: 'ask',
      }),
    );
    expect(telemetryTrack).not.toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({
        policy_name: 'user-configured-allow',
      }),
    );
  });

  it('reuses approve-for-session even when an ask rule still matches the call', async () => {
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(async () => ({
      decision: 'approved',
      scope: 'session',
      selectedLabel: 'Approve for this session',
    }));
    manager.rules.push({
      decision: 'ask',
      scope: 'user',
      pattern: 'Bash',
    });
    const call = () =>
      manager.beforeToolCall(
        hookContext({
          id: 'call_bash_session_after_ask',
        }),
      );

    await expect(call()).resolves.toBeUndefined();
    await expect(call()).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(telemetryTrack).toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({
        policy_name: 'session-approval-history',
        tool_name: 'Bash',
        decision: 'approve',
      }),
    );
  });

  it('reuses approve-for-session for repeated outside-workspace writes in yolo mode', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
      scope: 'session',
      selectedLabel: 'Approve for this session',
    }));
    manager.setMode('yolo');
    const call = () =>
      manager.beforeToolCall(
        hookContext({
          id: 'call_write_session',
          toolName: 'Write',
          args: { path: '/tmp/notes.md', content: 'x' },
        }),
      );

    await expect(call()).resolves.toBeUndefined();
    await expect(call()).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(manager.sessionApprovalRulePatterns).toEqual(['Write(/tmp/notes.md)']);
    expect(manager.data().rules).toEqual([]);
  });
});

describe('Permission policy chain', () => {
  it('keeps built-in policies in document order', () => {
    expect(createPermissionDecisionPolicies({} as Agent).map((policy) => policy.name)).toEqual([
      'pre-tool-call-hook',
      'auto-mode-ask-user-question-deny',
      'plan-mode-guard-deny',
      'user-configured-deny',
      'auto-mode-approve',
      'session-approval-history',
      'user-configured-ask',
      'user-configured-allow',
      'exit-plan-mode-review-ask',
      'plan-mode-tool-approve',
      'sensitive-file-access-ask',
      'git-control-path-access-ask',
      'cwd-outside-file-write-ask',
      'yolo-mode-approve',
      'default-tool-approve',
      'git-cwd-write-approve',
      'fallback-ask',
    ]);
  });

});

describe('Simple permission policy direct behavior', () => {
  it('approves only in auto mode for AutoModeApprovePermissionPolicy', () => {
    const agent = { permission: { mode: 'manual' } } as unknown as Agent;
    const policy = new AutoModeApprovePermissionPolicy(agent);

    expect(policy.evaluate()).toBeUndefined();
    Object.assign(agent.permission, { mode: 'auto' });
    expect(policy.evaluate()).toEqual({ kind: 'approve' });
  });

  it('denies AskUserQuestion only in auto mode', () => {
    const agent = { permission: { mode: 'manual' } } as unknown as Agent;
    const policy = new AutoModeAskUserQuestionDenyPermissionPolicy(agent);

    expect(
      policy.evaluate(
        hookContext({
          id: 'call_question_manual',
          toolName: 'AskUserQuestion',
          args: { questions: [] },
        }),
      ),
    ).toBeUndefined();

    Object.assign(agent.permission, { mode: 'auto' });
    expect(
      policy.evaluate(
        hookContext({
          id: 'call_question_auto',
          toolName: 'AskUserQuestion',
          args: { questions: [] },
        }),
      ),
    ).toMatchObject({ kind: 'deny' });
    expect(
      policy.evaluate(
        hookContext({
          id: 'call_bash_auto',
          toolName: 'Bash',
        }),
      ),
    ).toBeUndefined();
  });

  it('approves only in yolo mode for YoloModeApprovePermissionPolicy', () => {
    const agent = { permission: { mode: 'manual' } } as unknown as Agent;
    const policy = new YoloModeApprovePermissionPolicy(agent);

    expect(policy.evaluate()).toBeUndefined();
    Object.assign(agent.permission, { mode: 'yolo' });
    expect(policy.evaluate()).toEqual({ kind: 'approve' });
  });

  it('always asks in FallbackAskPermissionPolicy', () => {
    const policy = new FallbackAskPermissionPolicy();

    expect(policy.evaluate(hookContext({ id: 'call_fallback_direct' }))).toEqual({ kind: 'ask' });
  });
});

describe('PreToolUse permission policy', () => {
  it('blocks before approval and records the hook policy decision', async () => {
    const triggerBlock = vi.fn(async () => ({
      block: true,
      reason: 'blocked by hook',
    }));
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { hooks: { triggerBlock } as unknown as Agent['hooks'] },
    );

    await expect(manager.beforeToolCall(hookContext({ id: 'call_hook_block' }))).resolves
      .toMatchObject({
        block: true,
        reason: 'blocked by hook',
      });

    expect(requestApproval).not.toHaveBeenCalled();
    expect(triggerBlock).toHaveBeenCalledWith('PreToolUse', {
      matcherValue: 'Bash',
      signal: expect.any(AbortSignal),
      inputData: {
        toolName: 'Bash',
        toolInput: { command: 'printf first', timeout: 60 },
        toolCallId: 'call_hook_block',
      },
    });
    expect(telemetryTrack).toHaveBeenCalledWith('permission_policy_decision', {
      policy_name: 'pre-tool-call-hook',
      tool_name: 'Bash',
      permission_mode: 'manual',
      decision: 'deny',
    });
  });

  it.each(['auto', 'yolo'] as const)('runs before %s mode bypass', async (mode) => {
    const triggerBlock = vi.fn(async () => ({
      block: true,
      reason: `${mode} hook block`,
    }));
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { hooks: { triggerBlock } as unknown as Agent['hooks'] },
    );
    manager.setMode(mode);

    await expect(manager.beforeToolCall(hookContext({ id: `call_hook_${mode}` }))).resolves
      .toMatchObject({
        block: true,
        reason: `${mode} hook block`,
      });

    expect(requestApproval).not.toHaveBeenCalled();
    expect(telemetryTrack).toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({
        policy_name: 'pre-tool-call-hook',
        permission_mode: mode,
        decision: 'deny',
      }),
    );
  });

  it('continues through later policies when the hook does not block', async () => {
    const triggerBlock = vi.fn(async () => undefined);
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { hooks: { triggerBlock } as unknown as Agent['hooks'] },
    );

    await expect(manager.beforeToolCall(hookContext({ id: 'call_hook_allow' }))).resolves
      .toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(telemetryTrack).toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({
        policy_name: 'fallback-ask',
        tool_name: 'Bash',
        decision: 'ask',
      }),
    );
  });

  it('passes an empty hook input object for non-plain arguments', async () => {
    const triggerBlock = vi.fn(async () => ({
      block: true,
      reason: 'array args blocked',
    }));
    const { manager } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { hooks: { triggerBlock } as unknown as Agent['hooks'] },
    );

    await manager.beforeToolCall(
      hookContext({
        id: 'call_array_args',
        toolName: 'Custom',
        args: [] as unknown as Record<string, unknown>,
      }),
    );

    expect(triggerBlock).toHaveBeenCalledWith(
      'PreToolUse',
      expect.objectContaining({
        inputData: {
          toolName: 'Custom',
          toolInput: {},
          toolCallId: 'call_array_args',
        },
      }),
    );
  });
});

describe('Default tool approve policy', () => {
  it.each([
    ['Read', { path: '/workspace/notes.md' }],
    ['Grep', { pattern: 'TODO', path: '/workspace' }],
    ['Glob', { pattern: '**/*.ts', path: '/workspace' }],
    ['ReadMediaFile', { path: '/workspace/image.png' }],
    ['SetTodoList', { items: [] }],
    ['TodoList', {}],
    ['TaskList', {}],
    ['TaskOutput', { task_id: 'task_1' }],
    ['WebSearch', { query: 'kimi code' }],
    ['FetchURL', { url: 'https://example.com' }],
    ['Agent', { prompt: 'review this' }],
    ['AskUserQuestion', { questions: [] }],
    ['Skill', { name: 'test-skill' }],
  ] as const)('approves %s in manual mode without requesting approval', async (toolName, args) => {
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(async () => ({
      decision: 'approved',
    }));

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: `call_default_${toolName}`,
          toolName,
          args,
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    expect(telemetryTrack).toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({
        policy_name: 'default-tool-approve',
        tool_name: toolName,
        permission_mode: 'manual',
        decision: 'approve',
      }),
    );
  });

  it.each([
    ['Bash', { command: 'printf first', timeout: 60 }],
    ['Write', { path: '/workspace/a.ts', content: 'x' }],
    ['Edit', { path: '/workspace/a.ts', old_string: 'a', new_string: 'b' }],
    ['Custom', { value: 1 }],
  ] as const)('does not default-approve %s', async (toolName, args) => {
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(async () => ({
      decision: 'approved',
    }));

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: `call_not_default_${toolName}`,
          toolName,
          args,
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(telemetryTrack).not.toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({ policy_name: 'default-tool-approve' }),
    );
  });

  it('keeps auto-mode AskUserQuestion deny above default approval', async () => {
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.setMode('auto');

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_auto_question_default',
          toolName: 'AskUserQuestion',
          args: { questions: [] },
        }),
      ),
    ).resolves.toMatchObject({
      block: true,
      reason: expect.stringContaining('AskUserQuestion is disabled'),
    });

    expect(requestApproval).not.toHaveBeenCalled();
    expect(telemetryTrack).toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({
        policy_name: 'auto-mode-ask-user-question-deny',
        tool_name: 'AskUserQuestion',
        decision: 'deny',
      }),
    );
  });
});

describe('Permission live derive', () => {
  it('derives parent mode until the child records a local mode', () => {
    const parent = makePermissionManager(async () => ({ decision: 'approved' }));
    const child = makePermissionManager(async () => ({ decision: 'approved' }), {
      parent: parent.manager,
    });

    expect(child.manager.mode).toBe('manual');
    parent.manager.setMode('yolo');
    expect(child.manager.mode).toBe('yolo');
    expect(child.manager.data().mode).toBe('yolo');

    child.manager.setMode('manual');
    parent.manager.setMode('auto');
    expect(child.manager.mode).toBe('manual');
  });

  it('applies rule decision priority across child and parent rules', async () => {
    const parent = makePermissionManager(async () => ({ decision: 'approved' }));
    parent.manager.rules.push({
      decision: 'deny',
      scope: 'user',
      pattern: 'Bash',
      reason: 'parent deny',
    });
    const child = makePermissionManager(async () => ({ decision: 'approved' }), {
      parent: parent.manager,
    });
    child.manager.rules.push({
      decision: 'allow',
      scope: 'session-runtime',
      pattern: 'Bash',
      reason: 'child allow',
    });

    await expect(child.manager.beforeToolCall(hookContext({ id: 'call_parent_deny' }))).resolves
      .toMatchObject({
        block: true,
        reason: 'Tool "Bash" was denied by permission rule. Reason: parent deny',
      });
    expect(child.requestApproval).not.toHaveBeenCalled();

    const parentAllow = makePermissionManager(async () => ({ decision: 'approved' }));
    parentAllow.manager.rules.push({
      decision: 'allow',
      scope: 'user',
      pattern: 'Bash',
      reason: 'parent allow',
    });
    const childDeny = makePermissionManager(async () => ({ decision: 'approved' }), {
      parent: parentAllow.manager,
    });
    childDeny.manager.rules.push({
      decision: 'deny',
      scope: 'user',
      pattern: 'Bash',
      reason: 'child deny',
    });

    await expect(childDeny.manager.beforeToolCall(hookContext({ id: 'call_deny' }))).resolves
      .toMatchObject({
        block: true,
        reason: 'Tool "Bash" was denied by permission rule. Reason: child deny',
      });
    expect(childDeny.requestApproval).not.toHaveBeenCalled();
  });

  it('ignores legacy session-runtime rules in user-configured matching', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.rules.push({
      decision: 'allow',
      scope: 'session-runtime',
      pattern: 'Bash',
      reason: 'legacy approve for session',
    });

    await expect(manager.beforeToolCall(hookContext({ id: 'call_legacy_session_rule' }))).resolves
      .toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('falls back to parent rules and session approvals when no child rule matches', async () => {
    const parent = makePermissionManager(async () => ({ decision: 'approved' }));
    parent.manager.recordApprovalResult({
      turnId: 0,
      toolCallId: 'call_parent',
      toolName: 'Bash',
      action: 'run command',
      sessionApprovalRule: 'Bash(printf first)',
      result: {
        decision: 'approved',
        scope: 'session',
        selectedLabel: 'Approve for this session',
      },
    });
    const child = makePermissionManager(async () => ({ decision: 'approved' }), {
      parent: parent.manager,
    });

    await expect(child.manager.beforeToolCall(hookContext({ id: 'call_child' }))).resolves
      .toBeUndefined();

    expect(child.requestApproval).not.toHaveBeenCalled();
    expect(child.manager.rules).toEqual([]);
    expect(child.manager.data().rules).toEqual([]);
    expect(child.manager.sessionApprovalRulePatterns).toContain('Bash(printf first)');
  });

  it('uses child local mode for inherited non-deny decisions', async () => {
    const parent = makePermissionManager(async () => ({ decision: 'approved' }));
    parent.manager.setMode('yolo');
    const child = makePermissionManager(async () => ({ decision: 'approved' }), {
      parent: parent.manager,
    });

    await expect(child.manager.beforeToolCall(hookContext({ id: 'call_inherited_yolo' }))).resolves
      .toBeUndefined();
    expect(child.requestApproval).not.toHaveBeenCalled();

    child.manager.setMode('manual');
    await expect(child.manager.beforeToolCall(hookContext({ id: 'call_local_manual' }))).resolves
      .toBeUndefined();
    expect(child.requestApproval).toHaveBeenCalledTimes(1);
  });
});

describe('User-configured permission policies', () => {
  it('denies with argument-aware matching and ignores non-matching arguments', async () => {
    const denied = makePermissionManager(async () => ({ decision: 'approved' }));
    denied.manager.rules.push({
      decision: 'deny',
      scope: 'user',
      pattern: 'Bash(git *)',
      reason: 'git is blocked',
    });

    await expect(
      denied.manager.beforeToolCall(
        hookContext({
          id: 'call_git_denied',
          args: { command: 'git status', timeout: 60 },
        }),
      ),
    ).resolves.toMatchObject({
      block: true,
      reason: 'Tool "Bash" was denied by permission rule. Reason: git is blocked',
    });
    expect(denied.requestApproval).not.toHaveBeenCalled();

    const allowed = makePermissionManager(async () => ({ decision: 'approved' }));
    allowed.manager.rules.push({
      decision: 'deny',
      scope: 'user',
      pattern: 'Bash(git *)',
      reason: 'git is blocked',
    });

    await expect(
      allowed.manager.beforeToolCall(
        hookContext({
          id: 'call_npm_not_denied',
          args: { command: 'npm test', timeout: 60 },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(allowed.requestApproval).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ reason: undefined }, 'Tool "Bash" was denied by permission rule.'],
    [{ reason: '' }, 'Tool "Bash" was denied by permission rule.'],
  ] as const)('formats deny messages without an empty reason suffix', async (rule, message) => {
    const { manager } = makePermissionManager(async () => ({ decision: 'approved' }));
    manager.rules.push({
      decision: 'deny',
      scope: 'user',
      pattern: 'Bash',
      reason: rule.reason,
    });

    await expect(manager.beforeToolCall(hookContext({ id: 'call_deny_reason' }))).resolves
      .toMatchObject({
        block: true,
        reason: message,
      });
  });

  it('continues past malformed user rule patterns', async () => {
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.rules.push({
      decision: 'deny',
      scope: 'user',
      pattern: 'Bash(git *',
      reason: 'malformed rule',
    });

    await expect(manager.beforeToolCall(hookContext({ id: 'call_bad_rule' }))).resolves
      .toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(telemetryTrack).toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({
        policy_name: 'fallback-ask',
        decision: 'ask',
      }),
    );
  });

  it('uses the first matching deny rule in effective order', async () => {
    const { manager } = makePermissionManager(async () => ({ decision: 'approved' }));
    manager.rules.push(
      {
        decision: 'deny',
        scope: 'project',
        pattern: 'Bash(git *)',
        reason: 'project deny',
      },
      {
        decision: 'deny',
        scope: 'user',
        pattern: 'Bash(git status)',
        reason: 'user deny',
      },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_first_deny',
          args: { command: 'git status', timeout: 60 },
        }),
      ),
    ).resolves.toMatchObject({
      block: true,
      reason: 'Tool "Bash" was denied by permission rule. Reason: project deny',
    });
  });

  it('adds sub-agent guidance to user-configured deny messages', async () => {
    const { manager } = makePermissionManager(async () => ({ decision: 'approved' }), {
      agentType: 'sub',
    });
    manager.rules.push({
      decision: 'deny',
      scope: 'user',
      pattern: 'Bash',
      reason: 'blocked by parent',
    });

    await expect(manager.beforeToolCall(hookContext({ id: 'call_sub_deny' }))).resolves
      .toMatchObject({
        block: true,
        reason: expect.stringContaining("don't retry the same call"),
      });
  });

  it('requests approval for argument-aware ask rules and records non-sensitive match telemetry', async () => {
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.rules.push({
      decision: 'ask',
      scope: 'user',
      pattern: 'Bash(git *)',
    });

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_ask_git',
          args: { command: 'git status', timeout: 60 },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(telemetryTrack).toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({
        policy_name: 'user-configured-ask',
        rule_decision: 'ask',
        has_rule_args: true,
        match_strategy: 'matches_rule',
      }),
    );
  });

  it('lets non-matching ask rules fall through to matching allow rules', async () => {
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.rules.push(
      {
        decision: 'ask',
        scope: 'user',
        pattern: 'Bash(git *)',
      },
      {
        decision: 'allow',
        scope: 'user',
        pattern: 'Bash(npm *)',
      },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_allow_npm',
          args: { command: 'npm test', timeout: 60 },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    expect(telemetryTrack).toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({
        policy_name: 'user-configured-allow',
        rule_decision: 'allow',
        has_rule_args: true,
        match_strategy: 'matches_rule',
      }),
    );
  });

  it('falls back to approval when an allow rule argument does not match', async () => {
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.rules.push({
      decision: 'allow',
      scope: 'user',
      pattern: 'Bash(git *)',
    });

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_allow_miss',
          args: { command: 'npm test', timeout: 60 },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(telemetryTrack).toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({
        policy_name: 'fallback-ask',
      }),
    );
  });

  it.each(['turn-override', 'project', 'user'] as const)(
    'matches %s scoped user-configured rules',
    async (scope) => {
      const { manager, requestApproval, telemetryTrack } = makePermissionManager(async () => ({
        decision: 'approved',
      }));
      manager.rules.push({
        decision: 'allow',
        scope,
        pattern: 'Bash',
      });

      await expect(manager.beforeToolCall(hookContext({ id: `call_scope_${scope}` }))).resolves
        .toBeUndefined();

      expect(requestApproval).not.toHaveBeenCalled();
      expect(telemetryTrack).toHaveBeenCalledWith(
        'permission_policy_decision',
        expect.objectContaining({
          policy_name: 'user-configured-allow',
          rule_decision: 'allow',
        }),
      );
    },
  );
});

describe('Plan mode tool approve policy', () => {
  it('approves EnterPlanMode in manual mode without requesting approval', async () => {
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(async () => ({
      decision: 'approved',
    }));

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_enter_plan',
          toolName: 'EnterPlanMode',
          args: {},
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    expect(telemetryTrack).toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({
        policy_name: 'plan-mode-tool-approve',
        tool_name: 'EnterPlanMode',
        decision: 'approve',
      }),
    );
  });

  it.each(['Write', 'Edit'] as const)(
    'approves %s when it only writes the active plan file',
    async (toolName) => {
      const planFilePath = '/workspace/.kimi/plans/current.md';
      const { manager, requestApproval, telemetryTrack } = makePermissionManager(
        async () => ({ decision: 'approved' }),
        { planModeActive: true, planFilePath },
      );
      const args =
        toolName === 'Write'
          ? { path: planFilePath, content: '# Plan' }
          : { path: planFilePath, old_string: '# Draft', new_string: '# Plan' };

      await expect(
        manager.beforeToolCall(
          hookContext({
            id: `call_${toolName}_plan_approve`,
            toolName,
            args,
          }),
        ),
      ).resolves.toBeUndefined();

      expect(requestApproval).not.toHaveBeenCalled();
      expect(telemetryTrack).toHaveBeenCalledWith(
        'permission_policy_decision',
        expect.objectContaining({
          policy_name: 'plan-mode-tool-approve',
          tool_name: toolName,
          decision: 'approve',
        }),
      );
    },
  );

  it('denies active plan-mode writes that have no file write access', async () => {
    const planFilePath = '/workspace/.kimi/plans/current.md';
    const args = { path: planFilePath, content: '# Plan' };
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { planModeActive: true, planFilePath },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_write_no_access',
          toolName: 'Write',
          args,
          execution: {
            ...testExecution('Write', args),
            accesses: ToolAccesses.none(),
          },
        }),
      ),
    ).resolves.toMatchObject({
      block: true,
      reason: expect.stringContaining('Plan mode is active'),
    });

    expect(requestApproval).not.toHaveBeenCalled();
    expect(telemetryTrack).toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({
        policy_name: 'plan-mode-guard-deny',
        tool_name: 'Write',
        decision: 'deny',
      }),
    );
  });

  it('approves ExitPlanMode directly when plan mode is inactive', async () => {
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(async () => ({
      decision: 'approved',
    }));

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_exit_inactive',
          toolName: 'ExitPlanMode',
          args: {},
          execution: planReviewExecution({ plan: '# Plan', path: '/tmp/plan.md' }),
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    expect(telemetryTrack).toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({
        policy_name: 'plan-mode-tool-approve',
        tool_name: 'ExitPlanMode',
        decision: 'approve',
      }),
    );
  });

  it('approves ExitPlanMode while active when there is no plan review display', async () => {
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { planModeActive: true, planFilePath: '/tmp/plan.md' },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_exit_generic_display',
          toolName: 'ExitPlanMode',
          args: {},
          execution: {
            ...testExecution('ExitPlanMode', {}),
            display: genericDisplay(),
            approvalRule: 'ExitPlanMode',
          },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    expect(telemetryTrack).toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({
        policy_name: 'plan-mode-tool-approve',
        tool_name: 'ExitPlanMode',
        decision: 'approve',
      }),
    );
  });

  it('approves ExitPlanMode while active when the plan review is blank', async () => {
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { planModeActive: true, planFilePath: '/tmp/plan.md' },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_exit_blank_plan',
          toolName: 'ExitPlanMode',
          args: {},
          execution: planReviewExecution({ plan: '  \n\t', path: '/tmp/plan.md' }),
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    expect(telemetryTrack).toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({
        policy_name: 'plan-mode-tool-approve',
        tool_name: 'ExitPlanMode',
        decision: 'approve',
      }),
    );
  });

  it('defers non-empty plan reviews to the review approval policy', async () => {
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { planModeActive: true, planFilePath: '/tmp/plan.md' },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_exit_review',
          toolName: 'ExitPlanMode',
          args: {},
          execution: planReviewExecution({ plan: '# Plan', path: '/tmp/plan.md' }),
        }),
      ),
    ).resolves.toMatchObject({
      syntheticResult: {
        isError: false,
        output: expect.stringContaining('Exited plan mode.'),
      },
    });

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(telemetryTrack).toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({
        policy_name: 'exit-plan-mode-review-ask',
        tool_name: 'ExitPlanMode',
        decision: 'ask',
      }),
    );
  });
});

describe('Plan mode Bash permission policy', () => {
  it('uses ordinary Bash approval in manual plan mode', async () => {
    const { manager, requestApproval } = makePlanPermissionManager({
      mode: 'manual',
      approval: { decision: 'approved' },
    });

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_plan_bash',
          toolName: 'Bash',
          args: { command: 'ls -la', timeout: 60 },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledWith(
      {
        turnId: 0,
        toolCallId: 'call_plan_bash',
        toolName: 'Bash',
        action: 'run command',
        display: {
          kind: 'command',
          command: 'ls -la',
        },
      },
      { signal: expect.any(AbortSignal) },
    );
  });

  it('reuses ordinary Bash approve-for-session in plan mode', async () => {
    const { manager, requestApproval } = makePlanPermissionManager({
      mode: 'manual',
    });
    manager.recordApprovalResult({
      turnId: 0,
      toolCallId: 'call_ordinary_bash',
      toolName: 'Bash',
      action: 'run command',
      sessionApprovalRule: 'Bash(ls -la)',
      result: {
        decision: 'approved',
        scope: 'session',
        selectedLabel: 'Approve for this session',
      },
    });

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_plan_bash',
          toolName: 'Bash',
          args: { command: 'ls -la', timeout: 60 },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    expect(manager.data().rules).toEqual([]);
    expect(manager.sessionApprovalRulePatterns).toContain('Bash(ls -la)');
  });

  it.each(['yolo', 'auto'] as const)(
    'defers Bash to ordinary %s permission behavior in plan mode',
    async (mode) => {
      const { manager, requestApproval } = makePlanPermissionManager({
        mode,
        approval: { decision: 'rejected' },
      });

      await expect(
        manager.beforeToolCall(
          hookContext({
            id: 'call_plan_bash',
            toolName: 'Bash',
            args: { command: 'rm generated.txt', timeout: 60 },
          }),
        ),
      ).resolves.toBeUndefined();

      expect(requestApproval).not.toHaveBeenCalled();
    },
  );
});

describe('ExitPlanMode permission policy', () => {
  const planOptions = [
    { label: 'Approach A', description: 'Use the small change.' },
    { label: 'Approach B', description: 'Use the complete refactor.' },
  ];

  it('allows ExitPlanMode directly in auto mode without requesting approval', async () => {
    const { manager, requestApproval } = makePlanPermissionManager({
      mode: 'auto',
      plan: '# Auto Plan',
    });

    const result = await manager.beforeToolCall(
      hookContext({ id: 'call_exit', toolName: 'ExitPlanMode', args: {} }),
    );

    expect(result).toBeUndefined();
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('requests plan-review approval in yolo mode and returns formatted output', async () => {
    const { manager, record, requestApproval, exit } = makePlanPermissionManager({
      mode: 'yolo',
      plan: '# Plan\n\n- Step',
      path: '/tmp/plan.md',
      approval: { decision: 'approved', selectedLabel: 'Approach B' },
    });

    const result = await manager.beforeToolCall(
      hookContext({
        id: 'call_exit',
        toolName: 'ExitPlanMode',
        args: { options: planOptions },
        execution: planReviewExecution({
          plan: '# Plan\n\n- Step',
          path: '/tmp/plan.md',
          options: planOptions,
        }),
      }),
    );

    expect(requestApproval).toHaveBeenCalledWith(
      {
        turnId: 0,
        toolCallId: 'call_exit',
        toolName: 'ExitPlanMode',
        action: 'Presenting plan and exiting plan mode',
        display: {
          kind: 'plan_review',
          plan: '# Plan\n\n- Step',
          path: '/tmp/plan.md',
          options: planOptions,
        },
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(record).toHaveBeenCalledWith({
      type: 'permission.record_approval_result',
      turnId: 0,
      toolCallId: 'call_exit',
      toolName: 'ExitPlanMode',
      action: 'Presenting plan and exiting plan mode',
      sessionApprovalRule: undefined,
      result: { decision: 'approved', selectedLabel: 'Approach B' },
    });
    expect(exit).toHaveBeenCalled();
    expect(result).toMatchObject({
      syntheticResult: {
        isError: false,
        output: expect.stringContaining('Selected approach: Approach B'),
      },
    });
  });

  it('reuses session approval for ExitPlanMode without re-prompting plan review', async () => {
    const { manager, requestApproval, exit } = makePlanPermissionManager({
      mode: 'manual',
      plan: '# Updated Plan',
      approval: { decision: 'approved' },
    });
    manager.recordApprovalResult({
      turnId: 0,
      toolCallId: 'previous_exit',
      toolName: 'ExitPlanMode',
      action: 'Presenting plan and exiting plan mode',
      sessionApprovalRule: 'ExitPlanMode',
      result: { decision: 'approved', scope: 'session' },
    });

    const result = await manager.beforeToolCall(
      hookContext({
        id: 'call_exit',
        toolName: 'ExitPlanMode',
        args: {},
        execution: planReviewExecution({ plan: '# Updated Plan', path: '/tmp/plan.md' }),
      }),
    );

    expect(requestApproval).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it('returns a synthetic stop-turn result when the user rejects the plan', async () => {
    const { manager, exit } = makePlanPermissionManager({
      mode: 'manual',
      plan: '# Draft Plan',
      approval: { decision: 'rejected', selectedLabel: 'Reject' },
    });

    const result = await manager.beforeToolCall(
      hookContext({
        id: 'call_exit',
        toolName: 'ExitPlanMode',
        args: {},
        execution: planReviewExecution({ plan: '# Draft Plan', path: '/tmp/plan.md' }),
      }),
    );

    expect(exit).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      syntheticResult: {
        isError: true,
        stopTurn: true,
        output: 'Plan rejected by user. Plan mode remains active.',
      },
    });
  });

  it('keeps plan mode active when plan approval is cancelled', async () => {
    const { manager, exit } = makePlanPermissionManager({
      mode: 'manual',
      plan: '# Draft Plan',
      approval: { decision: 'cancelled', feedback: 'dismissed' },
    });

    const result = await manager.beforeToolCall(
      hookContext({
        id: 'call_exit',
        toolName: 'ExitPlanMode',
        args: {},
        execution: planReviewExecution({ plan: '# Draft Plan', path: '/tmp/plan.md' }),
      }),
    );

    expect(exit).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      syntheticResult: {
        isError: false,
        output: 'Plan approval dismissed. Plan mode remains active.',
      },
    });
  });

  it('keeps plan mode active when plan approval request fails', async () => {
    const { manager, exit, record } = makePlanPermissionManager({
      mode: 'manual',
      plan: '# Draft Plan',
      approvalError: new Error('approval transport closed'),
    });

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_exit',
          toolName: 'ExitPlanMode',
          args: {},
          execution: planReviewExecution({ plan: '# Draft Plan', path: '/tmp/plan.md' }),
        }),
      ),
    ).rejects.toThrow('approval transport closed');

    expect(exit).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('keeps plan mode active and returns revision feedback as a synthetic result', async () => {
    const { manager, exit } = makePlanPermissionManager({
      mode: 'manual',
      plan: '# Draft Plan',
      approval: {
        decision: 'rejected',
        selectedLabel: 'Revise',
        feedback: 'Add verification.',
      },
    });

    const result = await manager.beforeToolCall(
      hookContext({
        id: 'call_exit',
        toolName: 'ExitPlanMode',
        args: {},
        execution: planReviewExecution({ plan: '# Draft Plan', path: '/tmp/plan.md' }),
      }),
    );

    expect(exit).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      syntheticResult: {
        isError: false,
        output: expect.stringContaining('Add verification.'),
      },
    });
  });

  it('returns approved plan output without a saved-to line when display has no path', async () => {
    const { manager } = makePlanPermissionManager({
      mode: 'manual',
      plan: '# Draft Plan',
      approval: { decision: 'approved' },
    });

    const result = await manager.beforeToolCall(
      hookContext({
        id: 'call_exit_no_path',
        toolName: 'ExitPlanMode',
        args: {},
        execution: planReviewExecution({ plan: '# Draft Plan' }),
      }),
    );

    expect(result).toMatchObject({
      syntheticResult: {
        isError: false,
        output: expect.stringContaining('## Approved Plan:\n# Draft Plan'),
      },
    });
    expect(result?.syntheticResult?.output).not.toContain('Plan saved to:');
  });

  it('does not force a selected-approach prefix for labels that are not in the options', async () => {
    const { manager, telemetryTrack } = makePlanPermissionManager({
      mode: 'manual',
      plan: '# Draft Plan',
      approval: { decision: 'approved', selectedLabel: 'Approach C' },
    });

    const result = await manager.beforeToolCall(
      hookContext({
        id: 'call_exit_unknown_option',
        toolName: 'ExitPlanMode',
        args: { options: planOptions },
        execution: planReviewExecution({
          plan: '# Draft Plan',
          path: '/tmp/plan.md',
          options: planOptions,
        }),
      }),
    );

    expect(result?.syntheticResult?.output).not.toContain('Selected approach:');
    expect(telemetryTrack).toHaveBeenCalledWith('plan_resolved', {
      outcome: 'approved',
      chosen_option: 'Approach C',
    });
  });

  it('returns the exit failure when reject-and-exit cannot leave plan mode', async () => {
    const { manager, exit } = makePlanPermissionManager({
      mode: 'manual',
      plan: '# Draft Plan',
      approval: { decision: 'rejected', selectedLabel: 'Reject and Exit' },
    });
    exit.mockImplementation(() => {
      throw new Error('state transition failure');
    });

    const result = await manager.beforeToolCall(
      hookContext({
        id: 'call_exit_reject_exit_failure',
        toolName: 'ExitPlanMode',
        args: {},
        execution: planReviewExecution({ plan: '# Draft Plan', path: '/tmp/plan.md' }),
      }),
    );

    expect(result).toMatchObject({
      syntheticResult: {
        isError: true,
        output: 'Failed to exit plan mode: state transition failure',
      },
    });
  });

  it('tracks approval transport errors before rethrowing', async () => {
    const { manager, telemetryTrack } = makePlanPermissionManager({
      mode: 'manual',
      plan: '# Draft Plan',
      approvalError: new Error('approval transport closed'),
    });

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_exit_approval_error',
          toolName: 'ExitPlanMode',
          args: {},
          execution: planReviewExecution({ plan: '# Draft Plan', path: '/tmp/plan.md' }),
        }),
      ),
    ).rejects.toThrow('approval transport closed');

    expect(telemetryTrack).toHaveBeenCalledWith(
      'permission_approval_result',
      expect.objectContaining({
        policy_name: 'exit-plan-mode-review-ask',
        tool_name: 'ExitPlanMode',
        result: 'error',
      }),
    );
  });
});

describe('Agent-local approve for session', () => {
  it('turns approved session-scoped responses into an agent-local runtime rule cache', async () => {
    const { manager, record, requestApproval, telemetryTrack } = makePermissionManager(async () => ({
      decision: 'approved',
      scope: 'session',
      selectedLabel: 'Approve for this session',
    }));
    const firstArgs = { command: 'printf first', timeout: 60 };
    const firstRule = 'Bash(printf first)';

    await expect(manager.beforeToolCall(hookContext({ id: 'call_1' }))).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(telemetryTrack).toHaveBeenNthCalledWith(
      1,
      'permission_policy_decision',
      expect.objectContaining({
        policy_name: 'fallback-ask',
        tool_name: 'Bash',
        permission_mode: 'manual',
        decision: 'ask',
      }),
    );
    expect(telemetryTrack).toHaveBeenNthCalledWith(
      2,
      'permission_approval_result',
      expect.objectContaining({
        policy_name: 'fallback-ask',
        tool_name: 'Bash',
        permission_mode: 'manual',
        result: 'approved_for_session',
        session_cache_written: true,
      }),
    );
    expect(record).toHaveBeenCalledWith({
      type: 'permission.record_approval_result',
      turnId: 0,
      toolCallId: 'call_1',
      toolName: 'Bash',
      action: 'run command',
      sessionApprovalRule: firstRule,
      result: {
        decision: 'approved',
        scope: 'session',
        selectedLabel: 'Approve for this session',
      },
    });
    expect(manager.data().rules).toEqual([]);
    expect(manager.sessionApprovalRulePatterns).toContain(firstRule);

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_2',
          args: firstArgs,
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(telemetryTrack).toHaveBeenNthCalledWith(
      3,
      'permission_policy_decision',
      expect.objectContaining({
        policy_name: 'session-approval-history',
        tool_name: 'Bash',
        decision: 'approve',
      }),
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_3',
          args: { command: 'printf second', timeout: 60 },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(requestApproval).toHaveBeenCalledTimes(2);
  });

  it('caches session approvals for tools without argument matchers at tool granularity', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
      scope: 'session',
      selectedLabel: 'Approve for this session',
    }));

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_custom_1',
          toolName: 'Custom',
          args: { query: 'first' },
        }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_custom_2',
          toolName: 'Custom',
          args: { query: 'second' },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(manager.sessionApprovalRulePatterns).toContain('Custom');
  });

  it('stores runtime rules with literal glob escaping', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
      scope: 'session',
    }));

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_literal',
          args: { command: 'printf *', timeout: 60 },
        }),
      ),
    ).resolves.toBeUndefined();

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_other',
          args: { command: 'printf hello', timeout: 60 },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(2);
  });

  it('keeps approved once responses one-shot', async () => {
    const { manager, record, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));

    await expect(manager.beforeToolCall(hookContext({ id: 'call_1' }))).resolves.toBeUndefined();
    await expect(manager.beforeToolCall(hookContext({ id: 'call_2' }))).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenNthCalledWith(1, {
      type: 'permission.record_approval_result',
      turnId: 0,
      toolCallId: 'call_1',
      toolName: 'Bash',
      action: 'run command',
      sessionApprovalRule: undefined,
      result: {
        decision: 'approved',
      },
    });
    expect(record).toHaveBeenNthCalledWith(2, {
      type: 'permission.record_approval_result',
      turnId: 0,
      toolCallId: 'call_2',
      toolName: 'Bash',
      action: 'run command',
      sessionApprovalRule: undefined,
      result: {
        decision: 'approved',
      },
    });
    expect(manager.data().rules).toEqual([]);
  });

  it('does not let session approval override an explicit deny rule', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.recordApprovalResult({
      turnId: 0,
      toolCallId: 'call_session',
      toolName: 'Bash',
      action: 'run command',
      sessionApprovalRule: 'Bash(printf first)',
      result: {
        decision: 'approved',
        scope: 'session',
      },
    });
    manager.rules.push({
      decision: 'deny',
      scope: 'user',
      pattern: 'Bash',
      reason: 'blocked by test',
    });

    const result = await manager.beforeToolCall(hookContext({ id: 'call_1' }));

    expect(result).toMatchObject({
      block: true,
      reason: 'Tool "Bash" was denied by permission rule. Reason: blocked by test',
    });
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('continues across non-matching and malformed session approval patterns', async () => {
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.recordApprovalResult({
      turnId: 0,
      toolCallId: 'call_bad_session',
      toolName: 'Bash',
      action: 'run command',
      sessionApprovalRule: 'Bash(unterminated',
      result: { decision: 'approved', scope: 'session' },
    });
    manager.recordApprovalResult({
      turnId: 0,
      toolCallId: 'call_other_session',
      toolName: 'Custom',
      action: 'call custom',
      sessionApprovalRule: 'Custom',
      result: { decision: 'approved', scope: 'session' },
    });
    manager.recordApprovalResult({
      turnId: 0,
      toolCallId: 'call_matching_session',
      toolName: 'Bash',
      action: 'run command',
      sessionApprovalRule: 'Bash(printf first)',
      result: { decision: 'approved', scope: 'session' },
    });

    await expect(manager.beforeToolCall(hookContext({ id: 'call_session_match_late' }))).resolves
      .toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    expect(telemetryTrack).toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({
        policy_name: 'session-approval-history',
        tool_name: 'Bash',
        decision: 'approve',
        has_rule_args: true,
        match_strategy: 'matches_rule',
      }),
    );
  });

  it('does not reuse a session approval whose tool name does not match', async () => {
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.recordApprovalResult({
      turnId: 0,
      toolCallId: 'call_custom_session',
      toolName: 'Custom',
      action: 'call custom',
      sessionApprovalRule: 'Custom',
      result: { decision: 'approved', scope: 'session' },
    });

    await expect(manager.beforeToolCall(hookContext({ id: 'call_bash_no_session' }))).resolves
      .toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(telemetryTrack).toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({
        policy_name: 'fallback-ask',
        tool_name: 'Bash',
      }),
    );
  });

  it('replays session approval wire events into agent permission state', () => {
    const ctx = testAgent();
    const sessionApprovalRule = 'Bash(printf first)';

    ctx.dispatch({
      type: 'permission.record_approval_result',
      turnId: 0,
      toolCallId: 'call_replay',
      toolName: 'Bash',
      action: 'run command',
      sessionApprovalRule,
      result: {
        decision: 'approved',
        scope: 'session',
        selectedLabel: 'Approve for this session',
      },
    });

    expect(ctx.agent.permission.data().rules).toEqual([]);
    expect(ctx.agent.permission.sessionApprovalRulePatterns).toContain(sessionApprovalRule);
  });

  it('replays one-shot approval wire events without adding session rules', () => {
    const ctx = testAgent();
    const record = {
      turnId: 0,
      toolCallId: 'call_replay',
      toolName: 'Bash',
      action: 'run command',
      result: {
        decision: 'approved',
        selectedLabel: 'Approve once',
      },
    } as const;

    const event = {
      type: 'permission.record_approval_result',
      ...record,
    } as const;

    ctx.dispatch(event);

    expect(ctx.agent.replayBuilder.buildResult()).toContainEqual({
      type: 'approval_result',
      record: event,
    });
    expect(ctx.agent.permission.data().rules).toEqual([]);
  });
});

describe('Approval telemetry', () => {
  it('tracks cancelled approval requests', async () => {
    const { manager, telemetryTrack } = makePermissionManager(async () => ({
      decision: 'cancelled',
      feedback: 'request closed',
    }));

    await expect(manager.beforeToolCall(hookContext({ id: 'call_1' }))).resolves.toMatchObject({
      block: true,
      reason: expect.stringContaining('approval request was cancelled'),
    });

    expect(telemetryTrack).toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({
        policy_name: 'fallback-ask',
        tool_name: 'Bash',
        permission_mode: 'manual',
        decision: 'ask',
      }),
    );
    expect(telemetryTrack).toHaveBeenCalledWith(
      'permission_approval_result',
      expect.objectContaining({
        policy_name: 'fallback-ask',
        tool_name: 'Bash',
        permission_mode: 'manual',
        result: 'cancelled',
        has_feedback: true,
        session_cache_written: false,
      }),
    );
  });
});

describe('Default git CWD Write/Edit permission', () => {
  const DIR_MODE = 0o040_755;
  const FILE_MODE = 0o100_644;
  const SYMLINK_MODE = 0o120_777;

  function statResult(mode: number): Awaited<ReturnType<Kaos['stat']>> {
    return {
      stMode: mode,
      stIno: 1,
      stDev: 1,
      stNlink: 1,
      stUid: 1000,
      stGid: 1000,
      stSize: 0,
      stAtime: 0,
      stMtime: 0,
      stCtime: 0,
    };
  }

  function notFound(path: string): Error {
    return Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' });
  }

  function sshNotFound(path: string): Error {
    const error = Object.assign(new Error(`No such file: ${path}`), { code: 2 });
    error.name = 'KaosFileNotFoundError';
    return error;
  }

  function gitKaos(options: {
    readonly markerPath?: string | undefined;
    readonly markerMode?: number | undefined;
    readonly statModes?: Readonly<Record<string, number>> | undefined;
    readonly readText?: Kaos['readText'] | undefined;
    readonly missingError?: (path: string) => Error;
  } = {}): { kaos: Kaos; stat: ReturnType<typeof vi.fn<Kaos['stat']>> } {
    const markerPath = options.markerPath ?? '/workspace/.git';
    const statModes: Readonly<Record<string, number>> = {
      '/workspace': DIR_MODE,
      '/workspace/src': DIR_MODE,
      [markerPath]: options.markerMode ?? DIR_MODE,
      ...options.statModes,
    };
    const stat = vi
      .fn<Kaos['stat']>()
      .mockImplementation(async (path) => {
        const mode = statModes[path];
        if (mode !== undefined) return statResult(mode);
        throw options.missingError?.(path) ?? notFound(path);
      });
    return {
      kaos: createFakeKaos({ stat, readText: options.readText }),
      stat,
    };
  }

  function nonGitKaos(): Kaos {
    return createFakeKaos({
      stat: vi.fn<Kaos['stat']>().mockRejectedValue(new Error('ENOENT')),
    });
  }

  function writeHook(args: Record<string, unknown>, id = 'call_write'): PermissionPolicyContext {
    return hookContext({ id, toolName: 'Write', args });
  }

  function editHook(args: Record<string, unknown>, id = 'call_edit'): PermissionPolicyContext {
    return hookContext({ id, toolName: 'Edit', args });
  }

  it('still requests approval for Bash inside a git cwd in manual mode', async () => {
    const { kaos, stat } = gitKaos();
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );

    await expect(manager.beforeToolCall(hookContext({ id: 'call_bash_git_cwd' }))).resolves
      .toBeUndefined();

    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'Bash',
        action: 'run command',
      }),
      expect.any(Object),
    );
    expect(telemetryTrack).not.toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({ policy_name: 'git-cwd-write-approve' }),
    );
    expect(stat).not.toHaveBeenCalled();
  });

  it('bypasses approval for Write to a relative path inside a git cwd', async () => {
    const { kaos } = gitKaos();
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );

    await expect(
      manager.beforeToolCall(writeHook({ path: 'src/a.ts', content: 'x' })),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    expect(telemetryTrack).toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({
        policy_name: 'git-cwd-write-approve',
        tool_name: 'Write',
        permission_mode: 'manual',
        decision: 'approve',
      }),
    );
  });

  it('bypasses approval for Edit on an absolute path inside the git cwd', async () => {
    const { kaos } = gitKaos();
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );

    await expect(
      manager.beforeToolCall(
        editHook({ path: '/workspace/src/a.ts', old_string: 'A', new_string: 'B' }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    expect(telemetryTrack).toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({
        policy_name: 'git-cwd-write-approve',
        tool_name: 'Edit',
        permission_mode: 'manual',
        decision: 'approve',
      }),
    );
  });

  it('still requests approval when cwd is not inside a git work tree', async () => {
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos: nonGitKaos() },
    );

    await expect(
      manager.beforeToolCall(writeHook({ path: 'src/a.ts', content: 'x' })),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(telemetryTrack).not.toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({ policy_name: 'git-cwd-write-approve' }),
    );
  });

  it('rechecks missing git marker checks across repeated Write/Edit calls in the same cwd', async () => {
    const stat = vi.fn<Kaos['stat']>().mockRejectedValue(new Error('ENOENT'));
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos: createFakeKaos({ stat }) },
    );

    await expect(
      manager.beforeToolCall(writeHook({ path: 'src/a.ts', content: 'x' }, 'call_1')),
    ).resolves.toBeUndefined();
    await expect(
      manager.beforeToolCall(
        editHook({ path: 'src/b.ts', old_string: 'A', new_string: 'B' }, 'call_2'),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(2);
    expect(stat.mock.calls.map(([path]) => path)).toEqual([
      '/workspace/.git',
      '/.git',
      '/workspace/.git',
      '/.git',
      '/workspace/.git',
      '/.git',
      '/workspace/.git',
      '/.git',
    ]);
  });

  it('still requests approval when a relative path escapes cwd via ..', async () => {
    const { kaos } = gitKaos();
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );

    await expect(
      manager.beforeToolCall(writeHook({ path: '../outside.ts', content: 'x' })),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('still requests approval for an absolute path outside the cwd', async () => {
    const { kaos } = gitKaos();
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );

    await expect(
      manager.beforeToolCall(writeHook({ path: '/tmp/outside.ts', content: 'x' })),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('still requests approval for a path inside the git root but outside the cwd', async () => {
    const { kaos } = gitKaos({ markerPath: '/a/.git' });
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { cwd: '/a/b/c', kaos },
    );

    await expect(
      manager.beforeToolCall(writeHook({ path: '/a/x.ts', content: 'x' })),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(telemetryTrack).not.toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({ policy_name: 'git-cwd-write-approve' }),
    );
  });

  it.each(['.git/config', '.git/hooks/pre-commit'])(
    'still requests approval for git control file %s',
    async (path) => {
      const { kaos } = gitKaos();
      const { manager, requestApproval, telemetryTrack } = makePermissionManager(
        async () => ({ decision: 'approved' }),
        { kaos },
      );

      await expect(manager.beforeToolCall(writeHook({ path, content: 'x' }))).resolves
        .toBeUndefined();

      expect(requestApproval).toHaveBeenCalledTimes(1);
      expect(telemetryTrack).not.toHaveBeenCalledWith(
        'permission_policy_decision',
        expect.objectContaining({ policy_name: 'git-cwd-write-approve' }),
      );
    },
  );

  it('still requests approval for case-variant git control files', async () => {
    const { kaos } = gitKaos();
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );

    await expect(
      manager.beforeToolCall(writeHook({ path: '.GIT/config', content: 'x' })),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(telemetryTrack).not.toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({ policy_name: 'git-cwd-write-approve' }),
    );
  });

  it('still requests approval for a linked-worktree gitdir inside cwd', async () => {
    const { kaos } = gitKaos({
      markerMode: FILE_MODE,
      statModes: { '/workspace/.gitdir': DIR_MODE },
      readText: vi.fn<Kaos['readText']>(async (path) => {
        if (path === '/workspace/.git') return 'gitdir: .gitdir\n';
        throw notFound(path);
      }),
    });
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );

    await expect(
      manager.beforeToolCall(writeHook({ path: '/workspace/.gitdir/config', content: 'x' })),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(telemetryTrack).not.toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({ policy_name: 'git-cwd-write-approve' }),
    );
  });

  it('does not ask for ordinary file access when a git marker exists', async () => {
    const { kaos } = gitKaos();
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_read_regular_git_cwd',
          toolName: 'Read',
          args: { path: '/workspace/src/a.ts' },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    expect(telemetryTrack).toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({ policy_name: 'default-tool-approve' }),
    );
  });

  it('asks before accessing the .git marker path itself', async () => {
    const { kaos } = gitKaos();
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_read_dot_git',
          toolName: 'Read',
          args: { path: '/workspace/.git' },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(telemetryTrack).toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({
        policy_name: 'git-control-path-access-ask',
        tool_name: 'Read',
        decision: 'ask',
        git_control_path: true,
      }),
    );
  });

  it('does not check git control paths when cwd is empty', async () => {
    const { kaos } = gitKaos();
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { cwd: '', kaos },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_empty_cwd_git',
          toolName: 'Read',
          args: { path: '/workspace/.git/config' },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    expect(telemetryTrack).toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({ policy_name: 'default-tool-approve' }),
    );
  });

  it('detects Win32 .git path components case-insensitively', async () => {
    const kaos = createFakeKaos({ pathClass: () => 'win32' });
    const args = { path: 'C:\\repo\\.GIT\\config' };
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { cwd: 'C:\\repo', kaos },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_win_git',
          toolName: 'Read',
          args,
          execution: {
            ...testExecution('Read', args),
            accesses: ToolAccesses.readFile('C:\\repo\\.GIT\\config'),
          },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(telemetryTrack).toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({
        policy_name: 'git-control-path-access-ask',
        git_control_path: true,
      }),
    );
  });

  it.each([
    [
      'Read',
      { path: '/workspace/src/a.ts' },
      { path: '/workspace/.gitdir/config' },
    ],
    [
      'Grep',
      { pattern: 'TODO', path: '/workspace/src' },
      { pattern: 'TODO', path: '/workspace/.gitdir' },
    ],
    [
      'Glob',
      { pattern: '**/*.ts', path: '/workspace/src' },
      { pattern: '*', path: '/workspace/.gitdir' },
    ],
  ] as const)(
    'rechecks git marker changes before default-approving %s access',
    async (toolName, firstArgs, secondArgs) => {
      let markerReady = false;
      const stat = vi.fn<Kaos['stat']>(async (path) => {
        if (markerReady && path === '/workspace/.git') return statResult(FILE_MODE);
        throw notFound(path);
      });
      const readText = vi.fn<Kaos['readText']>(async (path) => {
        if (path === '/workspace/.git') return 'gitdir: .gitdir\n';
        throw notFound(path);
      });
      const { manager, requestApproval, telemetryTrack } = makePermissionManager(
        async () => ({ decision: 'approved' }),
        { kaos: createFakeKaos({ stat, readText }) },
      );

      await expect(
        manager.beforeToolCall(hookContext({ id: `call_${toolName}_before`, toolName, args: firstArgs })),
      ).resolves.toBeUndefined();
      expect(requestApproval).not.toHaveBeenCalled();

      markerReady = true;
      await expect(
        manager.beforeToolCall(hookContext({ id: `call_${toolName}_after`, toolName, args: secondArgs })),
      ).resolves.toBeUndefined();

      expect(requestApproval).toHaveBeenCalledTimes(1);
      expect(telemetryTrack).toHaveBeenCalledWith(
        'permission_policy_decision',
        expect.objectContaining({
          policy_name: 'git-control-path-access-ask',
          tool_name: toolName,
          permission_mode: 'manual',
          decision: 'ask',
        }),
      );
    },
  );

  it('bypasses approval for a lexical path inside git cwd without resolving parent symlinks', async () => {
    const { kaos } = gitKaos({
      statModes: { '/workspace/out': SYMLINK_MODE },
    });
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );

    await expect(
      manager.beforeToolCall(writeHook({ path: 'out/hosts', content: 'x' })),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    expect(telemetryTrack).toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({ policy_name: 'git-cwd-write-approve' }),
    );
  });

  it('bypasses approval for a lexical target inside git cwd without resolving target symlinks', async () => {
    const { kaos } = gitKaos({
      statModes: { '/workspace/link.txt': SYMLINK_MODE },
    });
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );

    await expect(
      manager.beforeToolCall(writeHook({ path: 'link.txt', content: 'x' })),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    expect(telemetryTrack).toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({ policy_name: 'git-cwd-write-approve' }),
    );
  });

  it('still requests approval for a sensitive file inside the git cwd', async () => {
    const { kaos } = gitKaos();
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );

    await expect(
      manager.beforeToolCall(writeHook({ path: '.env', content: 'SECRET=1' })),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it.each(['.env.local', '.aws/credentials'])(
    'still requests approval for sensitive file %s',
    async (path) => {
      const { kaos } = gitKaos({
        statModes: path.includes('/') ? { '/workspace/.aws': DIR_MODE } : {},
      });
      const { manager, requestApproval, telemetryTrack } = makePermissionManager(
        async () => ({ decision: 'approved' }),
        { kaos },
      );

      await expect(manager.beforeToolCall(writeHook({ path, content: 'secret' }))).resolves
        .toBeUndefined();

      expect(requestApproval).toHaveBeenCalledTimes(1);
      expect(telemetryTrack).not.toHaveBeenCalledWith(
        'permission_policy_decision',
        expect.objectContaining({ policy_name: 'git-cwd-write-approve' }),
      );
    },
  );

  it.each(['src/config.ts', '.env.example', '.env.sample', '.env.template', 'id_rsa.pub'])(
    'does not treat non-sensitive or exempt file %s as sensitive',
    async (path) => {
      const { kaos } = gitKaos({
        statModes: path.includes('/') ? { '/workspace/src': DIR_MODE } : {},
      });
      const { manager, requestApproval, telemetryTrack } = makePermissionManager(
        async () => ({ decision: 'approved' }),
        { kaos },
      );

      await expect(manager.beforeToolCall(writeHook({ path, content: 'x' }))).resolves
        .toBeUndefined();

      expect(requestApproval).not.toHaveBeenCalled();
      expect(telemetryTrack).not.toHaveBeenCalledWith(
        'permission_policy_decision',
        expect.objectContaining({ policy_name: 'sensitive-file-access-ask' }),
      );
      expect(telemetryTrack).toHaveBeenCalledWith(
        'permission_policy_decision',
        expect.objectContaining({ policy_name: 'git-cwd-write-approve' }),
      );
    },
  );

  it('requests approval for sensitive read access before default approval', async () => {
    const { kaos } = gitKaos();
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_read_env',
          toolName: 'Read',
          args: { path: '.env' },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(telemetryTrack).toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({
        policy_name: 'sensitive-file-access-ask',
        tool_name: 'Read',
        decision: 'ask',
        file_access_operation: 'read',
        sensitive_path: true,
      }),
    );
  });

  it('detects sensitive Win32 paths case-insensitively', async () => {
    const kaos = createFakeKaos({ pathClass: () => 'win32' });
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { cwd: 'C:\\repo', kaos },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_win_credentials',
          toolName: 'Read',
          args: { path: 'C:\\repo\\.AWS\\Credentials' },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(telemetryTrack).toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({
        policy_name: 'sensitive-file-access-ask',
        sensitive_path: true,
      }),
    );
  });

  it('bypasses approval for new files when SSH Kaos reports numeric no-such-file', async () => {
    const { kaos } = gitKaos({ missingError: sshNotFound });
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );

    await expect(
      manager.beforeToolCall(writeHook({ path: 'src/new.ts', content: 'x' })),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    expect(telemetryTrack).toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({
        policy_name: 'git-cwd-write-approve',
        tool_name: 'Write',
        permission_mode: 'manual',
        decision: 'approve',
      }),
    );
  });

  it('lets an explicit `ask` rule keep the approval prompt for Write', async () => {
    const { kaos } = gitKaos();
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );
    manager.rules.push({
      decision: 'ask',
      scope: 'user',
      pattern: 'Write',
      reason: 'user requested manual confirmation',
    });

    await expect(
      manager.beforeToolCall(writeHook({ path: 'src/a.ts', content: 'x' })),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(telemetryTrack).not.toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({ policy_name: 'git-cwd-write-approve' }),
    );
  });

  it('lets an explicit `allow` rule take the original allow path without git cwd approval telemetry', async () => {
    const { kaos } = gitKaos();
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );
    manager.rules.push({
      decision: 'allow',
      scope: 'user',
      pattern: 'Write',
    });

    await expect(
      manager.beforeToolCall(writeHook({ path: 'src/a.ts', content: 'x' })),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    expect(telemetryTrack).not.toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({ policy_name: 'git-cwd-write-approve' }),
    );
  });

  it('keeps explicit `deny` rules higher priority than the bypass', async () => {
    const { kaos } = gitKaos();
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );
    manager.rules.push({
      decision: 'deny',
      scope: 'user',
      pattern: 'Write',
      reason: 'no writes here',
    });

    await expect(
      manager.beforeToolCall(writeHook({ path: 'src/a.ts', content: 'x' })),
    ).resolves.toMatchObject({
      block: true,
      reason: expect.stringContaining('no writes here'),
    });

    expect(requestApproval).not.toHaveBeenCalled();
    expect(telemetryTrack).not.toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({ policy_name: 'git-cwd-write-approve' }),
    );
  });

  it('does not fire in auto mode because auto-mode-approve takes over', async () => {
    const { kaos } = gitKaos();
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );
    manager.setMode('auto');

    await expect(
      manager.beforeToolCall(writeHook({ path: 'src/a.ts', content: 'x' })),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    expect(telemetryTrack).toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({
        policy_name: 'auto-mode-approve',
        tool_name: 'Write',
        permission_mode: 'auto',
        decision: 'approve',
      }),
    );
    expect(telemetryTrack).not.toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({ policy_name: 'git-cwd-write-approve' }),
    );
  });

  it('does not fire on Windows path semantics (Windows stMode unverified)', async () => {
    const stat = vi
      .fn<Kaos['stat']>()
      .mockImplementation(async (path) =>
        path === '/workspace/.git'
          ? statResult(0o040_755)
          : Promise.reject(new Error('ENOENT')),
      );
    const kaos = createFakeKaos({ stat, pathClass: () => 'win32' });
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );

    await expect(
      manager.beforeToolCall(writeHook({ path: 'src/a.ts', content: 'x' })),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(telemetryTrack).not.toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({ policy_name: 'git-cwd-write-approve' }),
    );
  });

  it('does not approve when cwd is empty', async () => {
    const { kaos } = gitKaos();
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { cwd: '', kaos },
    );

    await expect(
      manager.beforeToolCall(writeHook({ path: 'src/a.ts', content: 'x' })),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(telemetryTrack).not.toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({ policy_name: 'git-cwd-write-approve' }),
    );
  });

  it('does not approve Write when execution has no write file access', async () => {
    const { kaos } = gitKaos();
    const args = { path: 'src/a.ts', content: 'x' };
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_write_no_file_access',
          toolName: 'Write',
          args,
          execution: {
            ...testExecution('Write', args),
            accesses: ToolAccesses.none(),
          },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(telemetryTrack).not.toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({ policy_name: 'git-cwd-write-approve' }),
    );
  });

  it('approves multiple write accesses when all are inside the git cwd', async () => {
    const { kaos } = gitKaos();
    const args = { path: 'src/a.ts', content: 'x' };
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_multi_inside_write',
          toolName: 'Write',
          args,
          execution: {
            ...testExecution('Write', args),
            accesses: [
              { kind: 'file', operation: 'write', path: '/workspace/src/a.ts' },
              { kind: 'file', operation: 'readwrite', path: '/workspace/src/b.ts' },
            ],
          },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    expect(telemetryTrack).toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({ policy_name: 'git-cwd-write-approve' }),
    );
  });

  it('does not approve when any write access is outside the cwd', async () => {
    const { kaos } = gitKaos();
    const args = { path: 'src/a.ts', content: 'x' };
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_multi_outside_write',
          toolName: 'Write',
          args,
          execution: {
            ...testExecution('Write', args),
            accesses: [
              { kind: 'file', operation: 'write', path: '/workspace/src/a.ts' },
              { kind: 'file', operation: 'write', path: '/tmp/outside.ts' },
            ],
          },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(telemetryTrack).toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({ policy_name: 'cwd-outside-file-write-ask' }),
    );
    expect(telemetryTrack).not.toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({ policy_name: 'git-cwd-write-approve' }),
    );
  });

  it('does not approve non-Write/Edit tools even if they report write access', async () => {
    const { kaos } = gitKaos();
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_custom_write_access',
          toolName: 'Custom',
          args: {},
          execution: {
            ...testExecution('Custom', {}),
            accesses: ToolAccesses.writeFile('/workspace/src/a.ts'),
          },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(telemetryTrack).not.toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({ policy_name: 'git-cwd-write-approve' }),
    );
  });

  it('rechecks git marker hits across repeated Write/Edit calls in the same cwd', async () => {
    const { kaos, stat } = gitKaos();
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { kaos },
    );

    await expect(
      manager.beforeToolCall(writeHook({ path: 'src/a.ts', content: 'x' }, 'call_1')),
    ).resolves.toBeUndefined();
    await expect(
      manager.beforeToolCall(editHook({ path: 'src/b.ts', old_string: 'A', new_string: 'B' }, 'call_2')),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    const markerCalls = stat.mock.calls.filter(([path]) => path === '/workspace/.git');
    expect(markerCalls).toHaveLength(4);
  });
});

describe('CWD outside file write permission policy', () => {
  it('falls through when cwd is empty', async () => {
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { cwd: '' },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_empty_cwd_write',
          toolName: 'Write',
          args: { path: '/tmp/outside.ts', content: 'x' },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(telemetryTrack).toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({ policy_name: 'fallback-ask' }),
    );
  });

  it('falls through when there are no file write accesses', async () => {
    const args = { path: '/tmp/outside.ts', content: 'x' };
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(async () => ({
      decision: 'approved',
    }));

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_no_write_accesses',
          toolName: 'Write',
          args,
          execution: {
            ...testExecution('Write', args),
            accesses: ToolAccesses.none(),
          },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(telemetryTrack).toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({ policy_name: 'fallback-ask' }),
    );
  });

  it('asks when any write access is outside the cwd', async () => {
    const args = { path: '/workspace/src/a.ts', content: 'x' };
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(async () => ({
      decision: 'approved',
    }));

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_mixed_write_accesses',
          toolName: 'Write',
          args,
          execution: {
            ...testExecution('Write', args),
            accesses: [
              { kind: 'file', operation: 'write', path: '/workspace/src/a.ts' },
              { kind: 'file', operation: 'readwrite', path: '/tmp/outside.ts' },
            ],
          },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(telemetryTrack).toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({
        policy_name: 'cwd-outside-file-write-ask',
        decision: 'ask',
        cwd_outside: true,
        file_access_operation: 'readwrite',
      }),
    );
  });

  it.each([
    ['Read', { path: '/tmp/outside.ts' }],
    ['Grep', { pattern: 'TODO', path: '/tmp' }],
  ] as const)('does not ask for %s access outside cwd', async (toolName, args) => {
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(async () => ({
      decision: 'approved',
    }));

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: `call_${toolName}_outside_cwd`,
          toolName,
          args,
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    expect(telemetryTrack).toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({ policy_name: 'default-tool-approve' }),
    );
  });

  it('uses Win32 path semantics for cwd containment', async () => {
    const kaos = createFakeKaos({ pathClass: () => 'win32' });
    const args = { path: 'c:\\repo\\src\\a.ts', content: 'x' };
    const { manager, telemetryTrack } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { cwd: 'C:\\Repo', kaos },
    );

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_win_inside_cwd',
          toolName: 'Write',
          args,
          execution: {
            ...testExecution('Write', args),
            accesses: ToolAccesses.writeFile('c:\\repo\\src\\a.ts'),
          },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(telemetryTrack).not.toHaveBeenCalledWith(
      'permission_policy_decision',
      expect.objectContaining({ policy_name: 'cwd-outside-file-write-ask' }),
    );
  });
});

describe('Permission rule helpers', () => {
  it('parses permission patterns used by rule matching', () => {
    expect(parsePattern('Write')).toEqual({ toolName: 'Write' });
    expect(parsePattern('Read(/etc/**)')).toEqual({
      toolName: 'Read',
      argPattern: '/etc/**',
    });
    expect(parsePattern('Edit(!./src/**)')).toEqual({
      toolName: 'Edit',
      argPattern: '!./src/**',
    });
    expect(parsePattern('  mcp__github__*  ')).toEqual({ toolName: 'mcp__github__*' });
    expect(parsePattern('Read()')).toEqual({ toolName: 'Read' });
    expect(() => parsePattern('Read(/etc/**')).toThrow(/missing closing paren/);
    expect(() => parsePattern('')).toThrow(/empty string/);
  });

  it('matches rules against the tool-specific argument fields', () => {
    expect(
      ruleMatches(permissionRule('Bash(git *)'), 'Bash', { command: 'git status' }, {
        matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, 'git status'),
      }),
    ).toBe(true);
    expect(
      ruleMatches(permissionRule('Bash(git *)'), 'Bash', { command: 'npm test' }, {
        matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, 'npm test'),
      }),
    ).toBe(false);
    expect(
      ruleMatches(permissionRule('Read(/etc/**)'), 'Read', { path: '/etc/passwd' }, {
        matchesRule: (ruleArgs) => matchesPathRuleSubject(ruleArgs, '/etc/passwd'),
      }),
    ).toBe(true);
    expect(
      ruleMatches(permissionRule('Edit(!./src/**)'), 'Edit', { path: './README.md' }, {
        matchesRule: (ruleArgs) =>
          matchesPathRuleSubject(ruleArgs, '/workspace/README.md', {
            cwd: '/workspace',
            pathClass: 'posix',
          }),
      }),
    ).toBe(true);
    expect(
      ruleMatches(permissionRule('Edit(!./src/**)'), 'Edit', { path: './src/a.ts' }, {
        matchesRule: (ruleArgs) =>
          matchesPathRuleSubject(ruleArgs, '/workspace/src/a.ts', {
            cwd: '/workspace',
            pathClass: 'posix',
          }),
      }),
    ).toBe(false);
    expect(
      ruleMatches(permissionRule('Agent(review-*)'), 'Agent', {
        subagent_type: 'review-code',
      }, {
        matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, 'review-code'),
      }),
    ).toBe(true);
    expect(ruleMatches(permissionRule('mcp__github__*'), 'mcp__github__list_issues', {})).toBe(
      true,
    );
    expect(
      ruleMatches(permissionRule('Bash(git *)'), 'Bash', { command: 42 }, {
        matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, '42'),
      }),
    ).toBe(false);
    expect(ruleMatches(permissionRule('Bad(unclosed'), 'Bad', {})).toBe(false);
  });

  it('does not match rule arguments without an execution matcher', () => {
    expect(
      ruleMatches(permissionRule('Custom("query":"a.b")'), 'Custom', {
        nested: { value: 1 },
        query: 'a.b',
      }),
    ).toBe(false);
    expect(
      ruleMatches(permissionRule('Bash("command":"git status")'), 'Bash', {
        command: 'git status',
      }),
    ).toBe(false);
    expect(
      ruleMatches(permissionRule('Bash(^git status$)'), 'Bash', {
        command: 'git status',
      }),
    ).toBe(false);
    expect(
      ruleMatches(permissionRule('Bash(^git status$)'), 'Bash', {
        command: 'npm test',
      }),
    ).toBe(false);
    expect(
      ruleMatches(permissionRule('Read([invalid'), 'Read', {
        path: '/workspace/a.ts',
      }),
    ).toBe(false);
  });

  it('treats empty arg patterns as tool-name-only matches', () => {
    expect(ruleMatches(permissionRule('Read()'), 'Read', { path: '/workspace/a.ts' })).toBe(true);
    expect(ruleMatches(permissionRule('Custom()'), 'Custom', { anything: 1 })).toBe(true);
    expect(ruleMatches(permissionRule('Read()'), 'Write', { path: '/workspace/a.ts' })).toBe(false);
  });

  it('matches paths case-insensitively so case-only variants cannot bypass rules', () => {
    expect(
      ruleMatches(permissionRule('Edit(/repo/secrets.env)'), 'Edit', { path: '/repo/Secrets.env' }, {
        matchesRule: (ruleArgs) =>
          matchesPathRuleSubject(ruleArgs, '/repo/Secrets.env', {
            cwd: '/repo',
            pathClass: 'posix',
          }),
      }),
    ).toBe(true);
    expect(
      ruleMatches(permissionRule('Edit(/repo/Sub/**)'), 'Edit', { path: '/repo/sub/a.ts' }, {
        matchesRule: (ruleArgs) =>
          matchesPathRuleSubject(ruleArgs, '/repo/sub/a.ts', {
            cwd: '/repo',
            pathClass: 'posix',
          }),
      }),
    ).toBe(true);
  });

  it('delegates rule argument semantics to execution.matchesRule when available', () => {
    const execution = {
      matchesRule: vi.fn((ruleArgs: string) => ruleArgs === 'semantic match'),
    };

    expect(
      ruleMatches(permissionRule('Read(semantic match)'), 'Read', { path: '/workspace/a.ts' }, execution),
    ).toBe(true);
    expect(execution.matchesRule).toHaveBeenCalledWith('semantic match');
    expect(
      ruleMatches(permissionRule('Read(other)'), 'Read', { path: '/workspace/a.ts' }, execution),
    ).toBe(false);
  });

});

function bashCall(): ToolCall {
  return {
    type: 'function',
    id: 'call_bash',
    name: 'Bash',
    arguments: '{"command":"printf permission-output","timeout":60}',
  };
}

function makePermissionManager(
  handleApproval: (request: unknown) => Promise<ApprovalResponse>,
  options: {
    readonly parent?: PermissionManager | undefined;
    readonly planModeActive?: boolean;
    readonly planFilePath?: string | null | undefined;
    readonly kaos?: Kaos;
    readonly cwd?: string;
    readonly agentType?: Agent['type'];
    readonly hooks?: Agent['hooks'];
  } = {},
): {
  manager: PermissionManager;
  record: ReturnType<typeof vi.fn>;
  requestApproval: ReturnType<typeof vi.fn>;
  telemetryTrack: ReturnType<typeof vi.fn>;
} {
  let manager!: PermissionManager;
  const requestApproval = vi.fn(handleApproval);
  const record = vi.fn();
  const telemetryTrack = vi.fn();
  const agent = {
    type: options.agentType ?? 'main',
    config: { cwd: options.cwd ?? '/workspace' },
    runtime: { kaos: options.kaos ?? createFakeKaos() },
    emitStatusUpdated: vi.fn(),
    records: { logRecord: record },
    replayBuilder: { push: vi.fn() },
    rpc: { requestApproval },
    hooks: options.hooks,
    telemetry: { track: telemetryTrack },
    planMode: {
      get isActive() {
        return options.planModeActive ?? false;
      },
      get planFilePath() {
        return options.planFilePath ?? null;
      },
      data: vi.fn(async () => null),
      exit: vi.fn(),
    },
  } as unknown as Agent;
  manager = new PermissionManager(agent, options);
  Object.assign(agent, { permission: manager });
  return { manager, record, requestApproval, telemetryTrack };
}

function makePlanPermissionManager(input: {
  readonly mode: PermissionMode;
  readonly plan?: string | null | undefined;
  readonly path?: string | undefined;
  readonly approval?: ApprovalResponse | undefined;
  readonly approvalError?: Error | undefined;
}): {
  manager: PermissionManager;
  record: ReturnType<typeof vi.fn>;
  requestApproval: ReturnType<typeof vi.fn>;
  exit: ReturnType<typeof vi.fn>;
  telemetryTrack: ReturnType<typeof vi.fn>;
} {
  const requestApproval = vi.fn(async () => {
    if (input.approvalError !== undefined) throw input.approvalError;
    return input.approval ?? { decision: 'approved' };
  });
  const record = vi.fn();
  const exit = vi.fn();
  const telemetryTrack = vi.fn();
  const path = input.path ?? '/tmp/plan.md';
  const agent = {
    type: 'main',
    config: { cwd: '/workspace' },
    runtime: { kaos: createFakeKaos() },
    emitStatusUpdated: vi.fn(),
    records: { logRecord: record },
    replayBuilder: { push: vi.fn() },
    rpc: { requestApproval },
    log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
    telemetry: { track: telemetryTrack },
    planMode: {
      get isActive() {
        return true;
      },
      get planFilePath() {
        return path;
      },
      data: vi.fn(async () => {
        if (input.plan === null) return null;
        return {
          content: input.plan ?? '# Plan',
          path,
        };
      }),
      exit,
    },
  } as unknown as Agent;
  const manager = new PermissionManager(agent);
  Object.assign(agent, { permission: manager });
  manager.mode = input.mode;
  return { manager, record, requestApproval, exit, telemetryTrack };
}

function hookContext(input: {
  readonly id: string;
  readonly toolName?: string | undefined;
  readonly args?: Record<string, unknown> | undefined;
  readonly execution?: PermissionPolicyContext['execution'] | undefined;
}): PermissionPolicyContext {
  const toolName = input.toolName ?? 'Bash';
  const args = input.args ?? { command: 'printf first', timeout: 60 };
  const toolCall: ToolCall = {
    type: 'function',
    id: input.id,
    name: toolName,
      arguments: JSON.stringify(args),
  };
  return {
    turnId: '0',
    stepNumber: 1,
    signal: new AbortController().signal,
    llm: {} as PermissionPolicyContext['llm'],
    toolCall,
    args,
    execution: input.execution ?? testExecution(toolName, args),
  };
}

function permissionRule(
  pattern: string,
  decision: PermissionRule['decision'] = 'allow',
): PermissionRule {
  return {
    decision,
    scope: 'turn-override',
    pattern,
  };
}

function ruleMatches(
  rule: PermissionRule,
  toolName: string,
  args: unknown,
  execution: PermissionRuleMatchExecution = {},
): boolean {
  void args;
  return matchPermissionRule({ rule, toolName, execution }) !== undefined;
}

function genericDisplay(): ToolInputDisplay {
  return { kind: 'generic', summary: 'Approve tool', detail: {} };
}

function planReviewExecution(input: {
  readonly plan: string;
  readonly path?: string | undefined;
  readonly options?: readonly { readonly label: string; readonly description: string }[] | undefined;
}): PermissionPolicyContext['execution'] {
  return {
    description: 'Presenting plan and exiting plan mode',
    display: {
      kind: 'plan_review',
      plan: input.plan,
      path: input.path,
      options: input.options,
    },
    accesses: ToolAccesses.none(),
    approvalRule: 'ExitPlanMode',
    execute: async () => ({ output: '' }),
  };
}

function testExecution(
  toolName: string,
  args: Record<string, unknown>,
): PermissionPolicyContext['execution'] {
  const ruleSubject = testRuleSubject(toolName, args);
  return {
    description: testDescription(toolName, args),
    display: testDisplay(toolName, args),
    accesses: testAccesses(toolName, args),
    approvalRule: ruleSubject === undefined ? toolName : literalRulePattern(toolName, ruleSubject),
    matchesRule:
      ruleSubject === undefined
        ? undefined
        : (ruleArgs) => testMatchesRuleSubject(toolName, ruleArgs, ruleSubject),
    execute: async () => ({ output: '' }),
  };
}

function testRuleSubject(toolName: string, args: Record<string, unknown>): string | undefined {
  switch (toolName) {
    case 'Bash':
      return stringArg(args, 'command');
    case 'Read':
    case 'ReadMediaFile':
    case 'Write':
    case 'Edit':
      return canonicalTestPath(stringArg(args, 'path', '/workspace/file.txt'));
    case 'Grep':
    case 'Glob':
      return stringArg(args, 'pattern');
    default:
      return undefined;
  }
}

function testMatchesRuleSubject(
  toolName: string,
  ruleArgs: string,
  ruleSubject: string,
): boolean {
  switch (toolName) {
    case 'Read':
    case 'ReadMediaFile':
    case 'Write':
    case 'Edit':
      return matchesPathRuleSubject(ruleArgs, ruleSubject);
    default:
      return matchesGlobRuleSubject(ruleArgs, ruleSubject);
  }
}

function testDescription(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'Bash':
      return 'run command';
    case 'ExitPlanMode':
      return 'review plan';
    case 'Read':
      return 'read file';
    case 'ReadMediaFile':
      return 'read media file';
    case 'Write':
      return 'write file';
    case 'Edit':
      return 'edit file';
    case 'Grep':
      return `Searching for '${stringArg(args, 'pattern')}' in ${stringArg(args, 'path', '/workspace')}`;
    case 'Glob':
      return `Searching ${stringArg(args, 'pattern')}`;
    default:
      return `call ${toolName}`;
  }
}

function stringArg(args: Record<string, unknown>, key: string, fallback = ''): string {
  const value = args[key];
  return typeof value === 'string' ? value : fallback;
}

function testDisplay(toolName: string, args: Record<string, unknown>): ToolInputDisplay {
  const path = typeof args['path'] === 'string' ? args['path'] : '/workspace/file.txt';
  switch (toolName) {
    case 'Bash':
      return {
        kind: 'command',
        command: typeof args['command'] === 'string' ? args['command'] : '',
      };
    case 'Read':
    case 'ReadMediaFile':
      return { kind: 'file_io', operation: 'read', path };
    case 'Write':
      return { kind: 'file_io', operation: 'write', path };
    case 'Edit':
      return { kind: 'file_io', operation: 'edit', path };
    case 'Grep':
      return { kind: 'file_io', operation: 'grep', path };
    case 'Glob':
      return { kind: 'file_io', operation: 'glob', path };
    default:
      return genericDisplay();
  }
}

function testAccesses(toolName: string, args: Record<string, unknown>) {
  const path = typeof args['path'] === 'string' ? canonicalTestPath(args['path']) : undefined;
  if (toolName === 'Read' && path !== undefined) return ToolAccesses.readFile(path);
  if (toolName === 'ReadMediaFile' && path !== undefined) return ToolAccesses.readFile(path);
  if (toolName === 'Write' && path !== undefined) return ToolAccesses.writeFile(path);
  if (toolName === 'Edit' && path !== undefined) return ToolAccesses.readWriteFile(path);
  if ((toolName === 'Grep' || toolName === 'Glob') && path !== undefined) {
    return ToolAccesses.searchTree(path);
  }
  return ToolAccesses.none();
}

function canonicalTestPath(path: string): string {
  return posixPath.isAbsolute(path) ? posixPath.normalize(path) : posixPath.resolve('/workspace', path);
}
