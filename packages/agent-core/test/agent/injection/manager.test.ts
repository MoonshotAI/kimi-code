import { describe, expect, it, vi } from 'vitest';

import type { BackgroundTaskInfo } from '../../../src/agent/background';
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

  override onContextCompacted(): void {
    this.compactionCalls += 1;
    super.onContextCompacted();
  }

  protected override getInjection(): string | undefined {
    return undefined;
  }
}

class BoomInjector extends DynamicInjector {
  override readonly injectionVariant = 'boom_test';

  override onContextCompacted(): void {
    throw new Error('boom-compact');
  }

  protected override getInjection(): string | undefined {
    return undefined;
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

    ctx.agent.injection.onContextCompacted();

    expect(a.compactionCalls).toBe(1);
    expect(b.compactionCalls).toBe(1);
  });

  it('isolates compaction hook failures so later injectors still receive the notification', () => {
    const ctx = testAgent();
    ctx.configure();
    const recorder = new RecordingInjector(ctx.agent);
    installInjectors(ctx.agent.injection, [new BoomInjector(ctx.agent), recorder]);

    expect(() => {
      ctx.agent.injection.onContextCompacted();
    }).not.toThrow();
    expect(recorder.compactionCalls).toBe(1);
  });

  it('continues notifying surviving injectors on later compactions', () => {
    const ctx = testAgent();
    ctx.configure();
    const recorder = new RecordingInjector(ctx.agent);
    installInjectors(ctx.agent.injection, [new BoomInjector(ctx.agent), recorder]);

    expect(() => {
      ctx.agent.injection.onContextCompacted();
    }).not.toThrow();
    expect(recorder.compactionCalls).toBe(1);

    ctx.agent.injection.onContextCompacted();
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

describe('InjectionManager.injectAfterCompaction — active background tasks', () => {
  const fakeTask = {
    taskId: 'process-abc123',
    kind: 'process',
    description: 'run the full test suite',
    status: 'running',
  } as unknown as BackgroundTaskInfo;

  function backgroundReminderTexts(agent: ReturnType<typeof testAgent>['agent']): string[] {
    return agent.context.history
      .filter(
        (message) =>
          message.origin?.kind === 'injection' &&
          message.origin.variant === 'background_task_status',
      )
      .map((message) =>
        message.content.map((part) => (part.type === 'text' ? part.text : '')).join(''),
      );
  }

  it('re-injects active background tasks after compaction (they were dropped from the folded context)', async () => {
    const ctx = testAgent();
    ctx.configure();
    vi.spyOn(ctx.agent.background, 'list').mockReturnValue([fakeTask]);

    await ctx.agent.injection.injectAfterCompaction();

    const texts = backgroundReminderTexts(ctx.agent);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('active_background_tasks');
  });

  it('injects nothing when there are no active background tasks', async () => {
    const ctx = testAgent();
    ctx.configure();
    vi.spyOn(ctx.agent.background, 'list').mockReturnValue([]);

    await ctx.agent.injection.injectAfterCompaction();

    expect(backgroundReminderTexts(ctx.agent)).toHaveLength(0);
  });
});
