/**
 * BackgroundManager in-memory output ring-buffer byte cap.
 *
 * The cap (`MAX_OUTPUT_BYTES`) is a byte budget, so eviction must be measured
 * in UTF-8 bytes — not UTF-16 code units, which would let multibyte output
 * grow the resident buffer well past the cap.
 */

import { describe, expect, it } from 'vitest';

import { BackgroundManager } from '../../../src/agent/background';
import type {
  BackgroundTask,
  BackgroundTaskInfo,
  BackgroundTaskInfoBase,
  BackgroundTaskSink,
} from '../../../src/agent/background/task';
import { createBackgroundManager, waitForTerminal } from './helpers';

const MAX_OUTPUT_BYTES = 1024 * 1024; // mirror of the cap in src/agent/background/index.ts

class ChunkEmittingTask implements BackgroundTask {
  readonly idPrefix = 'agent';
  readonly kind = 'agent' as const;

  constructor(
    readonly description: string,
    private readonly chunks: readonly string[],
  ) {}

  async start(sink: BackgroundTaskSink): Promise<void> {
    for (const chunk of this.chunks) sink.appendOutput(chunk);
    await sink.settle({ status: 'completed' });
  }

  toInfo(base: BackgroundTaskInfoBase): BackgroundTaskInfo {
    return { ...base, kind: 'agent' };
  }
}

describe('BackgroundManager output ring-buffer byte cap', () => {
  it('evicts oldest chunks by UTF-8 byte size for multibyte output', async () => {
    const manager: BackgroundManager = createBackgroundManager().manager; // in-memory, no persistence
    // Three 600 KB (UTF-8) chunks of a 3-byte character: 1.8 MB of bytes but
    // only 600 K UTF-16 code units. The old char-based total never crossed the
    // 1,048,576 budget, so nothing was evicted and the whole 1.8 MB stayed.
    const chunk = '世'.repeat(200_000);
    const taskId = manager.registerTask(new ChunkEmittingTask('emit', [chunk, chunk, chunk]));
    await waitForTerminal(manager, taskId);

    const output = await manager.readOutput(taskId);
    expect(Buffer.byteLength(output, 'utf-8')).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
  });
});
