import { describe, expect, it } from 'vitest';

import { migrateV1_4ToV1_5 } from '#/wireRecord/migration';
import { runMigrationRecords } from './utils';

describe('1.4 to 1.5', () => {
  it('rewrites prompt and loop transcript records to launch and splice records', () => {
    expect(
      runMigrationRecords(migrateV1_4ToV1_5, [
        {
          type: 'metadata',
          protocol_version: '1.4',
          created_at: 1,
        },
        {
          type: 'turn.prompt',
          input: [{ type: 'text', text: 'hello' }],
          origin: { kind: 'user' },
          time: 10,
        },
        {
          type: 'context.append_message',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'hello' }],
            toolCalls: [],
            origin: { kind: 'user' },
          },
          time: 11,
        },
        {
          type: 'context.append_loop_event',
          event: {
            type: 'step.begin',
            uuid: 'step_1',
            turnId: '0',
            step: 1,
          },
          time: 20,
        },
        {
          type: 'context.append_loop_event',
          event: {
            type: 'content.part',
            uuid: 'part_1',
            turnId: '0',
            step: 1,
            stepUuid: 'step_1',
            part: { type: 'text', text: 'checking' },
          },
          time: 21,
        },
        {
          type: 'context.append_loop_event',
          event: {
            type: 'tool.call',
            uuid: 'tool_1',
            turnId: '0',
            step: 1,
            stepUuid: 'step_1',
            toolCallId: 'call_1',
            name: 'Read',
            args: { file: 'example.test' },
          },
          time: 22,
        },
        {
          type: 'context.append_message',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'queued while tool runs' }],
            toolCalls: [],
            origin: { kind: 'system_trigger', name: 'queued' },
          },
          time: 23,
        },
        {
          type: 'context.append_loop_event',
          event: {
            type: 'tool.result',
            parentUuid: 'tool_1',
            toolCallId: 'call_1',
            result: {
              output: 'contents',
            },
          },
          time: 24,
        },
        {
          type: 'context.append_loop_event',
          event: {
            type: 'step.end',
            uuid: 'step_1',
            turnId: '0',
            step: 1,
          },
          time: 25,
        },
      ]),
    ).toMatchInlineSnapshot(`
      [wire] metadata         { "protocol_version": "<protocol-version>", "created_at": "<time>" }
      [wire] context.splice   { "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "hello" } ], "toolCalls": [], "origin": { "kind": "user" } } ], "time": "<time>" }
      [wire] turn.launch      { "turnId": 0, "origin": { "kind": "user" }, "time": "<time>" }
      [wire] context.splice   { "start": 1, "deleteCount": 0, "messages": [ { "role": "assistant", "content": [ { "type": "text", "text": "checking" } ], "toolCalls": [] } ], "time": "<time>" }
      [wire] context.splice   { "start": 1, "deleteCount": 1, "messages": [ { "role": "assistant", "content": [ { "type": "text", "text": "checking" } ], "toolCalls": [ { "type": "function", "id": "call_1", "name": "Read", "arguments": "{\\"file\\":\\"example.test\\"}" } ] } ], "time": "<time>" }
      [wire] context.splice   { "start": 2, "deleteCount": 0, "messages": [ { "role": "tool", "content": [ { "type": "text", "text": "contents" } ], "toolCalls": [], "toolCallId": "call_1" } ], "time": "<time>" }
      [wire] context.splice   { "start": 3, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "queued while tool runs" } ], "toolCalls": [], "origin": { "kind": "system_trigger", "name": "queued" } } ], "time": "<time>" }
    `);
  });

  it('preserves restored state across interrupted tools, compaction, undo, and fork records', () => {
    expect(
      runMigrationRecords(migrateV1_4ToV1_5, [
        {
          type: 'metadata',
          protocol_version: '1.4',
          created_at: 1,
        },
        {
          type: 'goal.create',
          goalId: 'goal-1',
          objective: 'finish migration',
          time: 2,
        },
        {
          type: 'forked',
          time: 3,
        },
        {
          type: 'context.append_message',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'before tool' }],
            toolCalls: [],
            origin: { kind: 'user' },
          },
          time: 10,
        },
        {
          type: 'context.append_loop_event',
          event: {
            type: 'step.begin',
            uuid: 'step_1',
            turnId: '2',
            step: 1,
          },
          time: 20,
        },
        {
          type: 'context.append_loop_event',
          event: {
            type: 'tool.call',
            uuid: 'tool_1',
            turnId: '2',
            step: 1,
            stepUuid: 'step_1',
            toolCallId: 'call_interrupted',
            name: 'Write',
            args: { file: 'example.test' },
          },
          time: 21,
        },
        {
          type: 'context.append_loop_event',
          event: {
            type: 'step.begin',
            uuid: 'step_2',
            turnId: '3',
            step: 1,
          },
          time: 30,
        },
        {
          type: 'context.append_loop_event',
          event: {
            type: 'content.part',
            uuid: 'part_2',
            turnId: '3',
            step: 1,
            stepUuid: 'step_2',
            part: { type: 'text', text: 'after interruption' },
          },
          time: 31,
        },
        {
          type: 'context.apply_compaction',
          summary: 'compacted summary',
          compactedCount: 2,
          tokensBefore: 100,
          tokensAfter: 20,
          time: 40,
        },
        {
          type: 'context.append_message',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'remove this' }],
            toolCalls: [],
            origin: { kind: 'user' },
          },
          time: 50,
        },
        {
          type: 'context.undo',
          count: 1,
          time: 60,
        },
      ]),
    ).toMatchInlineSnapshot(`
      [wire] metadata                   { "protocol_version": "<protocol-version>", "created_at": "<time>" }
      [wire] goal.create                { "goalId": "goal-1", "objective": "finish migration", "time": "<time>" }
      [wire] goal.clear                 { "time": "<time>" }
      [wire] context.splice             { "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "before tool" } ], "toolCalls": [], "origin": { "kind": "user" } } ], "time": "<time>" }
      [wire] turn.launch                { "turnId": 2, "origin": { "kind": "system_trigger", "name": "migrated_turn" }, "time": "<time>" }
      [wire] context.splice             { "start": 1, "deleteCount": 0, "messages": [ { "role": "assistant", "content": [], "toolCalls": [ { "type": "function", "id": "call_interrupted", "name": "Write", "arguments": "{\\"file\\":\\"example.test\\"}" } ] } ], "time": "<time>" }
      [wire] turn.launch                { "turnId": 3, "origin": { "kind": "system_trigger", "name": "migrated_turn" }, "time": "<time>" }
      [wire] context.splice             { "start": 2, "deleteCount": 0, "messages": [ { "role": "tool", "content": [ { "type": "text", "text": "<system>ERROR: Tool execution failed.</system>\\nTool execution was interrupted before its result was recorded. Do not assume the tool completed successfully." } ], "toolCalls": [], "toolCallId": "call_interrupted", "isError": true } ], "time": "<time>" }
      [wire] context.splice             { "start": 3, "deleteCount": 0, "messages": [ { "role": "assistant", "content": [ { "type": "text", "text": "after interruption" } ], "toolCalls": [] } ], "time": "<time>" }
      [wire] context.splice             { "start": 0, "deleteCount": 2, "messages": [ { "role": "assistant", "content": [ { "type": "text", "text": "compacted summary" } ], "toolCalls": [], "origin": { "kind": "compaction_summary" } } ], "time": "<time>" }
      [wire] full_compaction.complete   { "compactedCount": 2, "tokensBefore": 100, "tokensAfter": 20, "time": "<time>" }
      [wire] context.splice             { "start": 3, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "remove this" } ], "toolCalls": [], "origin": { "kind": "user" } } ], "time": "<time>" }
      [wire] context.splice             { "start": 3, "deleteCount": 1, "messages": [], "time": "<time>" }
    `);
  });
});
