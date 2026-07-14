/**
 * `telemetry` tests — `AgentTelemetryContextService` unit tests.
 */

import { describe, expect, it } from 'vitest';

import { makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { AgentTelemetryContextService } from '#/app/telemetry/agentTelemetryContextService';
import { recordingTelemetry, type TelemetryRecord } from './stubs';

describe('AgentTelemetryContextService', () => {
  it('defaults to agent mode and merges into telemetry through withContext', () => {
    const records: TelemetryRecord[] = [];
    const telemetry = recordingTelemetry(records);
    const ctx = new AgentTelemetryContextService(
      makeAgentScopeContext({ agentId: 'main', agentScope: '' }),
    );

    telemetry.withContext(ctx.get()).track('turn_started');
    expect(records).toContainEqual({
      event: 'turn_started',
      properties: { mode: 'agent', agent_id: 'main' },
    });

    ctx.set({ mode: 'plan' });
    telemetry.withContext(ctx.get()).track('turn_interrupted', { at_step: 2 });
    expect(records).toContainEqual({
      event: 'turn_interrupted',
      properties: { mode: 'plan', agent_id: 'main', at_step: 2 },
    });
  });

  it('snapshots the context at withContext time', () => {
    const records: TelemetryRecord[] = [];
    const telemetry = recordingTelemetry(records);
    const ctx = new AgentTelemetryContextService(
      makeAgentScopeContext({ agentId: 'main', agentScope: '' }),
    );
    ctx.set({ mode: 'plan' });

    const fork = telemetry.withContext(ctx.get());
    ctx.set({ mode: 'agent' });

    fork.track('turn_interrupted', { at_step: 1 });
    expect(records).toContainEqual({
      event: 'turn_interrupted',
      properties: { mode: 'plan', agent_id: 'main', at_step: 1 },
    });
  });
});
