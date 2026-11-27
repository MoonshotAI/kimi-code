import { describe, expect, it } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import type { ChatTurn, ToolCall } from '@moonshot-ai/app-core/client/types';

import { useFileStaleness } from '../src/composables/useFileStaleness';

function tool(over: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 't1',
    name: 'Edit',
    arg: JSON.stringify({ path: '/repo/src/a.ts', old_string: 'x', new_string: 'y' }),
    status: 'ok',
    ...over,
  } as ToolCall;
}

function turn(over: Partial<ChatTurn> = {}): ChatTurn {
  return { id: 'turn-1', role: 'assistant', no: 1, text: '', ...over } as ChatTurn;
}

const PATH = '/repo/src/a.ts';

let testSessionSeq = 0;
function testSessionId(): string {
  return `test-session-${++testSessionSeq}`;
}

describe('useFileStaleness', () => {
  it('flags stale when an edit lands after the load snapshot', async () => {
    const scope = effectScope();
    await scope.run(async () => {
      const t0 = turn({ id: 'turn-0' });
      const turns = ref<ChatTurn[]>([t0]);
      const tracker = useFileStaleness({ turns, sessionId: ref(testSessionId()), cwd: ref('/repo') }).createTracker('t', () => [PATH]);
      tracker.markLoaded();
      expect(tracker.stale.value).toBe(false);
      turns.value = [t0, turn({ id: 'turn-1', tools: [tool()] })];
      await nextTick();
      expect(tracker.stale.value).toBe(true);
    });
    scope.stop();
  });

  it('keeps the flag when the edit lands between request start and response', async () => {
    const scope = effectScope();
    await scope.run(async () => {
      const t0 = turn({ id: 'turn-0' });
      const turns = ref<ChatTurn[]>([t0]);
      const staleness = useFileStaleness({ turns, sessionId: ref(testSessionId()), cwd: ref('/repo') });
      const tracker = staleness.createTracker('t', () => [PATH]);
      const startMarkers = new Map(staleness.markers.value);
      turns.value = [t0, turn({ id: 'turn-1', tools: [tool()] })];
      await nextTick();
      tracker.markLoaded(startMarkers);
      expect(tracker.stale.value).toBe(true);
    });
    scope.stop();
  });

  it('ignores edits from turns prepended by pagination backfill', async () => {
    const scope = effectScope();
    await scope.run(async () => {
      const t1 = turn({ id: 'turn-1' });
      const turns = ref<ChatTurn[]>([t1]);
      const tracker = useFileStaleness({ turns, sessionId: ref(testSessionId()), cwd: ref('/repo') }).createTracker('t', () => [PATH]);
      tracker.markLoaded();
      turns.value = [turn({ id: 'turn-0', tools: [tool({ id: 'old' })] }), t1];
      await nextTick();
      expect(tracker.stale.value).toBe(false);
    });
    scope.stop();
  });

  it('keeps a legitimate stale flag when backfill arrives after a new edit', async () => {
    const scope = effectScope();
    await scope.run(async () => {
      const t1 = turn({ id: 'turn-1', tools: [tool({ id: 'a' })] });
      const turns = ref<ChatTurn[]>([t1]);
      const tracker = useFileStaleness({ turns, sessionId: ref(testSessionId()), cwd: ref('/repo') }).createTracker('t', () => [PATH]);
      tracker.markLoaded();
      const t2 = turn({ id: 'turn-2', tools: [tool({ id: 'b' })] });
      turns.value = [t1, t2];
      await nextTick();
      expect(tracker.stale.value).toBe(true);
      turns.value = [turn({ id: 'turn-0', tools: [tool({ id: 'c' })] }), t1, t2];
      await nextTick();
      expect(tracker.stale.value).toBe(true);
    });
    scope.stop();
  });

  it('keeps markers when their turns fall out of the transcript window', async () => {
    const scope = effectScope();
    await scope.run(async () => {
      const t1 = turn({ id: 'turn-1', tools: [tool({ id: 'a' })] });
      const t2 = turn({ id: 'turn-2' });
      const turns = ref<ChatTurn[]>([t1, t2]);
      const tracker = useFileStaleness({ turns, sessionId: ref(testSessionId()), cwd: ref('/repo') }).createTracker('t', () => [PATH]);
      tracker.markLoaded();
      turns.value = [t2];
      await nextTick();
      expect(tracker.stale.value).toBe(false);
      turns.value = [t2, turn({ id: 'turn-3', tools: [tool({ id: 'b' })] })];
      await nextTick();
      expect(tracker.stale.value).toBe(true);
    });
    scope.stop();
  });

  it('keeps markers across a disjoint transcript refresh within the same session', async () => {
    const scope = effectScope();
    await scope.run(async () => {
      const sessionId = ref(testSessionId());
      const t1 = turn({ id: 'turn-1', tools: [tool({ id: 'a' })] });
      const turns = ref<ChatTurn[]>([t1]);
      const tracker = useFileStaleness({ turns, sessionId, cwd: ref('/repo') }).createTracker('t', () => [PATH]);
      tracker.markLoaded();
      turns.value = [turn({ id: 'turn-9' }), turn({ id: 'turn-10' })];
      await nextTick();
      expect(tracker.stale.value).toBe(false);
      turns.value = [turn({ id: 'turn-10' }), turn({ id: 'turn-11', tools: [tool({ id: 'b' })] })];
      await nextTick();
      expect(tracker.stale.value).toBe(true);
    });
    scope.stop();
  });

  it('clears markers on session switch', async () => {
    const scope = effectScope();
    await scope.run(async () => {
      const sessionId = ref(testSessionId());
      const t1 = turn({ id: 'turn-1', tools: [tool({ id: 'a' })] });
      const turns = ref<ChatTurn[]>([t1]);
      const staleness = useFileStaleness({ turns, sessionId, cwd: ref('/repo') });
      staleness.createTracker('t', () => [PATH]).markLoaded();
      sessionId.value = testSessionId();
      turns.value = [];
      await nextTick();
      expect(staleness.markers.value.size).toBe(0);
    });
    scope.stop();
  });

  it('treats the first transcript baseline as history, not new edits', async () => {
    const scope = effectScope();
    await scope.run(async () => {
      const turns = ref<ChatTurn[]>([]);
      const tracker = useFileStaleness({ turns, sessionId: ref(testSessionId()), cwd: ref('/repo') }).createTracker('t', () => [PATH]);
      tracker.markLoaded();
      turns.value = [turn({ id: 'turn-1', tools: [tool({ id: 'a' })] })];
      await nextTick();
      expect(tracker.stale.value).toBe(false);
    });
    scope.stop();
  });

  it('restores a tracker snapshot across recreation (remount)', async () => {
    const scope = effectScope();
    await scope.run(async () => {
      const t0 = turn({ id: 'turn-0' });
      const turns = ref<ChatTurn[]>([t0]);
      const staleness = useFileStaleness({ turns, sessionId: ref(testSessionId()), cwd: ref('/repo') });
      const first = staleness.createTracker('diff', () => [PATH]);
      first.markLoaded();
      turns.value = [t0, turn({ id: 'turn-1', tools: [tool({ id: 'a' })] })];
      await nextTick();
      expect(first.stale.value).toBe(true);
      const second = staleness.createTracker('diff', () => [PATH]);
      expect(second.stale.value).toBe(true);
    });
    scope.stop();
  });

  it('clears saved snapshots on session switch', async () => {
    const scope = effectScope();
    await scope.run(async () => {
      const sessionId = ref(testSessionId());
      const t0 = turn({ id: 'turn-0' });
      const turns = ref<ChatTurn[]>([t0]);
      const staleness = useFileStaleness({ turns, sessionId, cwd: ref('/repo') });
      const first = staleness.createTracker('diff', () => [PATH]);
      first.markLoaded();
      turns.value = [t0, turn({ id: 'turn-1', tools: [tool({ id: 'a' })] })];
      await nextTick();
      expect(first.stale.value).toBe(true);
      sessionId.value = testSessionId();
      turns.value = [];
      await nextTick();
      const second = staleness.createTracker('diff', () => [PATH]);
      expect(second.stale.value).toBe(false);
    });
    scope.stop();
  });

  it('does not treat baseline turns with running edits as history', async () => {
    const scope = effectScope();
    await scope.run(async () => {
      const turns = ref<ChatTurn[]>([]);
      const tracker = useFileStaleness({ turns, sessionId: ref(testSessionId()), cwd: ref('/repo') }).createTracker('t', () => [PATH]);
      tracker.markLoaded();
      turns.value = [turn({ id: 'turn-1', tools: [tool({ id: 'a', status: 'running' })] })];
      await nextTick();
      expect(tracker.stale.value).toBe(false);
      turns.value = [turn({ id: 'turn-1', tools: [tool({ id: 'a' })] })];
      await nextTick();
      expect(tracker.stale.value).toBe(true);
    });
    scope.stop();
  });

  it('splits baseline history per tool: completed edits are history, running edits stay live', async () => {
    const scope = effectScope();
    await scope.run(async () => {
      const turns = ref<ChatTurn[]>([]);
      const staleness = useFileStaleness({ turns, sessionId: ref(testSessionId()), cwd: ref('/repo') });
      const trackerA = staleness.createTracker('a', () => [PATH]);
      const trackerB = staleness.createTracker('b', () => ['/repo/src/b.ts']);
      trackerA.markLoaded();
      trackerB.markLoaded();
      turns.value = [
        turn({
          id: 'turn-1',
          tools: [
            tool({ id: 'done-a' }),
            tool({ id: 'run-b', status: 'running', arg: JSON.stringify({ path: '/repo/src/b.ts' }) }),
          ],
        }),
      ];
      await nextTick();
      expect(trackerA.stale.value).toBe(false);
      expect(trackerB.stale.value).toBe(false);
      turns.value = [
        turn({
          id: 'turn-1',
          tools: [
            tool({ id: 'done-a' }),
            tool({ id: 'run-b', arg: JSON.stringify({ path: '/repo/src/b.ts' }) }),
          ],
        }),
      ];
      await nextTick();
      expect(trackerA.stale.value).toBe(false);
      expect(trackerB.stale.value).toBe(true);
    });
    scope.stop();
  });

  it('keeps baseline-page edits live when their turn ended after the client window started', async () => {
    const scope = effectScope();
    await scope.run(async () => {
      const turns = ref<ChatTurn[]>([]);
      const tracker = useFileStaleness({ turns, sessionId: ref(testSessionId()), cwd: ref('/repo') }).createTracker('t', () => [PATH]);
      tracker.markLoaded();
      turns.value = [turn({ id: 'turn-1', tools: [tool({ id: 'a' })], endedAt: new Date().toISOString() })];
      await nextTick();
      expect(tracker.stale.value).toBe(true);
    });
    scope.stop();
  });

  it('marks baseline-page edits as history when their turn ended before the client window started', async () => {
    const scope = effectScope();
    await scope.run(async () => {
      const turns = ref<ChatTurn[]>([]);
      const tracker = useFileStaleness({ turns, sessionId: ref(testSessionId()), cwd: ref('/repo') }).createTracker('t', () => [PATH]);
      tracker.markLoaded();
      turns.value = [turn({ id: 'turn-1', tools: [tool({ id: 'a' })], endedAt: '2020-01-01T00:00:00.000Z' })];
      await nextTick();
      expect(tracker.stale.value).toBe(false);
    });
    scope.stop();
  });

  it('keeps baseline-page edits live when their turn was created after the client window started', async () => {
    const scope = effectScope();
    await scope.run(async () => {
      const turns = ref<ChatTurn[]>([]);
      const tracker = useFileStaleness({ turns, sessionId: ref(testSessionId()), cwd: ref('/repo') }).createTracker('t', () => [PATH]);
      tracker.markLoaded();
      turns.value = [turn({ id: 'turn-1', tools: [tool({ id: 'a' })], createdAt: new Date().toISOString() })];
      await nextTick();
      expect(tracker.stale.value).toBe(true);
    });
    scope.stop();
  });

  it('does not mark a re-baselined edit as history when the tool was seen running before', async () => {
    const scope = effectScope();
    await scope.run(async () => {
      const turns = ref<ChatTurn[]>([]);
      const tracker = useFileStaleness({ turns, sessionId: ref(testSessionId()), cwd: ref('/repo') }).createTracker('t', () => [PATH]);
      tracker.markLoaded();
      turns.value = [turn({ id: 'turn-1', tools: [tool({ id: 'a', status: 'running' })] })];
      await nextTick();
      turns.value = [turn({ id: 'turn-1', tools: [tool({ id: 'a' })] })];
      await nextTick();
      expect(tracker.stale.value).toBe(true);
      turns.value = [];
      await nextTick();
      turns.value = [turn({ id: 'turn-1', tools: [tool({ id: 'a' })] })];
      await nextTick();
      expect(tracker.stale.value).toBe(true);
    });
    scope.stop();
  });
});
