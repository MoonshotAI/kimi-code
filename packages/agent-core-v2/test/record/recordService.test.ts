import { describe, expect, it, vi } from 'vitest';

import { DisposableStore, toDisposable } from '#/_base/di';
import { createServices } from '#/_base/di/test';
import { OrderedHookSlot } from '#/hooks';
import { IAgentEventSinkService } from '#/agent/eventSink';
import { IAgentReplayBuilderService } from '#/agent/replayBuilder';
import { IAgentWireRecordService } from '#/agent/wireRecord';
import type { WireRecord, WireRecordRestoredContext } from '#/agent/wireRecord';
import {
  AgentRecordService,
  IAgentRecordService,
  type AgentRecord,
} from '#/agent/record';
import type { AgentEvent } from '@moonshot-ai/protocol';
import type { AgentReplayRecord, AgentReplayRecordPayload } from '#/agent/replayBuilder/types';

declare module '#/agent/record' {
  interface AgentRecordMap {
    'test.fact': { value: number };
  }
}

interface StubHost {
  readonly record: IAgentRecordService;
  readonly wire: ReturnType<typeof createWireStub>;
  readonly eventSink: ReturnType<typeof createEventSinkStub>;
  readonly replay: ReturnType<typeof createReplayStub>;
  readonly dispose: () => void;
}

function createWireStub() {
  const appended: unknown[] = [];
  const resumers = new Map<string, (record: unknown) => void | Promise<void>>();
  const hooks = {
    onRestoredRecord: new OrderedHookSlot<WireRecordRestoredContext>(),
    onResumeEnded: new OrderedHookSlot<{}>(),
  };
  let restoring: { time?: number } | null = null;
  return {
    appended,
    resumers,
    hooks,
    append: vi.fn((record: unknown) => appended.push(record)),
    register: vi.fn((type: string, resumer: (record: unknown) => void | Promise<void>) => {
      resumers.set(type, resumer);
      return toDisposable(() => resumers.delete(type));
    }),
    restore: vi.fn(async () => ({}) as { warning?: string }),
    flush: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    get restoring() {
      return restoring;
    },
    setRestoring(value: { time?: number } | null) {
      restoring = value;
    },
    postRestoring: false,
  };
}

function createEventSinkStub() {
  const emitted: AgentEvent[] = [];
  return {
    emitted,
    emit: vi.fn((event: AgentEvent) => emitted.push(event)),
    on: vi.fn(() => toDisposable(() => {})),
  };
}

function createReplayStub() {
  const records: AgentReplayRecord[] = [];
  return {
    records,
    push: vi.fn((record: AgentReplayRecordPayload) =>
      records.push(record as unknown as AgentReplayRecord),
    ),
    buildResult: vi.fn(() => records),
    captureLiveRecords: false,
    postRestoring: false,
  };
}

function createHost(): StubHost {
  const wire = createWireStub();
  const eventSink = createEventSinkStub();
  const replay = createReplayStub();
  const disposables = new DisposableStore();
  const services = createServices(disposables, {
    additionalServices: (reg) => {
      reg.definePartialInstance(IAgentWireRecordService, wire);
      reg.definePartialInstance(IAgentEventSinkService, eventSink);
      reg.definePartialInstance(IAgentReplayBuilderService, replay);
      reg.define(IAgentRecordService, AgentRecordService);
    },
  });
  return {
    record: services.get(IAgentRecordService),
    wire,
    eventSink,
    replay,
    dispose: () => disposables.dispose(),
  };
}

describe('AgentRecordService facade', () => {
  it('append fans out to durable + live + replay facets', () => {
    const host = createHost();
    host.record.define('test.fact', {
      toLive: (r) => ({ type: 'test.live', value: r.value }) as unknown as AgentEvent,
      toReplay: (r) =>
        ({ type: 'message', value: r.value }) as unknown as AgentReplayRecordPayload,
    });

    host.record.append({ type: 'test.fact', value: 42 });

    expect(host.wire.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'test.fact', value: 42 }),
    );
    expect(host.eventSink.emitted).toContainEqual(
      expect.objectContaining({ type: 'test.live', value: 42 }),
    );
    expect(host.replay.records).toContainEqual(
      expect.objectContaining({ type: 'message', value: 42 }),
    );
    host.dispose();
  });

  it('append omits facets that are not declared', () => {
    const host = createHost();
    host.record.define('test.fact', {});

    host.record.append({ type: 'test.fact', value: 1 });

    expect(host.wire.append).toHaveBeenCalledTimes(1);
    expect(host.eventSink.emit).not.toHaveBeenCalled();
    expect(host.replay.push).not.toHaveBeenCalled();
    host.dispose();
  });

  it('signal emits live only and never persists or captures replay', () => {
    const host = createHost();
    host.record.signal({ type: 'test.delta', delta: 'x' } as unknown as AgentEvent);

    expect(host.eventSink.emitted).toContainEqual(
      expect.objectContaining({ type: 'test.delta', delta: 'x' }),
    );
    expect(host.wire.append).not.toHaveBeenCalled();
    expect(host.replay.push).not.toHaveBeenCalled();
    host.dispose();
  });

  it('define registers the resumer with wireRecord and forwards the record', async () => {
    const host = createHost();
    const resume = vi.fn();
    host.record.define('test.fact', { resume });

    expect(host.wire.register).toHaveBeenCalledWith('test.fact', expect.any(Function));
    const registered = host.wire.resumers.get('test.fact');
    expect(registered).toBeDefined();
    await registered?.({ type: 'test.fact', value: 7 });

    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ value: 7 }));
    host.dispose();
  });

  it('captures replay during restore through the onRestoredRecord hook', async () => {
    const host = createHost();
    host.record.define('test.fact', {
      toReplay: (r) =>
        ({ type: 'message', value: r.value }) as unknown as AgentReplayRecordPayload,
    });
    host.wire.setRestoring({ time: 123 });

    await host.wire.hooks.onRestoredRecord.run({
      record: { type: 'test.fact', value: 5 } as unknown as WireRecord,
      stop: false,
    });

    expect(host.replay.records).toContainEqual(
      expect.objectContaining({ type: 'message', value: 5 }),
    );
    host.dispose();
  });

  it('on() delegates to the live event sink', () => {
    const host = createHost();
    const handler = vi.fn();
    host.record.on(handler);
    expect(host.eventSink.on).toHaveBeenCalledWith(handler);
    host.dispose();
  });

  it('dispose returned by define unregisters the resumer and facets', () => {
    const host = createHost();
    const subscription = host.record.define('test.fact', { resume: vi.fn() });
    expect(host.wire.resumers.has('test.fact')).toBe(true);

    subscription.dispose();

    expect(host.wire.resumers.has('test.fact')).toBe(false);
    // Facet removed: append should no longer fan out (still persists).
    host.record.append({ type: 'test.fact', value: 1 });
    expect(host.wire.append).toHaveBeenCalledTimes(1);
    host.dispose();
  });
});
