import { describe, expect, it } from 'vitest';

import {
  IDynamicInjector,
  type ContextMessage,
} from '../../../../src/services/agent';
import { testAgent } from '../harness';

type InjectableDynamicInjector = {
  inject(): Promise<void>;
};

type DynamicInjectorInternals = {
  entries: Set<{ variant: string }>;
};

async function injectDynamic(ctx: ReturnType<typeof testAgent>): Promise<void> {
  await (ctx.get(IDynamicInjector) as unknown as InjectableDynamicInjector).inject();
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

function lastText(ctx: ReturnType<typeof testAgent>): string | undefined {
  const message = ctx.context.getHistory().at(-1);
  const part = message?.content[0];
  return part?.type === 'text' ? part.text : undefined;
}

describe('DynamicInjectorService', () => {
  it('registers providers and appends injection messages with the provider variant', async () => {
    const ctx = testAgent();
    ctx.configure();
    const seen: Array<number | null> = [];

    ctx.get(IDynamicInjector).register('recording_test', ({ injectedAt }) => {
      seen.push(injectedAt);
      return 'recorded reminder';
    });

    await injectDynamic(ctx);

    expect(seen).toEqual([null]);
    expect(lastText(ctx)).toContain('<system-reminder>');
    expect(lastText(ctx)).toContain('recorded reminder');
    expect(ctx.context.getHistory().at(-1)?.origin).toEqual({
      kind: 'injection',
      variant: 'recording_test',
    });
  });

  it('passes the previous injection index back to the provider', async () => {
    const ctx = testAgent();
    ctx.configure();
    const seen: Array<number | null> = [];

    ctx.get(IDynamicInjector).register('recording_test', ({ injectedAt }) => {
      seen.push(injectedAt);
      return injectedAt === null ? 'recorded reminder' : undefined;
    });

    await injectDynamic(ctx);
    await injectDynamic(ctx);

    expect(seen).toEqual([null, 0]);
    expect(ctx.context.getHistory()).toHaveLength(1);
  });

  it('resets the stored injection index after context clear', async () => {
    const ctx = testAgent();
    ctx.configure();
    const seen: Array<number | null> = [];

    ctx.get(IDynamicInjector).register('recording_test', ({ injectedAt }) => {
      seen.push(injectedAt);
      return injectedAt === null ? 'recorded reminder' : undefined;
    });

    await injectDynamic(ctx);
    ctx.context.spliceHistory(0, ctx.context.getHistory().length, []);
    await injectDynamic(ctx);

    expect(seen).toEqual([null, null]);
    expect(ctx.context.getHistory()).toHaveLength(1);
    expect(ctx.context.getHistory()[0]?.origin).toEqual({
      kind: 'injection',
      variant: 'recording_test',
    });
  });

  it('keeps the injection index aligned after compaction replaces the prefix', async () => {
    const ctx = testAgent();
    ctx.configure();
    const seen: Array<number | null> = [];

    ctx.context.spliceHistory(0, 0, [userMessage('before reminder')]);
    ctx.get(IDynamicInjector).register('recording_test', ({ injectedAt }) => {
      seen.push(injectedAt);
      return injectedAt === null ? 'recorded reminder' : undefined;
    });

    await injectDynamic(ctx);
    ctx.context.spliceHistory(
      0,
      2,
      [compactionSummary('Compacted summary.')],
    );
    await injectDynamic(ctx);

    expect(seen).toEqual([null, 0]);
    expect(ctx.context.getHistory()).toHaveLength(1);
    expect(ctx.context.getHistory()[0]?.origin).toEqual({ kind: 'compaction_summary' });
  });
});

describe('DynamicInjectorService registration', () => {
  it('registers the todo-list reminder in the default injector chain', () => {
    const ctx = testAgent();
    ctx.configure();

    const entries = [
      ...(ctx.get(IDynamicInjector) as unknown as DynamicInjectorInternals).entries,
    ];

    expect(entries.some((entry) => entry.variant === 'todo_list_reminder')).toBe(true);
  });
});
