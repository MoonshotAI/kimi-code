import { describe, expect, it } from 'vitest';

import {
  AGENT_WIRE_PROTOCOL_VERSION,
  AgentRecords,
  InMemoryAgentRecordPersistence,
  type AgentRecord,
} from '../../../../src/agent/records';
import { eventSnapshot } from '../../harness/snapshots';

describe('1.0 to 1.1', () => {
  it('rewrites v1.0 records to the v1.1 wire shape', async () => {
    const persistence = new InMemoryAgentRecordPersistence([
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
      } as unknown as AgentRecord,
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
    ]);
    const records = new AgentRecords(() => {}, persistence);

    await records.replay();

    expect(persistence.records[0]).toMatchObject({
      type: 'metadata',
      protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
    });
    expect(wireSnapshot(persistence.records)).toMatchInlineSnapshot(`
      [wire] metadata                   { "protocol_version": "1.1", "created_at": 1 }
      [wire] context.append_message     { "message": { "role": "assistant", "content": [], "toolCalls": [ { "type": "function", "id": "call_legacy_bash", "name": "Bash", "arguments": "{\\"command\\":\\"pwd\\"}" } ] } }
      [wire] tools.register_user_tool   { "name": "schema_tool", "description": "Tool with a schema field named function", "parameters": { "type": "object", "properties": { "function": { "type": "object", "properties": { "name": { "type": "string" } } }, "value": { "type": "string" } }, "required": [ "function" ] } }
    `);
  });
});

function wireSnapshot(records: readonly AgentRecord[]) {
  return eventSnapshot(
    records.map((record) => {
      const { type: event, ...args } = record;
      return {
        type: '[wire]' as const,
        event,
        args,
      };
    }),
    new Map(),
  );
}
