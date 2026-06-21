import { describe, expect, it } from 'vitest';

import { type AgentRecord } from '../../src/agent/records';
import { ErrorCodes } from '../../src/errors';
import type { ErrorEvent } from '../../src/rpc';
import { testAgent } from './harness/agent';

describe('RecordsService.emitWriteError', () => {
  it('publishes a records-write-error event with the expected payload', () => {
    const { agent } = testAgent();

    const events: ErrorEvent[] = [];
    const subscription = agent.eventBus.subscribe('error', (event) => {
      events.push(event);
    });

    const record = {
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'hello' }],
      origin: { kind: 'user' },
    } as unknown as AgentRecord;

    agent.records.emitWriteError(new Error('disk full'), record);

    subscription.dispose();

    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.type).toBe('error');
    expect(event?.code).toBe(ErrorCodes.RECORDS_WRITE_FAILED);
    expect(event?.message).toBe('Failed to write agent records: disk full');
    expect(event?.details).toEqual({ recordType: 'turn.prompt' });
  });

  it('stringifies non-Error values and omits recordType when no record is given', () => {
    const { agent } = testAgent();

    const events: ErrorEvent[] = [];
    const subscription = agent.eventBus.subscribe('error', (event) => {
      events.push(event);
    });

    agent.records.emitWriteError('plain failure');

    subscription.dispose();

    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.type).toBe('error');
    expect(event?.code).toBe(ErrorCodes.RECORDS_WRITE_FAILED);
    expect(event?.message).toBe('Failed to write agent records: plain failure');
    expect(event?.details).toEqual({ recordType: undefined });
  });
});
