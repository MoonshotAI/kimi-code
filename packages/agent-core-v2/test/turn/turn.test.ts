import { describe, expect, it } from 'vitest';

import { LoopRunner } from '#/turn/loopRunner';
import { TurnService } from '#/turn/turnService';

function make(): TurnService {
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

describe('TurnService', () => {
  it('launch emits start → step → end and tracks active state', async () => {
    const svc = make();
    const events: string[] = [];
    svc.onWillStartTurn((e) => events.push(`start:${e.turnId}`));
    svc.onDidEndStep((e) => events.push(`step:${e.step}`));
    svc.onDidEndTurn((e) => events.push(`end:${e.reason}`));

    expect(svc.hasActiveTurn).toBe(false);
    await svc.prompt('hello');
    expect(svc.hasActiveTurn).toBe(false);
    expect(events).toEqual(['start:turn-0', 'step:0', 'end:completed']);
  });

  it('steer buffers input', () => {
    const svc = make();
    svc.steer('a');
    svc.steer('b', 'user');
    // buffer is internal; ensure it does not throw and no turn is active
    expect(svc.hasActiveTurn).toBe(false);
  });

  it('cancel fires onDidEndTurn with cancelled reason', async () => {
    const svc = make();
    const ends: string[] = [];
    svc.onDidEndTurn((e) => ends.push(e.reason));
    // launch a turn that we cancel mid-flight via a slow loop runner
    const slow = new (class extends LoopRunner {
      override run(): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, 10));
      }
    })();
    const svc2 = new TurnService(
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      slow,
    );
    svc2.onDidEndTurn((e) => ends.push(e.reason));
    const p = svc2.prompt('hello');
    expect(svc2.hasActiveTurn).toBe(true);
    svc2.cancel('user');
    await p;
    expect(ends).toContain('user');
  });
});
