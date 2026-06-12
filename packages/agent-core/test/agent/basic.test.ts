import type { ToolCall } from '@moonshot-ai/kosong';
import { expect, it } from 'vitest';

import { FLAG_DEFINITIONS, FlagResolver } from '../../src/flags';
import { createCommandKaos, testAgent } from './harness/agent';

it('creates an independent agent with a scoped experimental flag resolver', () => {
  const ctx = testAgent({
    experimentalFlags: new FlagResolver({}, FLAG_DEFINITIONS),
  });

  expect(ctx.agent.experimentalFlags.enabled('micro_compaction')).toBe(true);
});

it('runs a text-only agent turn from prompt to completion', async () => {
  const ctx = testAgent();
  ctx.configure();

  ctx.mockNextResponse({ type: 'think', think: '<think-1>' }, { type: 'text', text: '<text-1>' });
  await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });

  expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
    [wire] turn.prompt                 { "input": [ { "type": "text", "text": "Hello" } ], "origin": { "kind": "user" }, "time": "<time>" }
    [emit] turn.started                { "turnId": 0, "origin": { "kind": "user" } }
    [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Hello" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
    [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
    [emit] turn.step.started           { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
    [emit] thinking.delta              { "turnId": 0, "delta": "<think-1>" }
    [emit] assistant.delta             { "turnId": 0, "delta": "<text-1>" }
    [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "think", "think": "<think-1>" } }, "time": "<time>" }
    [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-3>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "<text-1>" } }, "time": "<time>" }
    [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-1>", "turnId": "0", "step": 1, "usage": { "inputOther": 3, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }, "time": "<time>" }
    [emit] turn.step.completed         { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 3, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }
    [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 3, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
    [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 11, "maxContextTokens": 1000000, "contextUsage": 0.000011, "planMode": false, "swarmMode": false, "permission": "manual", "usage": { "byModel": { "mock-model": { "inputOther": 3, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 3, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 3, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
    [emit] turn.ended                  { "turnId": 0, "reason": "completed" }
  `);
  expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
    system: <system-prompt>
    tools: []
    messages:
      user: text "Hello"
  `);
  await ctx.expectResumeMatches();
});

it('forwards provider finish diagnostics on filtered steps', async () => {
  const ctx = testAgent();
  ctx.configure();

  ctx.mockNextProviderResponse({
    parts: [{ type: 'text', text: 'blocked' }],
    finishReason: 'filtered',
    rawFinishReason: 'content_filter',
  });
  await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });

  await ctx.untilTurnEnd();

  const wireStepEnd = ctx.allEvents.find(
    (event) =>
      event.type === '[wire]' &&
      event.event === 'context.append_loop_event' &&
      (event.args as { event?: { type?: string } }).event?.type === 'step.end',
  );
  const rpcStepEnd = ctx.allEvents.find(
    (event) => event.type === '[rpc]' && event.event === 'turn.step.completed',
  );

  expect(wireStepEnd?.args).toMatchObject({
    event: {
      finishReason: 'filtered',
      providerFinishReason: 'filtered',
      rawFinishReason: 'content_filter',
    },
  });
  expect(rpcStepEnd?.args).toMatchObject({
    finishReason: 'filtered',
    providerFinishReason: 'filtered',
    rawFinishReason: 'content_filter',
  });
  await ctx.expectResumeMatches();
});

it('runs an agent turn through builtin tool approval and execution', async () => {
  const bashCall: ToolCall = {
    type: 'function',
    id: 'call_bash',
    name: 'Bash',
    arguments: '{"command":"printf lookup-result","timeout":60}',
  };
  const ctx = testAgent({ kaos: createCommandKaos('lookup-result') });
  ctx.configure({ tools: ['Bash'] });

  ctx.mockNextResponse({ type: 'text', text: 'I will run that.' }, bashCall);
  await ctx.rpc.prompt({
    input: [{ type: 'text', text: 'Run a command that prints lookup-result' }],
  });
  expect(await ctx.untilApproval(true)).toMatchInlineSnapshot(`
    [wire] turn.prompt                 { "input": [ { "type": "text", "text": "Run a command that prints lookup-result" } ], "origin": { "kind": "user" }, "time": "<time>" }
    [emit] turn.started                { "turnId": 0, "origin": { "kind": "user" } }
    [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Run a command that prints lookup-result" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
    [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
    [emit] turn.step.started           { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
    [emit] assistant.delta             { "turnId": 0, "delta": "I will run that." }
    [emit] tool.call.delta             { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "argumentsPart": "{\\"command\\":\\"printf lookup-result\\",\\"timeout\\":60}" }
    [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "I will run that." } }, "time": "<time>" }
    [emit] requestApproval             { "turnId": 0, "toolCallId": "call_bash", "toolName": "Bash", "action": "Running: printf lookup-result", "display": { "kind": "command", "command": "printf lookup-result", "cwd": "<cwd>", "language": "bash" } }
  `);
  expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
    system: <system-prompt>
    tools: Bash
    messages:
      user: text "Run a command that prints lookup-result"
  `);

  ctx.mockNextResponse({ type: 'text', text: 'The command printed lookup-result.' });
  expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
    [wire] permission.record_approval_result   { "turnId": 0, "toolCallId": "call_bash", "toolName": "Bash", "action": "Running: printf lookup-result", "result": { "decision": "approved", "selectedLabel": "approve" }, "time": "<time>" }
    [wire] context.append_loop_event           { "event": { "type": "tool.call", "uuid": "call_bash", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf lookup-result", "timeout": 60 }, "description": "Running: printf lookup-result", "display": { "kind": "command", "command": "printf lookup-result", "cwd": "<cwd>", "language": "bash" } }, "time": "<time>" }
    [emit] tool.call.started                   { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf lookup-result", "timeout": 60 }, "description": "Running: printf lookup-result", "display": { "kind": "command", "command": "printf lookup-result", "cwd": "<cwd>", "language": "bash" } }
    [emit] tool.progress                       { "turnId": 0, "toolCallId": "call_bash", "update": { "kind": "stdout", "text": "lookup-result" } }
    [wire] context.append_loop_event           { "event": { "type": "tool.result", "parentUuid": "call_bash", "toolCallId": "call_bash", "result": { "output": "lookup-result" } }, "time": "<time>" }
    [emit] tool.result                         { "turnId": 0, "toolCallId": "call_bash", "output": "lookup-result" }
    [wire] context.append_loop_event           { "event": { "type": "step.end", "uuid": "<uuid-1>", "turnId": "0", "step": 1, "usage": { "inputOther": 11, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use" }, "time": "<time>" }
    [emit] turn.step.completed                 { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 11, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use" }
    [wire] usage.record                        { "model": "mock-model", "usage": { "inputOther": 11, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
    [emit] agent.status.updated                { "model": "mock-model", "contextTokens": 33, "maxContextTokens": 1000000, "contextUsage": 0.000033, "planMode": false, "swarmMode": false, "permission": "manual", "usage": { "byModel": { "mock-model": { "inputOther": 11, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 11, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 11, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
    [wire] context.append_loop_event           { "event": { "type": "step.begin", "uuid": "<uuid-3>", "turnId": "0", "step": 2 }, "time": "<time>" }
    [emit] turn.step.started                   { "turnId": 0, "step": 2, "stepId": "<uuid-3>" }
    [emit] assistant.delta                     { "turnId": 0, "delta": "The command printed lookup-result." }
    [wire] context.append_loop_event           { "event": { "type": "content.part", "uuid": "<uuid-4>", "turnId": "0", "step": 2, "stepUuid": "<uuid-3>", "part": { "type": "text", "text": "The command printed lookup-result." } }, "time": "<time>" }
    [wire] context.append_loop_event           { "event": { "type": "step.end", "uuid": "<uuid-3>", "turnId": "0", "step": 2, "usage": { "inputOther": 38, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }, "time": "<time>" }
    [emit] turn.step.completed                 { "turnId": 0, "step": 2, "stepId": "<uuid-3>", "usage": { "inputOther": 38, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }
    [wire] usage.record                        { "model": "mock-model", "usage": { "inputOther": 38, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
    [emit] agent.status.updated                { "model": "mock-model", "contextTokens": 50, "maxContextTokens": 1000000, "contextUsage": 0.00005, "planMode": false, "swarmMode": false, "permission": "manual", "usage": { "byModel": { "mock-model": { "inputOther": 49, "output": 34, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 49, "output": 34, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 49, "output": 34, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
    [emit] turn.ended                          { "turnId": 0, "reason": "completed" }
  `);
  expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
    messages:
      <last>
      assistant: text "I will run that."  calls call_bash:Bash { "command": "printf lookup-result", "timeout": 60 }
      tool[call_bash]: text "lookup-result"
  `);
  await ctx.expectResumeMatches();
});
