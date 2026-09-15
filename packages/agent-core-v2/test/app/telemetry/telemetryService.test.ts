import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, _clearScopedRegistryForTests, registerScopedService } from '#/_base/di/scope';
import { createScopedTestHost } from '#/_base/di/test';
import {
  resetUnexpectedErrorHandler,
  setUnexpectedErrorHandler,
} from '#/_base/errors/unexpectedError';
import type { TelemetryProperties } from '#/app/telemetry/context';
import type { TurnStartedEvent as TurnStartedTelemetryEvent } from '#/app/telemetry/events';
import { type ITelemetryAppender, ITelemetryService } from '#/app/telemetry/telemetry';
import {
  type ITelemetryScopeBindingHost,
  TelemetryService,
} from '#/app/telemetry/telemetryService';

interface CapturedRecord {
  readonly event: string;
  readonly context: TelemetryProperties;
  readonly properties: TelemetryProperties;
}

class CapturingAppender implements ITelemetryAppender {
  readonly records: CapturedRecord[] = [];
  flushCalls = 0;
  shutdownCalls = 0;
  track(record: CapturedRecord): void {
    this.records.push(record);
  }
  flush(): void {
    this.flushCalls += 1;
  }
  shutdown(): void {
    this.shutdownCalls += 1;
  }
}

function serviceWithAppenders(...appenders: ITelemetryAppender[]): TelemetryService {
  const svc = new TelemetryService();
  for (const appender of appenders) {
    svc.addAppender(appender);
  }
  return svc;
}

describe('TelemetryService (unit)', () => {
  it('noop by default — does not throw', () => {
    const svc = new TelemetryService();
    expect(() => svc.track2('session_ended', { reason: 'exit' })).not.toThrow();
  });

  it('maps ambient session_id to camel sessionId properties', () => {
    const appender = new CapturingAppender();
    const svc = serviceWithAppenders(appender);
    svc.setContext({ session_id: 's1', agent_id: 'a1' });
    svc.track2('session_ended', { reason: 'exit' });
    expect(appender.records[0]).toEqual({
      event: 'session_ended',
      context: { session_id: 's1', agent_id: 'a1' },
      properties: { sessionId: 's1', agent_id: 'a1', reason: 'exit' },
    });
  });

  it('passes the merged ambient as the appender record context', () => {
    const appender = new CapturingAppender();
    const svc = serviceWithAppenders(appender);
    svc.setContext({ model: 'm1' });
    svc.track2('model_switch', { model: 'm2' });
    expect(appender.records[0]?.context).toEqual({ model: 'm1' });
  });

  it('per-call properties override ambient context on key collision', () => {
    const appender = new CapturingAppender();
    const svc = serviceWithAppenders(appender);
    svc.setContext({ model: 'm1' });
    svc.track2('model_switch', { model: 'override' });
    expect(appender.records[0]?.properties?.['model']).toBe('override');
  });

  it('drops ambient model from properties when the event declares model but ambient lacks it', () => {
    const appender = new CapturingAppender();
    const svc = serviceWithAppenders(appender);
    svc.track2('model_switch', { model: 'm2' });
    expect(appender.records[0]?.properties).toEqual({ model: 'm2' });
  });

  it('fans out to every appender passed via addAppender', () => {
    const a = new CapturingAppender();
    const b = new CapturingAppender();
    const svc = serviceWithAppenders(a, b);
    svc.track2('session_ended', { reason: 'exit' });
    expect(a.records).toHaveLength(1);
    expect(b.records).toHaveLength(1);
  });

  it('addAppender registers an appender and its disposable removes it', () => {
    const a = new CapturingAppender();
    const b = new CapturingAppender();
    const svc = serviceWithAppenders(a);
    const disposable = svc.addAppender(b);
    svc.track2('session_ended', { reason: 'exit' });
    expect(a.records).toHaveLength(1);
    expect(b.records).toHaveLength(1);
    disposable.dispose();
    svc.track2('session_ended', { reason: 'archive' });
    expect(a.records).toHaveLength(2);
    expect(b.records).toHaveLength(1);
  });

  it('removeAppender stops delivery to that appender', () => {
    const a = new CapturingAppender();
    const b = new CapturingAppender();
    const svc = serviceWithAppenders(a, b);
    svc.removeAppender(a);
    svc.track2('session_ended', { reason: 'exit' });
    expect(a.records).toHaveLength(0);
    expect(b.records).toHaveLength(1);
  });

  it('setEnabled(false) drops track2; setEnabled(true) resumes', () => {
    const appender = new CapturingAppender();
    const svc = serviceWithAppenders(appender);
    svc.setEnabled(false);
    svc.track2('session_ended', { reason: 'exit' });
    expect(appender.records).toHaveLength(0);
    svc.setEnabled(true);
    svc.track2('session_ended', { reason: 'exit' });
    expect(appender.records).toHaveLength(1);
  });

  it('setContext with undefined removes the key from the layer', () => {
    const appender = new CapturingAppender();
    const svc = serviceWithAppenders(appender);
    svc.setContext({ model: 'm1' });
    svc.setContext({ model: undefined });
    expect(svc.getContext()).toEqual({});
    svc.track2('session_ended', { reason: 'exit' });
    expect(appender.records[0]?.properties).toEqual({ reason: 'exit' });
  });

  it('withContext view follows root enablement changes', () => {
    const appender = new CapturingAppender();
    const svc = serviceWithAppenders(appender);
    const child = svc.withContext({ session_id: 's1' });

    svc.setEnabled(false);
    child.track2('session_ended', { reason: 'exit' });
    expect(appender.records).toHaveLength(0);

    svc.setEnabled(true);
    child.track2('session_ended', { reason: 'exit' });
    expect(appender.records).toHaveLength(1);
  });

  it('flush fans out to every appender', async () => {
    const a = new CapturingAppender();
    const b = new CapturingAppender();
    const svc = serviceWithAppenders(a, b);
    await svc.flush();
    expect(a.flushCalls).toBe(1);
    expect(b.flushCalls).toBe(1);
  });

  it('shutdown fans out to every appender', async () => {
    const a = new CapturingAppender();
    const b = new CapturingAppender();
    const svc = serviceWithAppenders(a, b);
    await svc.shutdown();
    expect(a.shutdownCalls).toBe(1);
    expect(b.shutdownCalls).toBe(1);
  });

  it('flush is a no-op for appenders without flush', async () => {
    const minimal: ITelemetryAppender = { track() {} };
    const svc = serviceWithAppenders(minimal);
    await expect(svc.flush()).resolves.toBeUndefined();
    await expect(svc.shutdown()).resolves.toBeUndefined();
  });
});

describe('TelemetryService (error isolation)', () => {
  beforeEach(() => setUnexpectedErrorHandler(() => {}));
  afterEach(() => resetUnexpectedErrorHandler());

  it('a throwing appender does not prevent delivery to other appenders', () => {
    const bad: ITelemetryAppender = {
      track() {
        throw new Error('boom');
      },
    };
    const good = new CapturingAppender();
    const svc = serviceWithAppenders(bad, good);
    expect(() => svc.track2('session_ended', { reason: 'exit' })).not.toThrow();
    expect(good.records).toHaveLength(1);
  });

  it('flush tolerates a rejecting appender and still flushes the rest', async () => {
    const bad: ITelemetryAppender = {
      track() {},
      async flush() {
        throw new Error('boom');
      },
    };
    const good = new CapturingAppender();
    const svc = serviceWithAppenders(bad, good);
    await expect(svc.flush()).resolves.toBeUndefined();
    expect(good.flushCalls).toBe(1);
  });

  it('shutdown tolerates a rejecting appender and still shuts down the rest', async () => {
    const bad: ITelemetryAppender = {
      track() {},
      async shutdown() {
        throw new Error('boom');
      },
    };
    const good = new CapturingAppender();
    const svc = serviceWithAppenders(bad, good);
    await expect(svc.shutdown()).resolves.toBeUndefined();
    expect(good.shutdownCalls).toBe(1);
  });
});

describe('TelemetryService (layered ambient)', () => {
  it('merges App → Session → Agent fragments with the nearest layer winning', () => {
    const appender = new CapturingAppender();
    const root = serviceWithAppenders(appender);
    root.setContext({ session_id: 'app-level', model: 'm1' });

    const session = root.createScopeBinding({ session_id: 's1' });
    const agent = (session.telemetry as ITelemetryService & ITelemetryScopeBindingHost)
      .createScopeBinding({ agent_id: 'a1', mode: 'agent' });

    agent.telemetry.track2('session_ended', { reason: 'exit' });
    expect(appender.records[0]?.properties).toEqual({
      sessionId: 's1',
      agent_id: 'a1',
      mode: 'agent',
      model: 'm1',
      reason: 'exit',
    });
    expect(appender.records[0]?.context).toEqual({
      session_id: 's1',
      agent_id: 'a1',
      mode: 'agent',
      model: 'm1',
    });
  });

  it('setContext on a bound handle writes its own fragment', () => {
    const appender = new CapturingAppender();
    const root = serviceWithAppenders(appender);
    const session = root.createScopeBinding({ session_id: 's1' });
    session.telemetry.setContext({ model: 'session-model' });
    expect(root.getContext()).toEqual({});
    expect(session.telemetry.getContext()).toEqual({
      session_id: 's1',
      model: 'session-model',
    });
  });

  it('a turn event picks the ambient turn fragment up', () => {
    const appender = new CapturingAppender();
    const root = serviceWithAppenders(appender);
    const session = root.createScopeBinding({ session_id: 's1' });
    const agent = (session.telemetry as ITelemetryService & ITelemetryScopeBindingHost)
      .createScopeBinding({ agent_id: 'a1', mode: 'agent' });
    agent.telemetry.setContext({ turn_id: 3 });
    agent.telemetry.track2('tool_call_dedup_detected', {
      step_no: 1,
      tool_call_id: 'call_1',
      tool_name: 'bash',
      dup_type: 'same_step',
      args_hash: 'hash-1',
    });
    expect(appender.records[0]?.properties).toEqual({
      sessionId: 's1',
      agent_id: 'a1',
      mode: 'agent',
      turn_id: 3,
      step_no: 1,
      tool_call_id: 'call_1',
      tool_name: 'bash',
      dup_type: 'same_step',
      args_hash: 'hash-1',
    });
  });

  it('an event not declaring context fields still receives the full ambient context', () => {
    const appender = new CapturingAppender();
    const root = serviceWithAppenders(appender);
    const agent = root.createScopeBinding({
      agent_id: 'a1',
      mode: 'plan',
    });
    agent.telemetry.setContext({
      turn_id: 3,
      trace_id: 'trace-1',
      thinking_effort: 'high',
      provider_type: 'kimi',
      protocol: 'openai',
    });
    agent.telemetry.track2('skill_invoked', {
      skill_name: 'review',
      trigger: 'user-slash',
    });
    expect(appender.records[0]?.properties).toEqual({
      agent_id: 'a1',
      mode: 'plan',
      turn_id: 3,
      trace_id: 'trace-1',
      thinking_effort: 'high',
      provider_type: 'kimi',
      protocol: 'openai',
      skill_name: 'review',
      trigger: 'user-slash',
    });
  });

  it('explicitly passed fields pass through even when the event does not declare them', () => {
    const appender = new CapturingAppender();
    const root = serviceWithAppenders(appender);
    const agent = root.createScopeBinding({
      agent_id: 'a1',
      mode: 'agent',
    });
    agent.telemetry.track2('skill_invoked', {
      skill_name: 'review',
      trigger: 'user-slash',
      turn_id: 3,
      trace_id: 'trace-1',
    } as never);
    expect(appender.records[0]?.properties).toEqual({
      agent_id: 'a1',
      mode: 'agent',
      turn_id: 3,
      trace_id: 'trace-1',
      skill_name: 'review',
      trigger: 'user-slash',
    });
  });

  it('events emitted after a turn ends carry no turn_id', () => {
    const appender = new CapturingAppender();
    const root = serviceWithAppenders(appender);
    const agent = root.createScopeBinding({
      agent_id: 'a1',
      mode: 'agent',
    });
    agent.telemetry.setContext({ turn_id: 3 });
    agent.telemetry.track2('tool_call_dedup_detected', {
      step_no: 1,
      tool_call_id: 'call_1',
      tool_name: 'bash',
      dup_type: 'same_step',
      args_hash: 'hash-1',
    });
    expect(appender.records[0]?.properties?.['turn_id']).toBe(3);

    agent.telemetry.setContext({ turn_id: undefined });
    agent.telemetry.track2('tool_call_dedup_detected', {
      step_no: 2,
      tool_call_id: 'call_2',
      tool_name: 'bash',
      dup_type: 'same_step',
      args_hash: 'hash-2',
    });
    expect(appender.records[1]?.properties?.['turn_id']).toBeUndefined();
    expect(appender.records[1]?.properties).toEqual({
      agent_id: 'a1',
      mode: 'agent',
      step_no: 2,
      tool_call_id: 'call_2',
      tool_name: 'bash',
      dup_type: 'same_step',
      args_hash: 'hash-2',
    });
  });

  it('profile and plan writes flow into subsequent turn events', () => {
    const appender = new CapturingAppender();
    const root = serviceWithAppenders(appender);
    const agent = root.createScopeBinding({
      agent_id: 'a1',
      mode: 'agent',
    });
    agent.telemetry.setContext({ provider_type: 'kimi', protocol: 'openai' });
    agent.telemetry.setContext({ mode: 'plan' });
    agent.telemetry.setContext({ turn_id: 1 });
    const { mode, provider_type, protocol } = agent.telemetry.getContext();
    const started: TurnStartedTelemetryEvent = {
      turn_id: 1,
      mode: mode ?? 'agent',
      provider_type,
      protocol,
      thinking_effort: 'off',
    };
    agent.telemetry.track2('turn_started', started);
    expect(appender.records[0]?.properties).toEqual({
      agent_id: 'a1',
      turn_id: 1,
      mode: 'plan',
      provider_type: 'kimi',
      protocol: 'openai',
      thinking_effort: 'off',
    });
  });

  it('withContext snapshots isolate the view from later setContext writes', () => {
    const appender = new CapturingAppender();
    const root = serviceWithAppenders(appender);
    const session = root.createScopeBinding({ session_id: 's1' });
    session.telemetry.setContext({ model: 'm1' });

    const snapshot = session.telemetry.withContext({ session_id: 's2' });
    session.telemetry.setContext({ model: 'm2' });
    root.setContext({ model: 'root-model' });

    snapshot.track2('session_ended', { reason: 'exit' });
    expect(appender.records[0]?.properties).toEqual({
      sessionId: 's2',
      model: 'm1',
      reason: 'exit',
    });

    session.telemetry.track2('session_ended', { reason: 'exit' });
    expect(appender.records[1]?.properties).toEqual({
      sessionId: 's1',
      model: 'm2',
      reason: 'exit',
    });
  });

  it('disposing a scope binding removes its fragment and degrades to the parent chain', () => {
    const appender = new CapturingAppender();
    const root = serviceWithAppenders(appender);
    const session = root.createScopeBinding({ session_id: 's1' });
    const agent = (session.telemetry as ITelemetryService & ITelemetryScopeBindingHost)
      .createScopeBinding({ agent_id: 'a1' });

    agent.dispose();
    agent.telemetry.track2('session_ended', { reason: 'exit' });
    expect(appender.records[0]?.properties).toEqual({
      sessionId: 's1',
      reason: 'exit',
    });
  });

  it('events emitted through a disposed session binding fall back to the App layer', () => {
    const appender = new CapturingAppender();
    const root = serviceWithAppenders(appender);
    root.setContext({ model: 'app-model' });
    const session = root.createScopeBinding({ session_id: 's1' });
    session.dispose();
    session.telemetry.track2('session_ended', { reason: 'exit' });
    expect(appender.records[0]?.properties).toEqual({
      model: 'app-model',
      reason: 'exit',
    });
  });

  it('disposing one binding leaves a sibling binding untouched', () => {
    const appender = new CapturingAppender();
    const root = serviceWithAppenders(appender);
    const first = root.createScopeBinding({ session_id: 's1' });
    const second = root.createScopeBinding({
      session_id: 's1',
      model: 'resumed-model',
    });
    first.dispose();
    second.telemetry.track2('session_started', { resumed: true, experimental_flags: '' });
    expect(appender.records[0]?.properties).toEqual({
      sessionId: 's1',
      model: 'resumed-model',
      resumed: true,
      experimental_flags: '',
    });
    second.dispose();
    second.telemetry.track2('session_started', { resumed: true, experimental_flags: '' });
    expect(appender.records[1]?.properties).toEqual({ resumed: true, experimental_flags: '' });
  });

  it('context writes on one binding do not leak into a sibling binding', () => {
    const appender = new CapturingAppender();
    const root = serviceWithAppenders(appender);
    const first = root.createScopeBinding({ agent_id: 'a1', mode: 'agent' });
    const second = root.createScopeBinding({ agent_id: 'a1', mode: 'plan' });
    first.telemetry.setContext({ turn_id: 7, mode: 'agent' });
    first.telemetry.setContext({ turn_id: undefined, mode: 'agent' });
    second.telemetry.track2('turn_started', { turn_id: 3, mode: 'plan' });
    expect(appender.records[0]?.properties).toEqual({
      agent_id: 'a1',
      turn_id: 3,
      mode: 'plan',
    });
  });

  it('each binding emits with its own fragment', () => {
    const appender = new CapturingAppender();
    const root = serviceWithAppenders(appender);
    const first = root.createScopeBinding({ agent_id: 'a1', mode: 'agent' });
    first.telemetry.setContext({ provider_type: 'old-provider' });
    root.createScopeBinding({
      agent_id: 'a1',
      mode: 'plan',
      provider_type: 'new-provider',
    });
    first.telemetry.track2('turn_ended', {
      turn_id: 7,
      reason: 'completed',
      duration_ms: 1,
      mode: 'agent',
    });
    expect(appender.records[0]?.properties).toEqual({
      agent_id: 'a1',
      turn_id: 7,
      reason: 'completed',
      duration_ms: 1,
      mode: 'agent',
      provider_type: 'old-provider',
    });
  });
});

describe('ITelemetryService (scoped)', () => {
  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.App,
      ITelemetryService,
      TelemetryService,
      ScopeActivation.OnScopeCreated,
      'telemetry',
    );
  });

  it('resolves from the App scope', () => {
    const host = createScopedTestHost();
    const svc = host.app.accessor.get(ITelemetryService);
    expect(() => svc.track2('session_ended', { reason: 'exit' })).not.toThrow();
    host.dispose();
  });
});
