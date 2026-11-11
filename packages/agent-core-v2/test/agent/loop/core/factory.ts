import { createLoop, type CreateLoopOptions, type Loop } from '#/agent/loop/core/index';

export function createTestLoop(options: CreateLoopOptions): Loop {
  return createLoop(options);
}
