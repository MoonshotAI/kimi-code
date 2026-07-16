import { describe, expect, it } from 'vitest';

import { migrateV1_2ToV1_3 } from '#/wire/migration/migration';
import { runMigration } from './utils';

describe('1.2 to 1.3', () => {
  it('is a pass-through migration that only bumps the protocol version', () => {
    expect(
      runMigration(migrateV1_2ToV1_3, [
        {
          type: 'metadata',
          protocol_version: '1.2',
          created_at: 1,
        },
        {
          type: 'context.append_message',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'hello' }],
            toolCalls: [],
          },
        },
        {
          type: 'context.append_loop_event',
          event: {
            type: 'step.begin',
            uuid: 'step-uuid-1',
            turnId: '1',
            step: 1,
          },
        },
        {
          type: 'context.append_loop_event',
          event: {
            type: 'tool.call',
            uuid: 'call-uuid-1',
            turnId: '1',
            step: 1,
            stepUuid: 'step-uuid-1',
            toolCallId: 'call_bash',
            name: 'Bash',
            args: { command: 'pwd' },
          },
        },
        {
          type: 'context.append_loop_event',
          event: {
            type: 'tool.result',
            parentUuid: 'call-uuid-1',
            toolCallId: 'call_bash',
            result: { output: '/home/user', isError: false },
          },
        },
        {
          type: 'permission.record_approval_result',
          turnId: 1,
          toolCallId: 'call_bash',
          toolName: 'Bash',
          action: 'run command',
          sessionApprovalRule: 'Bash',
          result: {
            decision: 'approved',
            scope: 'session',
            selectedLabel: 'Approve for this session',
          },
        },
        {
          type: 'forked',
          time: 100,
        },
      ]),
    ).toMatchInlineSnapshot(`
      [wire] metadata                            { "protocol_version": "1.3", "created_at": "<time>" }
      [wire] context.append_message              { "message": { "role": "user", "content": [ { "type": "text", "text": "hello" } ], "toolCalls": [] } }
      [wire] context.append_loop_event           { "event": { "type": "step.begin", "uuid": "step-uuid-1", "turnId": "1", "step": 1 } }
      [wire] context.append_loop_event           { "event": { "type": "tool.call", "uuid": "call-uuid-1", "turnId": "1", "step": 1, "stepUuid": "step-uuid-1", "toolCallId": "call_bash", "name": "Bash", "args": { "command": "pwd" } } }
      [wire] context.append_loop_event           { "event": { "type": "tool.result", "parentUuid": "call-uuid-1", "toolCallId": "call_bash", "result": { "output": "/home/user", "isError": false } } }
      [wire] permission.record_approval_result   { "turnId": 1, "toolCallId": "call_bash", "toolName": "Bash", "action": "run command", "sessionApprovalRule": "Bash", "result": { "decision": "approved", "scope": "session", "selectedLabel": "Approve for this session" } }
      [wire] forked                              { "time": "<time>" }
    `);
  });

  it('handles empty record sets', () => {
    expect(runMigration(migrateV1_2ToV1_3, [])).toMatchInlineSnapshot(`[]`);
  });

  it('preserves metadata created_at timestamp', () => {
    expect(
      runMigration(migrateV1_2ToV1_3, [
        {
          type: 'metadata',
          protocol_version: '1.2',
          created_at: 1234567890,
        },
      ]),
    ).toMatchInlineSnapshot(`
      [wire] metadata   { "protocol_version": "1.3", "created_at": "<time>" }
    `);
  });
});
