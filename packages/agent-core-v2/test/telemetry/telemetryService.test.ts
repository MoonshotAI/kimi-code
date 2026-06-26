import { beforeEach, describe, expect, it } from 'vitest';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, _clearScopedRegistryForTests, registerScopedService } from '#/_base/di/scope';
import { createScopedTestHost } from '#/_base/di/test';
import {
  type TelemetryClient,
  type TelemetryProperties,
  ITelemetryService,
  TelemetryService,
} from '#/telemetry/index';

class CapturingClient implements TelemetryClient {
  readonly events: { event: string; properties?: TelemetryProperties }[] = [];
  track(event: string, properties?: TelemetryProperties): void {
    this.events.push({ event, properties });
  }
}

describe('TelemetryService (unit)', () => {
  it('noop by default — does not throw', () => {
    const svc = new TelemetryService();
    expect(() => svc.track('evt', { a: 1 })).not.toThrow();
  });

  it('merges bound context into tracked properties', () => {
    const client = new CapturingClient();
    const svc = new TelemetryService({ sessionId: 's1' });
    svc.setDelegate(client);
    svc.track('turn.start', { agentId: 'main' });
    expect(client.events[0]).toEqual({
      event: 'turn.start',
      properties: { sessionId: 's1', agentId: 'main' },
    });
  });

  it('withContext merges context and shares the delegate', () => {
    const client = new CapturingClient();
    const root = new TelemetryService({ sessionId: 's1' });
    root.setDelegate(client);
    const child = root.withContext({ agentId: 'main', turnId: 't1' });
    child.track('tool.call', { name: 'bash' });
    expect(client.events[0]?.properties).toEqual({
      sessionId: 's1',
      agentId: 'main',
      turnId: 't1',
      name: 'bash',
    });
  });

  it('per-call properties override bound context on key collision', () => {
    const client = new CapturingClient();
    const svc = new TelemetryService({ sessionId: 's1' });
    svc.setDelegate(client);
    svc.track('evt', { sessionId: 'override' });
    expect(client.events[0]?.properties?.['sessionId']).toBe('override');
  });
});

describe('ITelemetryService (scoped)', () => {
  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.Core,
      ITelemetryService,
      TelemetryService,
      InstantiationType.Eager,
      'telemetry',
    );
  });

  it('resolves from the Core scope', () => {
    const host = createScopedTestHost();
    const svc = host.core.accessor.get(ITelemetryService);
    expect(() => svc.track('scoped')).not.toThrow();
    host.dispose();
  });
});
