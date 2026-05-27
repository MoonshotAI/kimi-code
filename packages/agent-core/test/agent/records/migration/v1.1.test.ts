import { describe, expect, it } from 'vitest';

import { migrateV1_0ToV1_1 } from '../../../../src/agent/records/migration/v1.1';
import { runMigration } from './utils';

describe('1.0 to 1.1', () => {
  it('rewrites v1.0 records to the v1.1 wire shape', () => {
    expect(
      runMigration(migrateV1_0ToV1_1, [
        {
          type: 'metadata',
          protocol_version: '1.0',
          created_at: 1,
        },
        {
          type: 'context.append_message',
          message: {
            role: 'assistant',
            content: [],
            toolCalls: [
              {
                type: 'function',
                id: 'call_legacy_bash',
                function: {
                  name: 'Bash',
                  arguments: '{"command":"pwd"}',
                },
              },
            ],
          },
        },
        {
          type: 'tools.register_user_tool',
          name: 'schema_tool',
          description: 'Tool with a schema field named function',
          parameters: {
            type: 'object',
            properties: {
              function: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                },
              },
              value: { type: 'string' },
            },
            required: ['function'],
          },
        },
        {
          type: 'context.append_loop_event',
          event: {
            type: 'tool.call',
            uuid: 'call_payload',
            turnId: '0',
            step: 1,
            stepUuid: 'step_1',
            toolCallId: 'call_payload',
            name: 'PayloadTool',
            args: {
              payload: {
                type: 'function',
                id: 'user_payload',
                function: {
                  name: 'do-not-migrate',
                  arguments: '{"keep":true}',
                },
              },
            },
          },
        },
      ]),
    ).toMatchInlineSnapshot(`
      [wire] metadata                    { "protocol_version": "1.1", "created_at": "<time>" }
      [wire] context.append_message      { "message": { "role": "assistant", "content": [], "toolCalls": [ { "type": "function", "id": "call_legacy_bash", "name": "Bash", "arguments": "{\\"command\\":\\"pwd\\"}" } ] } }
      [wire] tools.register_user_tool    { "name": "schema_tool", "description": "Tool with a schema field named function", "parameters": { "type": "object", "properties": { "function": { "type": "object", "properties": { "name": { "type": "string" } } }, "value": { "type": "string" } }, "required": [ "function" ] } }
      [wire] context.append_loop_event   { "event": { "type": "tool.call", "uuid": "call_payload", "turnId": "0", "step": 1, "stepUuid": "step_1", "toolCallId": "call_payload", "name": "PayloadTool", "args": { "payload": { "type": "function", "id": "user_payload", "function": { "name": "do-not-migrate", "arguments": "{\\"keep\\":true}" } } } } }
    `);
  });
});
