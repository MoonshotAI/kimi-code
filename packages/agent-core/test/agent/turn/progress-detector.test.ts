import { describe, expect, it } from 'vitest';

import type { LoopRecordedEvent } from '../../../src/loop/events';
import {
  ProgressDetector,
  type ProgressSnapshot,
} from '../../../src/agent/turn/progress-detector';

function makeToolResultEvent(output: string, isError = false): LoopRecordedEvent {
  return {
    type: 'tool.result',
    parentUuid: 'parent-1',
    toolCallId: 'call-1',
    result: { output, isError },
  };
}

function makeToolCallEvent(name: string): LoopRecordedEvent {
  return {
    type: 'tool.call',
    uuid: 'call-1',
    turnId: '0',
    step: 1,
    stepUuid: 'step-1',
    toolCallId: 'call-1',
    name,
    args: {},
  };
}

function stableSnapshot(): ProgressSnapshot {
  return { gitStatus: '', backgroundTasks: '[]' };
}

function changingSnapshot(step: number): ProgressSnapshot {
  return { gitStatus: `M file-${step}.ts`, backgroundTasks: '[]' };
}

async function runStep(
  detector: ProgressDetector,
  stepNumber: number,
  events: LoopRecordedEvent[],
): Promise<boolean> {
  for (const event of events) {
    detector.onLoopEvent(event);
  }
  return detector.recordStep(stepNumber);
}

describe('ProgressDetector', () => {
  it('reports progress when git status changes', async () => {
    let snapshot = stableSnapshot();
    const detector = new ProgressDetector({
      takeSnapshot: () => snapshot,
    });

    expect(await runStep(detector, 1, [makeToolResultEvent('some output')])).toBe(false);

    snapshot = changingSnapshot(2);
    expect(await runStep(detector, 2, [makeToolResultEvent('some output')])).toBe(true);
  });

  it('reports progress when a new non-trivial tool output is seen', async () => {
    const detector = new ProgressDetector({
      takeSnapshot: () => stableSnapshot(),
    });

    expect(
      await runStep(detector, 1, [makeToolResultEvent('this is the first substantial output that is definitely longer than the threshold')]),
    ).toBe(true);

    // Same output again should not count as progress.
    expect(
      await runStep(detector, 2, [makeToolResultEvent('this is the first substantial output that is definitely longer than the threshold')]),
    ).toBe(false);

    // A different substantial output counts.
    expect(
      await runStep(detector, 3, [makeToolResultEvent('this is the second substantial output that is definitely longer than the threshold and different')]),
    ).toBe(true);
  });

  it('ignores trivial and error outputs', async () => {
    const detector = new ProgressDetector({
      takeSnapshot: () => stableSnapshot(),
    });

    expect(await runStep(detector, 1, [makeToolResultEvent('ok')])).toBe(false);
    expect(await runStep(detector, 2, [makeToolResultEvent('')])).toBe(false);
    expect(await runStep(detector, 3, [makeToolResultEvent('Command executed successfully.')])).toBe(
      false,
    );
    expect(await runStep(detector, 4, [makeToolResultEvent('error', true)])).toBe(false);
  });

  it('tracks consecutive steps without progress', async () => {
    const detector = new ProgressDetector({
      takeSnapshot: () => stableSnapshot(),
    });

    await runStep(detector, 1, [makeToolResultEvent('this is one substantial output that is definitely longer than the threshold value')]);
    await runStep(detector, 2, [makeToolResultEvent('ok')]);
    await runStep(detector, 3, [makeToolResultEvent('ok')]);
    await runStep(detector, 4, [makeToolResultEvent('ok')]);

    expect(detector.stepsSinceLastProgress(4)).toBe(3);
  });

  it('resets idle counter after progress', async () => {
    const detector = new ProgressDetector({
      takeSnapshot: () => stableSnapshot(),
    });

    await runStep(detector, 1, [makeToolResultEvent('this is the first substantial output that is definitely longer than the threshold value')]);
    await runStep(detector, 2, [makeToolResultEvent('ok')]);
    await runStep(detector, 3, [makeToolResultEvent('this is the second substantial output that is definitely longer than the threshold value and different from the first')]);

    expect(detector.stepsSinceLastProgress(3)).toBe(0);
  });

  it('does not count tool.call events alone as progress', async () => {
    const detector = new ProgressDetector({
      takeSnapshot: () => stableSnapshot(),
    });

    expect(await runStep(detector, 1, [makeToolCallEvent('Read')])).toBe(false);
  });

  it('counts successful Edit/Write results as progress even with short output', async () => {
    const detector = new ProgressDetector({
      takeSnapshot: () => stableSnapshot(),
    });

    expect(
      await runStep(detector, 1, [
        makeToolCallEvent('Edit'),
        makeToolResultEvent('ok'),
      ]),
    ).toBe(true);

    expect(
      await runStep(detector, 2, [
        makeToolCallEvent('Write'),
        makeToolResultEvent('done'),
      ]),
    ).toBe(true);

    // Failed edits do not count.
    expect(
      await runStep(detector, 3, [
        makeToolCallEvent('Edit'),
        makeToolResultEvent('error', true),
      ]),
    ).toBe(false);
  });
});
