import type { Kaos } from '@moonshot-ai/kaos';
import type { ToolCall } from '@moonshot-ai/kosong';
import { describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../src/agent';
import { PermissionModeInjector } from '../../src/agent/injection/permission-mode';
import {
  PermissionManager,
  type ApprovalResponse,
  type PermissionMode,
  type PermissionRule,
} from '../../src/agent/permission';
import {
  actionToRulePattern,
  describeApprovalAction,
} from '../../src/agent/permission/action-label';
import { checkMatchingRules } from '../../src/agent/permission/check-rules';
import { matchesRule } from '../../src/agent/permission/matches-rule';
import { parsePattern } from '../../src/agent/permission/parse-pattern';
import { createPlanPermissionPolicies } from '../../src/agent/permission/policies/plan';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '../../src/agent/permission/policy';
import type { ToolExecutionHookContext } from '../../src/loop';
import type { ToolInputDisplay } from '../../src/tools/display';
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
      [wire] context.append_loop_event   { "event": { "type": "tool.call", "uuid": "call_bash", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf permission-output", "timeout": 60 }, "description": "Running: printf permission-output" }, "time": "<time>" }
      [emit] tool.call.started           { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf permission-output", "timeout": 60 }, "description": "Running: printf permission-output" }
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
      [wire] context.append_loop_event   { "event": { "type": "tool.call", "uuid": "call_bash", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf permission-output", "timeout": 60 }, "description": "Running: printf permission-output" }, "time": "<time>" }
      [emit] tool.call.started           { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf permission-output", "timeout": 60 }, "description": "Running: printf permission-output" }
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
      function: {
        name: 'Bash',
        arguments: '{"command":"printf should-not-run","timeout":60}',
      },
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
      [emit] requestApproval             { "turnId": 0, "toolCallId": "call_bash", "toolName": "Bash", "action": "run command", "display": { "kind": "generic", "summary": "Approve Bash", "detail": { "command": "printf should-not-run", "timeout": 60 } } }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: Bash
      messages:
        user: text "Try to run Bash"
    `);

    ctx.mockNextResponse({ type: 'text', text: 'I will not run the command.' });
    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] permission.record_approval_result   { "turnId": 0, "toolCallId": "call_bash", "toolName": "Bash", "action": "run command", "result": { "decision": "rejected", "selectedLabel": "reject" }, "time": "<time>" }
      [wire] context.append_loop_event           { "event": { "type": "tool.call", "uuid": "call_bash", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf should-not-run", "timeout": 60 } }, "time": "<time>" }
      [emit] tool.call.started                   { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf should-not-run", "timeout": 60 } }
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
    ['auto', 'afk'],
    ['yolo', 'yolo'],
  ] as const)('tracks %s mode bypass as approval_mode=%s', async (mode, approvalMode) => {
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(async () => ({
      decision: 'approved',
    }));
    manager.setMode(mode);

    await expect(manager.beforeToolCall(hookContext({ id: 'call_1' }))).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    expect(telemetryTrack).toHaveBeenCalledWith('tool_approved', {
      tool_name: 'Bash',
      approval_mode: approvalMode,
    });
  });

  it('tracks plan-mode Bash bypass in auto mode as approval_mode=afk', async () => {
    const { manager, requestApproval, telemetryTrack } = makePermissionManager(
      async () => ({
        decision: 'approved',
      }),
      { planModeActive: true },
    );
    manager.setMode('auto');

    await expect(manager.beforeToolCall(hookContext({ id: 'call_plan_bash' }))).resolves.toBeUndefined();

    expect(requestApproval).not.toHaveBeenCalled();
    expect(telemetryTrack).toHaveBeenCalledWith('tool_approved', {
      tool_name: 'Bash',
      approval_mode: 'afk',
    });
  });

  it.each(['auto', 'yolo'] as const)(
    'does not track approval for default-allowed tools in %s mode',
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
      expect(telemetryTrack).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['Read', { path: '/tmp/notes.md' }, 'read'],
    ['ReadMediaFile', { path: '/tmp/image.png' }, 'read'],
    ['Write', { path: '/tmp/notes.md', content: 'x' }, 'write'],
    ['Edit', { path: '/tmp/notes.md', old_string: 'a', new_string: 'b' }, 'edit'],
    ['Grep', { pattern: 'TODO', path: '/tmp' }, 'grep'],
  ] as const)(
    'requests approval for %s outside the workspace in yolo mode',
    async (toolName, args, operation) => {
      const { manager, requestApproval } = makePermissionManager(async () => ({
        decision: 'approved',
      }));
      manager.setMode('yolo');

      await expect(
        manager.beforeToolCall(hookContext({ id: `call_${toolName}`, toolName, args })),
      ).resolves.toBeUndefined();

      expect(requestApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName,
          display: {
            kind: 'file_io',
            operation,
            path: args.path,
            detail: 'Outside workspace: /workspace',
          },
        }),
        expect.any(Object),
      );
    },
  );

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

  it.each(['manual', 'auto'] as const)(
    'does not apply the outside-workspace yolo policy in %s mode',
    async (mode) => {
      const { manager, requestApproval } = makePermissionManager(async () => ({
        decision: 'approved',
      }));
      manager.setMode(mode);

      await expect(
        manager.beforeToolCall(
          hookContext({
            id: `call_read_${mode}`,
            toolName: 'Read',
            args: { path: '/tmp/notes.md' },
          }),
        ),
      ).resolves.toBeUndefined();

      expect(requestApproval).not.toHaveBeenCalled();
    },
  );

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

  it('reuses approve-for-session for repeated outside-workspace reads in yolo mode', async () => {
    const { manager, requestApproval } = makePermissionManager(async () => ({
      decision: 'approved',
      scope: 'session',
      selectedLabel: 'Approve for this session',
    }));
    manager.setMode('yolo');
    const call = () =>
      manager.beforeToolCall(
        hookContext({
          id: 'call_read_session',
          toolName: 'Read',
          args: { path: '/tmp/notes.md' },
        }),
      );

    await expect(call()).resolves.toBeUndefined();
    await expect(call()).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(manager.data().rules).toContainEqual({
      decision: 'allow',
      scope: 'session-runtime',
      pattern: 'Read',
      reason: 'approve_for_session: read file',
    });
  });
});

describe('Permission policy chain', () => {
  it('keeps plan-specific policies under the permission module plan namespace', () => {
    expect(createPlanPermissionPolicies({} as Agent).map((policy) => policy.name)).toEqual([
      'plan.enter-plan-mode',
      'plan.exit-plan-mode',
      'plan.mode-guard',
    ]);
  });

  it('runs custom policies after deny rules and before generic approval', async () => {
    const policy: PermissionPolicy = {
      name: 'test.block-bash',
      evaluate: vi.fn(async (): Promise<PermissionPolicyResult> => ({
        kind: 'result',
        block: true,
        reason: 'blocked by custom policy',
      })),
    };
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { policies: [policy] },
    );

    await expect(manager.beforeToolCall(hookContext({ id: 'call_policy' }))).resolves.toEqual({
      block: true,
      reason: 'blocked by custom policy',
    });
    expect(policy.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCall: expect.objectContaining({ id: 'call_policy' }),
        matchedRule: undefined,
      }),
    );
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('keeps explicit deny rules higher priority than custom policies', async () => {
    const policy: PermissionPolicy = {
      name: 'test.allow-bash',
      evaluate: vi.fn(async (): Promise<PermissionPolicyResult> => ({ kind: 'allow' })),
    };
    const { manager, requestApproval } = makePermissionManager(
      async () => ({ decision: 'approved' }),
      { policies: [policy] },
    );
    manager.rules.push({
      decision: 'deny',
      scope: 'user',
      pattern: 'Bash',
      reason: 'blocked before policy',
    });

    await expect(manager.beforeToolCall(hookContext({ id: 'call_deny' }))).resolves.toMatchObject({
      block: true,
      reason: 'Tool "Bash" was denied by permission rule. Reason: blocked before policy',
    });
    expect(policy.evaluate).not.toHaveBeenCalled();
    expect(requestApproval).not.toHaveBeenCalled();
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

  it('uses child matching rules before parent rules', async () => {
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

    await expect(child.manager.beforeToolCall(hookContext({ id: 'call_allow' }))).resolves
      .toBeUndefined();
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

  it('falls back to parent rules and session approvals when no child rule matches', async () => {
    const parent = makePermissionManager(async () => ({ decision: 'approved' }));
    parent.manager.recordApprovalResult({
      turnId: 0,
      toolCallId: 'call_parent',
      toolName: 'Bash',
      action: 'run command',
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
    expect(child.manager.data().rules).toContainEqual(sessionAllowRule());
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
          kind: 'generic',
          summary: 'Approve Bash',
          detail: { command: 'ls -la', timeout: 60 },
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
    expect(manager.data().rules).toContainEqual(sessionAllowRule());
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

  it('requests plan-review approval in yolo mode and returns selected option metadata', async () => {
    const { manager, record, requestApproval } = makePlanPermissionManager({
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
      }),
    );

    expect(requestApproval).toHaveBeenCalledWith(
      {
        turnId: 0,
        toolCallId: 'call_exit',
        toolName: 'ExitPlanMode',
        action: 'Review plan and choose an option',
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
      action: 'Review plan and choose an option',
      result: { decision: 'approved', selectedLabel: 'Approach B' },
    });
    expect(result).toMatchObject({
      executionMetadata: {
        selectedOption: planOptions[1],
      },
    });
  });

  it('returns a synthetic stop-turn result when the user rejects the plan', async () => {
    const { manager, exit } = makePlanPermissionManager({
      mode: 'manual',
      plan: '# Draft Plan',
      approval: { decision: 'rejected', selectedLabel: 'Reject' },
    });

    const result = await manager.beforeToolCall(
      hookContext({ id: 'call_exit', toolName: 'ExitPlanMode', args: {} }),
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
      hookContext({ id: 'call_exit', toolName: 'ExitPlanMode', args: {} }),
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

    const result = await manager.beforeToolCall(
      hookContext({ id: 'call_exit', toolName: 'ExitPlanMode', args: {} }),
    );

    expect(exit).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      syntheticResult: {
        isError: true,
        output: 'Plan approval failed: approval transport closed',
      },
    });
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
      hookContext({ id: 'call_exit', toolName: 'ExitPlanMode', args: {} }),
    );

    expect(exit).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      syntheticResult: {
        isError: false,
        output: expect.stringContaining('Add verification.'),
      },
    });
  });
});

describe('Agent-local approve for session', () => {
  it('turns approved session-scoped responses into an agent-local allow cache', async () => {
    const { manager, record, requestApproval, telemetryTrack } = makePermissionManager(async () => ({
      decision: 'approved',
      scope: 'session',
      selectedLabel: 'Approve for this session',
    }));

    await expect(manager.beforeToolCall(hookContext({ id: 'call_1' }))).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(telemetryTrack).toHaveBeenNthCalledWith(1, 'tool_approved', {
      tool_name: 'Bash',
      approval_mode: 'manual',
      scope: 'session',
    });
    expect(record).toHaveBeenCalledWith({
      type: 'permission.record_approval_result',
      turnId: 0,
      toolCallId: 'call_1',
      toolName: 'Bash',
      action: 'run command',
      result: {
        decision: 'approved',
        scope: 'session',
        selectedLabel: 'Approve for this session',
      },
    });
    expect(manager.data().rules).toContainEqual({
      decision: 'allow',
      scope: 'session-runtime',
      pattern: 'Bash',
      reason: 'approve_for_session: run command',
    });

    await expect(
      manager.beforeToolCall(
        hookContext({
          id: 'call_2',
          args: { command: 'printf second', timeout: 60 },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(telemetryTrack).toHaveBeenNthCalledWith(2, 'tool_approved', {
      tool_name: 'Bash',
      approval_mode: 'auto_session',
      scope: 'session',
    });
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

  it('replays session approval wire events into agent permission state', () => {
    const ctx = testAgent();
    const rule = sessionAllowRule();

    ctx.dispatch({
      type: 'permission.record_approval_result',
      turnId: 0,
      toolCallId: 'call_replay',
      toolName: 'Bash',
      action: 'run command',
      result: {
        decision: 'approved',
        scope: 'session',
        selectedLabel: 'Approve for this session',
      },
    });

    expect(ctx.agent.permission.data().rules).toContainEqual(rule);
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
  it('tracks cancelled approval requests with approval_mode=cancelled', async () => {
    const { manager, telemetryTrack } = makePermissionManager(async () => ({
      decision: 'cancelled',
      feedback: 'request closed',
    }));

    await expect(manager.beforeToolCall(hookContext({ id: 'call_1' }))).resolves.toMatchObject({
      block: true,
      reason: expect.stringContaining('approval request was cancelled'),
    });

    expect(telemetryTrack).toHaveBeenCalledWith('tool_rejected', {
      tool_name: 'Bash',
      approval_mode: 'cancelled',
      decision: 'cancelled',
      has_feedback: true,
    });
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

  function writeHook(args: Record<string, unknown>, id = 'call_write'): ToolExecutionHookContext {
    return hookContext({ id, toolName: 'Write', args });
  }

  function editHook(args: Record<string, unknown>, id = 'call_edit'): ToolExecutionHookContext {
    return hookContext({ id, toolName: 'Edit', args });
  }

  it('still requests approval for Bash inside a git cwd in manual mode', async () => {
    const { kaos } = gitKaos();
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
      'tool_approved',
      expect.objectContaining({ auto_reason: 'default_git_cwd_write' }),
    );
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
    expect(telemetryTrack).toHaveBeenCalledWith('tool_approved', {
      tool_name: 'Write',
      approval_mode: 'manual',
      auto_reason: 'default_git_cwd_write',
    });
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
    expect(telemetryTrack).toHaveBeenCalledWith('tool_approved', {
      tool_name: 'Edit',
      approval_mode: 'manual',
      auto_reason: 'default_git_cwd_write',
    });
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
      'tool_approved',
      expect.objectContaining({ auto_reason: 'default_git_cwd_write' }),
    );
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
      'tool_approved',
      expect.objectContaining({ auto_reason: 'default_git_cwd_write' }),
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
        'tool_approved',
        expect.objectContaining({ auto_reason: 'default_git_cwd_write' }),
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
      'tool_approved',
      expect.objectContaining({ auto_reason: 'default_git_cwd_write' }),
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
      'tool_approved',
      expect.objectContaining({ auto_reason: 'default_git_cwd_write' }),
    );
  });

  it('still requests approval when a parent path segment is a symlink', async () => {
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

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(telemetryTrack).not.toHaveBeenCalledWith(
      'tool_approved',
      expect.objectContaining({ auto_reason: 'default_git_cwd_write' }),
    );
  });

  it('still requests approval when the target file is a symlink', async () => {
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

    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(telemetryTrack).not.toHaveBeenCalledWith(
      'tool_approved',
      expect.objectContaining({ auto_reason: 'default_git_cwd_write' }),
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

  it.each(['.ENV', '.Aws/credentials'])(
    'still requests approval for case-variant sensitive file %s',
    async (path) => {
      const { kaos } = gitKaos({
        statModes: path.includes('/') ? { '/workspace/.Aws': DIR_MODE } : {},
      });
      const { manager, requestApproval, telemetryTrack } = makePermissionManager(
        async () => ({ decision: 'approved' }),
        { kaos },
      );

      await expect(manager.beforeToolCall(writeHook({ path, content: 'secret' }))).resolves
        .toBeUndefined();

      expect(requestApproval).toHaveBeenCalledTimes(1);
      expect(telemetryTrack).not.toHaveBeenCalledWith(
        'tool_approved',
        expect.objectContaining({ auto_reason: 'default_git_cwd_write' }),
      );
    },
  );

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
    expect(telemetryTrack).toHaveBeenCalledWith('tool_approved', {
      tool_name: 'Write',
      approval_mode: 'manual',
      auto_reason: 'default_git_cwd_write',
    });
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
      'tool_approved',
      expect.objectContaining({ auto_reason: 'default_git_cwd_write' }),
    );
  });

  it('lets an explicit `allow` rule take the original allow path without auto_reason telemetry', async () => {
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
      'tool_approved',
      expect.objectContaining({ auto_reason: 'default_git_cwd_write' }),
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
      'tool_approved',
      expect.objectContaining({ auto_reason: 'default_git_cwd_write' }),
    );
  });

  it('does not fire in auto mode — existing afk telemetry path takes over', async () => {
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
    expect(telemetryTrack).toHaveBeenCalledWith('tool_approved', {
      tool_name: 'Write',
      approval_mode: 'afk',
    });
    expect(telemetryTrack).not.toHaveBeenCalledWith(
      'tool_approved',
      expect.objectContaining({ auto_reason: 'default_git_cwd_write' }),
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
      'tool_approved',
      expect.objectContaining({ auto_reason: 'default_git_cwd_write' }),
    );
  });

  it('caches the git marker check across repeated Write/Edit calls in the same cwd', async () => {
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
    expect(markerCalls).toHaveLength(1);
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
    expect(matchesRule(permissionRule('Bash(git *)'), 'Bash', { command: 'git status' })).toBe(
      true,
    );
    expect(matchesRule(permissionRule('Bash(git *)'), 'Bash', { command: 'npm test' })).toBe(false);
    expect(matchesRule(permissionRule('Read(/etc/**)'), 'Read', { path: '/etc/passwd' })).toBe(
      true,
    );
    expect(
      matchesRule(permissionRule('Edit(!./src/**)', 'deny'), 'Edit', { path: './tests/foo.ts' }),
    ).toBe(true);
    expect(
      matchesRule(permissionRule('Edit(!./src/**)', 'deny'), 'Edit', { path: './src/foo.ts' }),
    ).toBe(false);
    expect(
      matchesRule(permissionRule('Agent(review-*)'), 'Agent', { subagent_type: 'review-code' }),
    ).toBe(true);
    expect(matchesRule(permissionRule('mcp__github__*'), 'mcp__github__list_issues', {})).toBe(
      true,
    );
    expect(matchesRule(permissionRule('Bash(git *)'), 'Bash', { command: 42 })).toBe(false);
    expect(matchesRule(permissionRule('Bad(unclosed'), 'Bad', {})).toBe(false);
  });

  it('matches path rules against lexical variants of the same absolute file', () => {
    const secret = '/workspace/project/secret.txt';
    const rule = permissionRule(`Read(${secret})`, 'deny');

    expect(matchesRule(rule, 'Read', { path: secret })).toBe(true);
    expect(matchesRule(rule, 'Read', { path: '/workspace/project/./secret.txt' })).toBe(true);
    expect(matchesRule(rule, 'Read', { path: '/workspace/project/tmp/../secret.txt' })).toBe(true);
    expect(matchesRule(rule, 'Read', { path: '/workspace/project/SECRET.txt' })).toBe(true);
    expect(
      matchesRule(permissionRule(`Read(${secret})`, 'allow'), 'Read', {
        path: '/workspace/project/SECRET.txt',
      }),
    ).toBe(false);
  });

  it('matches path rules against relative tool paths using the active cwd', () => {
    expect(
      checkMatchingRules(
        [permissionRule('Read(/workspace/project/secret.txt)', 'deny')],
        'Read',
        { path: './secret.txt' },
        'manual',
        { cwd: '/workspace/project', pathClass: 'posix' },
      ),
    ).toMatchObject({ decision: 'deny' });
  });

  it('matches win32 path rules across separators, dot segments, and case variants', () => {
    const secret = 'C:\\workspace\\project\\secret.txt';
    const denyRule = permissionRule(`Read(${secret})`, 'deny');
    const allowRule = permissionRule(`Read(${secret})`, 'allow');
    const context = { pathClass: 'win32' as const };

    expect(
      matchesRule(denyRule, 'Read', { path: 'C:\\workspace\\project\\.\\secret.txt' }, context),
    ).toBe(true);
    expect(
      matchesRule(
        denyRule,
        'Read',
        { path: 'C:\\workspace\\project\\tmp\\..\\SECRET.txt' },
        context,
      ),
    ).toBe(true);
    expect(
      matchesRule(denyRule, 'Read', { path: 'C:/workspace/project/secret.txt' }, context),
    ).toBe(true);
    expect(
      matchesRule(denyRule, 'Read', { path: 'C:/workspace\\project/tmp\\..\\SECRET.txt' }, context),
    ).toBe(true);
    expect(
      matchesRule(allowRule, 'Read', { path: 'C:\\workspace\\project\\SECRET.txt' }, context),
    ).toBe(true);
  });

  it('matches win32 path rules against relative tool paths using the active cwd', () => {
    expect(
      checkMatchingRules(
        [permissionRule('Read(C:\\workspace\\project\\secret.txt)', 'deny')],
        'Read',
        { path: '.\\SECRET.txt' },
        'manual',
        { cwd: 'C:\\workspace\\project', pathClass: 'win32' },
      ),
    ).toMatchObject({ decision: 'deny' });
  });

  it('applies explicit rule priority and mode overlay in order', () => {
    expect(checkMatchingRules([], 'Write', { path: '/tmp/a' }, 'manual')).toBeUndefined();
    expect(
      checkMatchingRules(
        [permissionRule('Write', 'allow')],
        'Write',
        { path: '/tmp/a' },
        'manual',
      ),
    ).toMatchObject({
      decision: 'allow',
    });
    expect(
      checkMatchingRules(
        [permissionRule('Write', 'allow'), permissionRule('Write', 'ask')],
        'Write',
        {},
        'manual',
      ),
    ).toMatchObject({ decision: 'ask' });
    expect(
      checkMatchingRules(
        [permissionRule('Write', 'allow'), permissionRule('Write', 'deny')],
        'Write',
        {},
        'manual',
      ),
    ).toMatchObject({ decision: 'deny' });
    expect(
      checkMatchingRules([permissionRule('Write', 'ask')], 'Write', { path: '/tmp/a' }, 'yolo'),
    ).toMatchObject({
      decision: 'allow',
    });
    expect(
      checkMatchingRules([permissionRule('Write', 'deny')], 'Write', { path: '/tmp/a' }, 'yolo'),
    ).toMatchObject({
      decision: 'deny',
    });
  });

  it('derives approval action labels from display semantics and MCP names', () => {
    expect(describeApprovalAction('Bash', {}, { kind: 'command', command: 'git status' })).toBe(
      'run command',
    );
    expect(
      describeApprovalAction('Write', {}, { kind: 'file_io', operation: 'write', path: 'x' }),
    ).toBe('write file');
    expect(
      describeApprovalAction('ExitPlanMode', {}, { kind: 'plan_review', plan: '# Plan' }),
    ).toBe('review plan');
    expect(
      describeApprovalAction(
        'Agent',
        {},
        { kind: 'agent_call', agent_name: 'review', prompt: 'x' },
      ),
    ).toBe('spawn agent');
    expect(describeApprovalAction('Skill', {}, { kind: 'skill_call', skill_name: 'commit' })).toBe(
      'invoke skill',
    );
    expect(describeApprovalAction('mcp__files__get_files', {}, genericDisplay())).toBe(
      'call MCP tool: files:get_files',
    );
    expect(actionToRulePattern('edit file outside of working directory', 'Edit')).toBe('Write');
    expect(actionToRulePattern('run command in plan mode', 'Bash')).toBeUndefined();
    expect(actionToRulePattern('call CustomTool', 'CustomTool')).toBe('CustomTool');
  });
});

function bashCall(): ToolCall {
  return {
    type: 'function',
    id: 'call_bash',
    function: {
      name: 'Bash',
      arguments: '{"command":"printf permission-output","timeout":60}',
    },
  };
}

function makePermissionManager(
  handleApproval: (request: unknown) => Promise<ApprovalResponse>,
  options: {
    readonly policies?: readonly PermissionPolicy[];
    readonly parent?: PermissionManager | undefined;
    readonly planModeActive?: boolean;
    readonly kaos?: Kaos;
    readonly cwd?: string;
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
    type: 'main',
    config: { cwd: options.cwd ?? '/workspace' },
    runtime: { kaos: options.kaos ?? createFakeKaos() },
    emitStatusUpdated: vi.fn(),
    records: { logRecord: record },
    replayBuilder: { push: vi.fn() },
    rpc: { requestApproval },
    telemetry: { track: telemetryTrack },
    planMode: {
      get isActive() {
        return options.planModeActive ?? false;
      },
      get planFilePath() {
        return null;
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
} {
  const requestApproval = vi.fn(async () => {
    if (input.approvalError !== undefined) throw input.approvalError;
    return input.approval ?? { decision: 'approved' };
  });
  const record = vi.fn();
  const exit = vi.fn();
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
    telemetry: { track: vi.fn() },
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
  return { manager, record, requestApproval, exit };
}

function hookContext(input: {
  readonly id: string;
  readonly toolName?: string | undefined;
  readonly args?: Record<string, unknown> | undefined;
}): ToolExecutionHookContext {
  const toolName = input.toolName ?? 'Bash';
  const args = input.args ?? { command: 'printf first', timeout: 60 };
  const toolCall: ToolCall = {
    type: 'function',
    id: input.id,
    function: {
      name: toolName,
      arguments: JSON.stringify(args),
    },
  };
  return {
    turnId: '0',
    stepNumber: 1,
    signal: new AbortController().signal,
    llm: {} as ToolExecutionHookContext['llm'],
    toolCall,
    args,
  };
}

function sessionAllowRule(): PermissionRule {
  return {
    decision: 'allow',
    scope: 'session-runtime',
    pattern: 'Bash',
    reason: 'approve_for_session: run command',
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

function genericDisplay(): ToolInputDisplay {
  return { kind: 'generic', summary: 'Approve tool', detail: {} };
}
