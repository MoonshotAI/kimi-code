/**
 * AsyncAPI document contract for server-v2 WebSocket events. The generated
 * document is real; no collaborators are stubbed.
 * Run with: pnpm --filter @moonshot-ai/kap-server test -- asyncapi.test.ts
 */

import { describe, expect, it } from 'vitest';

import { createAsyncApiDocument } from '../src/protocol/asyncapi';

describe('server-v2 AsyncAPI event contract', () => {
  it('advertises priority on agent status update events', () => {
    const document = createAsyncApiDocument();
    const sessionEventPayload = asRecord(
      asRecord(asRecord(document['components'])['messages'])['session_event'],
    )['payload'];
    const statusSchema = findSchemaForEvent(sessionEventPayload, 'agent.status.updated');
    if (statusSchema === undefined) {
      throw new Error('agent.status.updated schema not found');
    }

    expect(asRecord(asRecord(statusSchema['properties'])['priority'])).toEqual({
      type: 'boolean',
    });
  });
});

function findSchemaForEvent(
  value: unknown,
  type: string,
): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    for (const child of value) {
      const match = findSchemaForEvent(child, type);
      if (match !== undefined) return match;
    }
  } else if (typeof value === 'object' && value !== null) {
    const object = value as Record<string, unknown>;
    const properties = object['properties'];
    if (
      typeof properties === 'object' &&
      properties !== null &&
      asRecord(asRecord(properties)['type'])['const'] === type
    ) {
      return object;
    }
    for (const child of Object.values(object)) {
      const match = findSchemaForEvent(child, type);
      if (match !== undefined) return match;
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error('expected object');
  }
  return value as Record<string, unknown>;
}
