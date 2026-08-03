import { describe, expect, it } from 'vitest';

import { UsageRecorder } from '../../src/agent/usage';

describe('Agent usage', () => {
  it('accumulates usage by model', () => {
    const usage = new UsageRecorder();

    usage.record('model-a', {
      inputOther: 1,
      output: 2,
      inputCacheRead: 3,
      inputCacheCreation: 4,
    });
    usage.record('model-a', {
      inputOther: 10,
      output: 20,
      inputCacheRead: 30,
      inputCacheCreation: 40,
    });
    usage.record('model-b', {
      inputOther: 100,
      output: 200,
      inputCacheRead: 300,
      inputCacheCreation: 400,
    });

    expect(usage.data()).toEqual({
      byModel: {
        'model-a': {
          inputOther: 11,
          output: 22,
          inputCacheRead: 33,
          inputCacheCreation: 44,
        },
        'model-b': {
          inputOther: 100,
          output: 200,
          inputCacheRead: 300,
          inputCacheCreation: 400,
        },
      },
      total: {
        inputOther: 111,
        output: 222,
        inputCacheRead: 333,
        inputCacheCreation: 444,
      },
      currentTurn: undefined,
    });
  });

  it('tracks current turn usage separately from session totals', () => {
    const usage = new UsageRecorder();

    usage.record('model-a', {
      inputOther: 1,
      output: 2,
      inputCacheRead: 3,
      inputCacheCreation: 4,
    });
    usage.beginTurn();
    usage.record(
      'model-a',
      {
        inputOther: 10,
        output: 20,
        inputCacheRead: 30,
        inputCacheCreation: 40,
      },
      'turn',
    );
    usage.record(
      'model-b',
      {
        inputOther: 100,
        output: 200,
        inputCacheRead: 300,
        inputCacheCreation: 400,
      },
      'turn',
    );

    expect(usage.data()).toMatchObject({
      total: {
        inputOther: 111,
        output: 222,
        inputCacheRead: 333,
        inputCacheCreation: 444,
      },
      currentTurn: {
        inputOther: 110,
        output: 220,
        inputCacheRead: 330,
        inputCacheCreation: 440,
      },
    });

    usage.endTurn();

    expect(usage.data().currentTurn).toBeUndefined();
  });

  it('returns immutable status snapshots', () => {
    const usage = new UsageRecorder();

    usage.record('model-a', {
      inputOther: 1,
      output: 2,
      inputCacheRead: 3,
      inputCacheCreation: 4,
    });
    const snapshot = usage.data();

    usage.record('model-a', {
      inputOther: 10,
      output: 20,
      inputCacheRead: 30,
      inputCacheCreation: 40,
    });

    expect(snapshot).toEqual({
      byModel: {
        'model-a': {
          inputOther: 1,
          output: 2,
          inputCacheRead: 3,
          inputCacheCreation: 4,
        },
      },
      total: {
        inputOther: 1,
        output: 2,
        inputCacheRead: 3,
        inputCacheCreation: 4,
      },
      currentTurn: undefined,
    });
  });
});
