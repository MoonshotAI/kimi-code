import { describe, expect, it } from 'vitest';

import { migrateV1_3ToV1_4 } from '../../../../src/agent/records/migration/v1.4';
import { runMigration } from './utils';

describe('1.3 to 1.4', () => {
  it('bumps the wire version without rewriting existing records', () => {
    expect(
      runMigration(migrateV1_3ToV1_4, [
        {
          type: 'metadata',
          protocol_version: '1.3',
          created_at: 1,
        },
        {
          type: 'turn.prompt',
          input: [{ type: 'text', text: 'hello' }],
          origin: { kind: 'user' },
        },
      ]),
    ).toMatchInlineSnapshot(`
      [wire] metadata      { "protocol_version": "1.4", "created_at": "<time>" }
      [wire] turn.prompt   { "input": [ { "type": "text", "text": "hello" } ], "origin": { "kind": "user" } }
    `);
  });
});
