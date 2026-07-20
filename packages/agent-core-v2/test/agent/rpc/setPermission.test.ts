import { afterEach, describe, expect, it } from 'vitest';

import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';

import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';
import { createTestAgent, telemetryServices, type TestAgentContext } from '../../harness';

describe('setPermission RPC', () => {
  let ctx: TestAgentContext;
  let records: TelemetryRecord[];

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('applies the mode to the agent and tracks the afk toggle', async () => {
    records = [];
    ctx = createTestAgent(telemetryServices(recordingTelemetry(records)));

    await ctx.rpc.setPermission({ mode: 'auto' });

    expect(ctx.get(IAgentPermissionModeService).mode).toBe('auto');
    expect(records).toContainEqual({ event: 'afk_toggle', properties: { enabled: true } });
  });

  it('tracks the yolo toggle on enter and exit', async () => {
    records = [];
    ctx = createTestAgent(telemetryServices(recordingTelemetry(records)));

    await ctx.rpc.setPermission({ mode: 'yolo' });
    await ctx.rpc.setPermission({ mode: 'manual' });

    expect(ctx.get(IAgentPermissionModeService).mode).toBe('manual');
    expect(records).toContainEqual({ event: 'yolo_toggle', properties: { enabled: true } });
    expect(records).toContainEqual({ event: 'yolo_toggle', properties: { enabled: false } });
  });
});
