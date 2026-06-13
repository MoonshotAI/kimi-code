import { describe, expect, it } from 'vitest';

import { DynamicInjector } from '../../../src/agent/injection/injector';
import { InjectionManager } from '../../../src/agent/injection/manager';
import { TodoListReminderInjector } from '../../../src/agent/injection/todo-list';
import { testAgent } from '../harness/agent';

class RecordingInjector extends DynamicInjector {
  override readonly injectionVariant = 'recording_test';
  compactionCalls = 0;
  clearCalls = 0;

  override onContextClear(): void {
    this.clearCalls += 1;
    super.onContextClear();
  }

  override onContextCompacted(compactedCount: number): void {
    this.compactionCalls += 1;
    super.onContextCompacted(compactedCount);
  }

  protected override getInjection(): string | undefined {
    return undefined;
  }
}

class BoomInjector extends DynamicInjector {
  override readonly injectionVariant = 'boom_test';

  override onContextCompacted(_compactedCount: number): void {
    throw new Error('boom-compact');
  }

  protected override getInjection(): string | undefined {
    return undefined;
  }
}

class ProbeInjector extends DynamicInjector {
  override readonly injectionVariant = 'probe_test';
  protected override getInjection(): string | undefined {
    return undefined;
  }
  setInjectedAt(value: number | null): void {
    (this as unknown as { injectedAt: number | null }).injectedAt = value;
  }
  getInjectedAt(): number | null {
    return (this as unknown as { injectedAt: number | null }).injectedAt;
  }
}

function installInjectors(manager: InjectionManager, injectors: DynamicInjector[]): void {
  (manager as unknown as { injectors: DynamicInjector[] }).injectors = injectors;
}

describe('InjectionManager.onContextCompacted', () => {
  it('notifies every registered injector when compaction occurs', () => {
    const ctx = testAgent();
    ctx.configure();
    const a = new RecordingInjector(ctx.agent);
    const b = new RecordingInjector(ctx.agent);
    installInjectors(ctx.agent.injection, [a, b]);

    ctx.agent.injection.onContextCompacted(3);

    expect(a.compactionCalls).toBe(1);
    expect(b.compactionCalls).toBe(1);
  });

  it('isolates compaction hook failures so later injectors still receive the notification', () => {
    const ctx = testAgent();
    ctx.configure();
    const recorder = new RecordingInjector(ctx.agent);
    installInjectors(ctx.agent.injection, [new BoomInjector(ctx.agent), recorder]);

    expect(() => {
      ctx.agent.injection.onContextCompacted(2);
    }).not.toThrow();
    expect(recorder.compactionCalls).toBe(1);
  });

  it('continues notifying surviving injectors on later compactions', () => {
    const ctx = testAgent();
    ctx.configure();
    const recorder = new RecordingInjector(ctx.agent);
    installInjectors(ctx.agent.injection, [new BoomInjector(ctx.agent), recorder]);

    expect(() => {
      ctx.agent.injection.onContextCompacted(1);
    }).not.toThrow();
    expect(recorder.compactionCalls).toBe(1);

    ctx.agent.injection.onContextCompacted(1);
    expect(recorder.compactionCalls).toBe(2);
  });

  it('replays context lifecycle records through ContextMemory only once', () => {
    const ctx = testAgent();
    ctx.configure();
    const recorder = new RecordingInjector(ctx.agent);
    installInjectors(ctx.agent.injection, [recorder]);

    ctx.agent.records.restore({ type: 'context.clear' });
    ctx.agent.records.restore({
      type: 'context.apply_compaction',
      summary: 'Compacted summary.',
      compactedCount: 2,
      tokensBefore: 10,
      tokensAfter: 4,
    });

    expect(recorder.clearCalls).toBe(1);
    expect(recorder.compactionCalls).toBe(1);
  });
});

describe('InjectionManager registration', () => {
  it('registers TodoListReminderInjector in the default injector chain', () => {
    const ctx = testAgent();
    ctx.configure();

    const injectors = (ctx.agent.injection as unknown as { injectors: DynamicInjector[] }).injectors;

    expect(injectors.some((injector) => injector instanceof TodoListReminderInjector)).toBe(true);
  });
});

describe('DynamicInjector.onContextCompacted index remapping', () => {
  it('remaps a surviving injection to its post-summary index', () => {
    const ctx = testAgent();
    const probe = new ProbeInjector(ctx.agent);
    probe.setInjectedAt(5); // old index 5
    probe.onContextCompacted(3); // first 3 messages folded into the summary at index 0
    expect(probe.getInjectedAt()).toBe(3); // 5 - 3 + 1
  });

  it('nulls an injection folded into the summary, including the last compacted message', () => {
    const ctx = testAgent();
    // Boundary: injectedAt === compactedCount - 1 was previously remapped to 0
    // (pointing at the summary) instead of null.
    const last = new ProbeInjector(ctx.agent);
    last.setInjectedAt(2);
    last.onContextCompacted(3); // indices 0..2 compacted away
    expect(last.getInjectedAt()).toBeNull();

    const earlier = new ProbeInjector(ctx.agent);
    earlier.setInjectedAt(0);
    earlier.onContextCompacted(3);
    expect(earlier.getInjectedAt()).toBeNull();
  });
});
