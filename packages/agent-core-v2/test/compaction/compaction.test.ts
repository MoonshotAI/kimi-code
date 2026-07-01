import { describe, expect, it } from 'vitest';

import { CompactionService } from '#/compaction/compactionService';
import { ContextService } from '#/context/contextService';
import { InjectionService } from '#/injection/injectionService';
import { LoopRunner } from '#/turn/loopRunner';
import { TurnService } from '#/turn/turnService';

function makeTurn(): TurnService {
  return new TurnService(
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    new LoopRunner(),
  );
}

describe('CompactionService', () => {
  it('injects a compaction summary when token usage exceeds the threshold', async () => {
    const ctx = new ContextService(undefined as never);
    ctx.appendMessage({ role: 'user', content: 'x'.repeat(100) });
    const injection = new InjectionService(ctx);
    const turn = makeTurn();
    const compaction = new CompactionService(
      ctx,
      undefined as never,
      undefined as never,
      undefined as never,
      turn,
      injection,
      10,
    );
    await turn.prompt('go');
    expect(injection.flush()).toEqual([
      { kind: 'compaction_summary', content: 'context overflow — compact pending' },
    ]);
    compaction.dispose();
  });

  it('does nothing below the threshold', async () => {
    const ctx = new ContextService(undefined as never);
    ctx.appendMessage({ role: 'user', content: 'hi' });
    const injection = new InjectionService(ctx);
    const turn = makeTurn();
    const compaction = new CompactionService(
      ctx,
      undefined as never,
      undefined as never,
      undefined as never,
      turn,
      injection,
      10_000,
    );
    await turn.prompt('go');
    expect(injection.flush()).toEqual([]);
    compaction.dispose();
  });
});
