/**
 * Scenario: agent context injection position tracking and wire restoration.
 *
 * Exercises the real injector through its service contract with in-memory
 * context, loop, reminder, event-bus, and wire collaborators.
 * Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/agent/contextInjector/contextInjector.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import {
  createServices,
  type TestInstantiationService,
} from '#/_base/di/test';
import {
  IAgentContextInjectorService,
  type SyncContextInjectionProvider,
} from '#/agent/contextInjector/contextInjector';
import { AgentContextInjectorService } from '#/agent/contextInjector/contextInjectorService';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { AgentSystemReminderService } from '#/agent/systemReminder/systemReminderService';
import { IEventBus } from '#/app/event/eventBus';
import { IWireService } from '#/wire/wire';
import { registerLogServices } from '../../_base/log/stubs';
import { registerContextMemoryServices, type StubContextMemory } from '../contextMemory/stubs';
import {
  runWillBeginStepHooks,
  type StubLoop,
  stubLoopWithHooks,
  stubWire,
} from '../loop/stubs';

type InjectableContextInjector = IAgentContextInjectorService & {
  inject(boundary: undefined, isNewTurn: boolean): Promise<void>;
};

function injector(ix: TestInstantiationService): InjectableContextInjector {
  return ix.get(IAgentContextInjectorService) as InjectableContextInjector;
}

function userMessage(text: string): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    toolCalls: [],
    origin: { kind: 'user' },
  };
}

function compactionSummary(text: string): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    toolCalls: [],
    origin: { kind: 'compaction_summary' },
  };
}

function lastText(context: IAgentContextMemoryService): string | undefined {
  const message = context.get().at(-1);
  const part = message?.content[0];
  return part?.type === 'text' ? part.text : undefined;
}

describe('AgentContextInjectorService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let context: IAgentContextMemoryService;
  let loop: StubLoop;

  beforeEach(() => {
    disposables = new DisposableStore();
    loop = stubLoopWithHooks();
    ix = createServices(disposables, {
      base: [registerContextMemoryServices, registerLogServices],
      strict: true,
      additionalServices: (reg) => {
        reg.defineInstance(IAgentLoopService, loop);
        reg.defineInstance(IWireService, stubWire());
        reg.defineInstance(IAgentStateService, new AgentStateService());
        reg.define(IAgentSystemReminderService, AgentSystemReminderService);
        reg.define(IAgentContextInjectorService, AgentContextInjectorService);
      },
    });
    context = ix.get(IAgentContextMemoryService);
  });

  afterEach(() => {
    disposables.dispose();
  });

  async function runInjectionStep(firstStepOfTurn = false): Promise<void> {
    await runWillBeginStepHooks(loop, firstStepOfTurn);
  }

  function spliceContext(
    start: number,
    deleteCount: number,
    inserted: readonly ContextMessage[],
  ): void {
    const backing = (context as StubContextMemory).messages as ContextMessage[];
    backing.splice(start, deleteCount, ...inserted);
    ix.get(IEventBus).publish({
      type: 'context.spliced',
      start,
      deleteCount,
      messages: [...inserted],
    });
  }

  it('registers providers and appends injection messages with the provider variant', async () => {
    const seen: Array<number | null> = [];

    injector(ix).register('recording_test', ({ lastInjectedAt }) => {
      seen.push(lastInjectedAt);
      return 'recorded reminder';
    });

    await runInjectionStep();

    expect(seen).toEqual([null]);
    expect(lastText(context)).toContain('<system-reminder>');
    expect(lastText(context)).toContain('recorded reminder');
    expect(context.get().at(-1)?.origin).toEqual({
      kind: 'injection',
      variant: 'recording_test',
    });
  });

  it('persists provider disclosure metadata on the injected message origin', async () => {
    injector(ix).register('date_test', () => ({
      content: 'date reminder',
      disclosure: {
        kind: 'date',
        renderGeneration: 4,
        localDate: '2026-07-29',
        timeZone: 'Asia/Shanghai',
      },
    }));

    await runInjectionStep();

    expect(context.get().at(-1)?.origin).toEqual({
      kind: 'injection',
      variant: 'date_test',
      disclosure: {
        kind: 'date',
        renderGeneration: 4,
        localDate: '2026-07-29',
        timeZone: 'Asia/Shanghai',
      },
    });
  });

  it('appends provider content parts verbatim without system-reminder wrapping', async () => {
    injector(ix).register('media_test', () => [
      { type: 'text', text: 'caption' },
      { type: 'image_url', imageUrl: { url: 'https://example.com/a.png' } },
    ]);

    await runInjectionStep();

    const message = context.get().at(-1);
    expect(message?.content).toEqual([
      { type: 'text', text: 'caption' },
      { type: 'image_url', imageUrl: { url: 'https://example.com/a.png' } },
    ]);
    expect(message?.origin).toEqual({ kind: 'injection', variant: 'media_test' });
  });

  it('skips injection when the provider returns an empty content array', async () => {
    injector(ix).register('empty_test', () => []);

    await runInjectionStep();

    expect(context.get()).toHaveLength(0);
  });

  it('passes the previous injection index back to the provider', async () => {
    const seen: Array<number | null> = [];

    injector(ix).register('recording_test', ({ lastInjectedAt }) => {
      seen.push(lastInjectedAt);
      return lastInjectedAt === null ? 'recorded reminder' : undefined;
    });

    await runInjectionStep();
    await runInjectionStep();

    expect(seen).toEqual([null, 0]);
    expect(context.get()).toHaveLength(1);
  });

  it('exposes all live injection positions alongside the newest one', async () => {
    const seen: Array<readonly number[]> = [];

    injector(ix).register('recording_test', ({ injectedPositions, lastInjectedAt }) => {
      seen.push(injectedPositions);
      expect(lastInjectedAt).toBe(injectedPositions.at(-1) ?? null);
      return seen.length <= 2 ? 'recorded reminder' : undefined;
    });

    await runInjectionStep();
    spliceContext(1, 0, [userMessage('between reminders')]);
    await runInjectionStep();
    await runInjectionStep();

    expect(seen).toEqual([[], [0], [0, 2]]);
  });

  it('falls back to the previous surviving copy when the newest injection is deleted', async () => {
    const seen: Array<number | null> = [];

    injector(ix).register('recording_test', ({ lastInjectedAt }) => {
      seen.push(lastInjectedAt);
      return seen.length <= 2 ? 'recorded reminder' : undefined;
    });

    await runInjectionStep();
    spliceContext(1, 0, [userMessage('between reminders')]);
    await runInjectionStep();
    spliceContext(2, 1, []);
    await runInjectionStep();

    expect(seen).toEqual([null, 0, 0]);
    expect(context.get().map((message) => message.origin?.kind)).toEqual([
      'injection',
      'user',
    ]);
  });

  it('resets every stored injection index after context clear', async () => {
    const seenA: Array<number | null> = [];
    const seenB: Array<number | null> = [];

    injector(ix).register('recording_a', ({ lastInjectedAt }) => {
      seenA.push(lastInjectedAt);
      return lastInjectedAt === null ? 'recorded reminder A' : undefined;
    });
    injector(ix).register('recording_b', ({ lastInjectedAt }) => {
      seenB.push(lastInjectedAt);
      return lastInjectedAt === null ? 'recorded reminder B' : undefined;
    });

    await runInjectionStep();
    spliceContext(0, context.get().length, []);
    await runInjectionStep();

    expect(seenA).toEqual([null, null]);
    expect(seenB).toEqual([null, null]);
    expect(context.get().map((message) => message.origin)).toEqual([
      { kind: 'injection', variant: 'recording_a' },
      { kind: 'injection', variant: 'recording_b' },
    ]);
  });

  it('re-injects at the next step after compaction swallows the reminder', async () => {
    const seen: Array<number | null> = [];

    context.append(userMessage('before reminder'));
    injector(ix).register('recording_test', ({ lastInjectedAt }) => {
      seen.push(lastInjectedAt);
      return lastInjectedAt === null ? 'recorded reminder' : undefined;
    });

    await runInjectionStep();
    spliceContext(
      0,
      2,
      [compactionSummary('Compacted summary.')],
    );
    await runInjectionStep();

    expect(seen).toEqual([null, null]);
    expect(context.get().map((message) => message.origin)).toEqual([
      { kind: 'compaction_summary' },
      { kind: 'injection', variant: 'recording_test' },
    ]);
  });

  it('keeps every injection index aligned after compaction preserves injected messages', async () => {
    const seenA: Array<number | null> = [];
    const seenB: Array<number | null> = [];

    context.append(
      userMessage('old request'),
      userMessage('old follow-up'),
    );
    injector(ix).register('recording_a', ({ lastInjectedAt }) => {
      seenA.push(lastInjectedAt);
      return lastInjectedAt === null ? 'recorded reminder A' : undefined;
    });
    injector(ix).register('recording_b', ({ lastInjectedAt }) => {
      seenB.push(lastInjectedAt);
      return lastInjectedAt === null ? 'recorded reminder B' : undefined;
    });

    await runInjectionStep();
    spliceContext(0, 2, [compactionSummary('Compacted summary.')]);
    await runInjectionStep();

    expect(seenA).toEqual([null, 1]);
    expect(seenB).toEqual([null, 2]);
    expect(context.get().map((message) => message.origin)).toEqual([
      { kind: 'compaction_summary' },
      { kind: 'injection', variant: 'recording_a' },
      { kind: 'injection', variant: 'recording_b' },
    ]);
  });

  it('re-arms per-turn providers when injectAfterCompaction runs', async () => {
    const seen: boolean[] = [];
    injector(ix).register('per_turn_test', ({ isNewTurn }) => {
      seen.push(isNewTurn);
      return isNewTurn ? 'per-turn reminder' : undefined;
    });

    await runInjectionStep(true);
    await runInjectionStep();
    spliceContext(0, 1, [compactionSummary('Compacted summary.')]);
    await injector(ix).injectAfterCompaction();

    expect(seen).toEqual([true, false, true]);
    expect(context.get().map((message) => message.origin)).toEqual([
      { kind: 'compaction_summary' },
      { kind: 'injection', variant: 'per_turn_test' },
    ]);
  });

  it('keeps the first step marked as a new turn when compaction lands in between', async () => {
    const seen: boolean[] = [];
    injector(ix).register('per_turn_test', ({ isNewTurn }) => {
      seen.push(isNewTurn);
      return undefined;
    });

    ix.get(IEventBus).publish({
      type: 'turn.started',
      turnId: 0,
      origin: { kind: 'user' },
    });
    await injector(ix).injectAfterCompaction();
    await runInjectionStep(true);

    expect(seen).toEqual([true, true]);
  });

  it('delivers one new-turn injection when compaction fires inside the step hook chain', async () => {
    const seen: boolean[] = [];
    injector(ix).register('per_turn_test', ({ isNewTurn }) => {
      seen.push(isNewTurn);
      return undefined;
    });
    loop.hooks.onWillBeginStep.register('test-compaction', async (_ctx, next) => {
      await injector(ix).injectAfterCompaction();
      await next();
    });

    await runInjectionStep(true);

    expect(seen).toEqual([true, false]);
  });

  it('drains once-channels before running the providers', async () => {
    const calls: string[] = [];
    injector(ix).registerOnceChannel('test_channel', () => {
      calls.push('once-channel');
    });
    injector(ix).register('ordering_test', () => {
      calls.push('provider');
      return undefined;
    });

    await injector(ix).inject(undefined, false);

    expect(calls).toEqual(['once-channel', 'provider']);
  });

  it('skips a throwing once-channel drain and still runs the rest', async () => {
    const calls: string[] = [];
    injector(ix).registerOnceChannel('throwing_channel', () => {
      throw new Error('boom');
    });
    injector(ix).registerOnceChannel('surviving_channel', () => {
      calls.push('surviving');
    });
    injector(ix).register('ordering_test', () => {
      calls.push('provider');
      return undefined;
    });

    await injector(ix).inject(undefined, false);

    expect(calls).toEqual(['surviving', 'provider']);
  });

  it('appends tagged raw messages verbatim with the injection origin stamped', async () => {
    injector(ix).register('schema_test', () => ({
      message: {
        role: 'system',
        content: [],
        tools: [{ name: 'TestTool', description: 'test tool', parameters: { type: 'object' } }],
      },
    }));

    await runInjectionStep();

    const message = context.get().at(-1);
    expect(message?.role).toBe('system');
    expect(message?.tools).toEqual([
      { name: 'TestTool', description: 'test tool', parameters: { type: 'object' } },
    ]);
    expect(message?.origin).toEqual({ kind: 'injection', variant: 'schema_test' });
  });

  it('stamps the disclosure on tagged raw messages returned through the result wrapper', async () => {
    injector(ix).register('schema_test', () => ({
      content: { message: { role: 'user', content: [{ type: 'text', text: 'raw' }] } },
      disclosure: { kind: 'once_reminder', id: 'r1' },
    }));

    await runInjectionStep();

    expect(context.get().at(-1)?.origin).toEqual({
      kind: 'injection',
      variant: 'schema_test',
      disclosure: { kind: 'once_reminder', id: 'r1' },
    });
  });

  it('skips tagged raw messages with neither content nor tools', async () => {
    injector(ix).register('empty_raw_test', () => ({ message: { role: 'system', content: [] } }));

    await runInjectionStep();

    expect(context.get()).toHaveLength(0);
  });

  it('runs synchronous turn-start providers before the next prompt materializes', () => {
    injector(ix).registerAtTurnStart('turn_start_test', () => 'turn-start reminder');

    ix.get(IEventBus).publish({
      type: 'turn.started',
      turnId: 0,
      origin: { kind: 'user' },
    });

    expect(context.get()).toHaveLength(1);
    expect(lastText(context)).toContain('turn-start reminder');
  });

  it('skips a throwing step provider and still runs the rest', async () => {
    injector(ix).register('step_throwing', () => {
      throw new Error('boom');
    });
    injector(ix).register('step_surviving', () => 'surviving reminder');

    await runInjectionStep();

    expect(context.get()).toHaveLength(1);
    expect(lastText(context)).toContain('surviving reminder');
  });

  it('skips a rejecting step provider and still runs the rest', async () => {
    injector(ix).register('step_rejecting', () => Promise.reject(new Error('boom')));
    injector(ix).register('step_surviving', () => 'surviving reminder');

    await runInjectionStep();

    expect(context.get()).toHaveLength(1);
    expect(lastText(context)).toContain('surviving reminder');
  });

  it('skips a throwing turn-start provider and still runs the rest', () => {
    injector(ix).registerAtTurnStart('turn_start_throwing', () => {
      throw new Error('boom');
    });
    injector(ix).registerAtTurnStart('turn_start_surviving', () => 'surviving reminder');

    ix.get(IEventBus).publish({
      type: 'turn.started',
      turnId: 0,
      origin: { kind: 'user' },
    });

    expect(context.get()).toHaveLength(1);
    expect(lastText(context)).toContain('surviving reminder');
  });

  it('skips a Promise-returning turn-start provider and still runs the rest', () => {
    injector(ix).registerAtTurnStart(
      'turn_start_async',
      (() => Promise.resolve('async reminder')) as unknown as SyncContextInjectionProvider,
    );
    injector(ix).registerAtTurnStart('turn_start_surviving', () => 'surviving reminder');

    ix.get(IEventBus).publish({
      type: 'turn.started',
      turnId: 0,
      origin: { kind: 'user' },
    });

    expect(context.get()).toHaveLength(1);
    expect(lastText(context)).toContain('surviving reminder');
  });
});
