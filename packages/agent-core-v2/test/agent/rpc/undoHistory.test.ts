import { afterEach, describe, expect, it } from 'vitest';

import {
  createTestAgent,
  telemetryServices,
  type TestAgentContext,
} from '../../harness';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';

describe('undoHistory RPC', () => {
  let ctx: TestAgentContext;
  let records: TelemetryRecord[];

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('tracks conversation_undo after undoing history', async () => {
    records = [];
    ctx = createTestAgent(telemetryServices(recordingTelemetry(records)));
    ctx.appendUserMessage([{ type: 'text', text: 'undo me' }]);

    const undone = await ctx.rpc.undoHistory({ count: 1 });

    expect(undone).toBe(1);
    expect(records).toContainEqual({
      event: 'conversation_undo',
      properties: { agent_id: 'main', count: 1 },
    });
  });
});
