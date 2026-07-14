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
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { AgentContextInjectorService } from '#/agent/contextInjector/contextInjectorService';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { AgentSystemReminderService } from '#/agent/systemReminder/systemReminderService';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentWireService } from '#/wire/tokens';
import { registerContextMemoryServices, type StubContextMemory } from '../contextMemory/stubs';
import { stubLoopWithHooks, stubWire } from '../loop/stubs';

type InjectableContextInjector = IAgentContextInjectorService & {
  inject(): Promise<void>;
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

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      base: [registerContextMemoryServices],
      strict: true,
      additionalServices: (reg) => {
        reg.defineInstance(IAgentLoopService, stubLoopWithHooks());
        reg.defineInstance(IAgentWireService, stubWire());
        reg.define(IAgentSystemReminderService, AgentSystemReminderService);
        reg.define(IAgentContextInjectorService, AgentContextInjectorService);
      },
    });
    context = ix.get(IAgentContextMemoryService);
  });

  afterEach(() => {
    disposables.dispose();
  });

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

    await injector(ix).inject();

    expect(seen).toEqual([null]);
    expect(lastText(context)).toContain('<system-reminder>');
    expect(lastText(context)).toContain('recorded reminder');
    expect(context.get().at(-1)?.origin).toEqual({
      kind: 'injection',
      variant: 'recording_test',
    });
  });

  it('appends provider content parts verbatim without system-reminder wrapping', async () => {
    injector(ix).register('media_test', () => [
      { type: 'text', text: 'caption' },
      { type: 'image_url', imageUrl: { url: 'https://example.com/a.png' } },
    ]);

    await injector(ix).inject();

    const message = context.get().at(-1);
    expect(message?.content).toEqual([
      { type: 'text', text: 'caption' },
      { type: 'image_url', imageUrl: { url: 'https://example.com/a.png' } },
    ]);
    expect(message?.origin).toEqual({ kind: 'injection', variant: 'media_test' });
  });

  it('skips injection when the provider returns an empty content array', async () => {
    injector(ix).register('empty_test', () => []);

    await injector(ix).inject();

    expect(context.get()).toHaveLength(0);
  });

  it('passes the previous injection index back to the provider', async () => {
    const seen: Array<number | null> = [];

    injector(ix).register('recording_test', ({ lastInjectedAt }) => {
      seen.push(lastInjectedAt);
      return lastInjectedAt === null ? 'recorded reminder' : undefined;
    });

    await injector(ix).inject();
    await injector(ix).inject();

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

    await injector(ix).inject();
    spliceContext(1, 0, [userMessage('between reminders')]);
    await injector(ix).inject();
    await injector(ix).inject();

    expect(seen).toEqual([[], [0], [0, 2]]);
  });

  it('falls back to the previous surviving copy when the newest injection is deleted', async () => {
    const seen: Array<number | null> = [];

    injector(ix).register('recording_test', ({ lastInjectedAt }) => {
      seen.push(lastInjectedAt);
      return seen.length <= 2 ? 'recorded reminder' : undefined;
    });

    await injector(ix).inject();
    spliceContext(1, 0, [userMessage('between reminders')]);
    await injector(ix).inject();
    spliceContext(2, 1, []);
    await injector(ix).inject();

    expect(seen).toEqual([null, 0, 0]);
    expect(context.get().map((message) => message.origin?.kind)).toEqual([
      'injection',
      'user',
    ]);
  });

  it('resets the stored injection index after context clear', async () => {
    const seen: Array<number | null> = [];

    injector(ix).register('recording_test', ({ lastInjectedAt }) => {
      seen.push(lastInjectedAt);
      return lastInjectedAt === null ? 'recorded reminder' : undefined;
    });

    await injector(ix).inject();
    spliceContext(0, context.get().length, []);
    await injector(ix).inject();

    expect(seen).toEqual([null, null]);
    expect(context.get()).toHaveLength(1);
    expect(context.get()[0]?.origin).toEqual({
      kind: 'injection',
      variant: 'recording_test',
    });
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

    await injector(ix).inject();
    spliceContext(0, context.get().length, []);
    await injector(ix).inject();

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

    await injector(ix).inject();
    spliceContext(
      0,
      2,
      [compactionSummary('Compacted summary.')],
    );
    await injector(ix).inject();

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

    await injector(ix).inject();
    spliceContext(0, 2, [compactionSummary('Compacted summary.')]);
    await injector(ix).inject();

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

    await injector(ix).inject();
    await injector(ix).inject();
    spliceContext(0, 1, [compactionSummary('Compacted summary.')]);
    await injector(ix).injectAfterCompaction();

    expect(seen).toEqual([true, false, true]);
    expect(context.get().map((message) => message.origin)).toEqual([
      { kind: 'compaction_summary' },
      { kind: 'injection', variant: 'per_turn_test' },
    ]);
  });
});
