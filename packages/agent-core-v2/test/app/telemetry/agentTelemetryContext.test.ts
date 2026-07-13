/**
 * `telemetry` tests — `AgentTelemetryContextService` unit tests.
 */

import { describe, expect, it } from 'vitest';

import { AgentTelemetryContextService } from '#/app/telemetry/agentTelemetryContextService';
import { recordingTelemetry, type TelemetryRecord } from './stubs';

describe('AgentTelemetryContextService', () => {
  it('defaults to agent mode and merges into telemetry through withContext', () => {
    const records: TelemetryRecord[] = [];
    const telemetry = recordingTelemetry(records);
    const ctx = new AgentTelemetryContextService();

    telemetry.withContext(ctx.get()).track('turn_started');
    expect(records).toContainEqual({ event: 'turn_started', properties: { mode: 'agent' } });

    ctx.set({ mode: 'plan' });
    telemetry.withContext(ctx.get()).track('turn_interrupted', { at_step: 2 });
    expect(records).toContainEqual({
      event: 'turn_interrupted',
      properties: { mode: 'plan', at_step: 2 },
    });
  });

  it('snapshots the context at withContext time', () => {
    const records: TelemetryRecord[] = [];
    const telemetry = recordingTelemetry(records);
    const ctx = new AgentTelemetryContextService();
    ctx.set({ mode: 'plan' });

    const fork = telemetry.withContext(ctx.get());
    ctx.set({ mode: 'agent' });

    fork.track('turn_interrupted', { at_step: 1 });
    expect(records).toContainEqual({
      event: 'turn_interrupted',
      properties: { mode: 'plan', at_step: 1 },
    });
  });
});
