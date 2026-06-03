import type { KaosProcess } from '@moonshot-ai/kaos';
import { vi } from 'vitest';

import {
  BackgroundManager,
  BackgroundTaskPersistence,
  ProcessBackgroundTask,
  type BackgroundTaskInfo,
} from '../../../src/agent/background';
import type { AgentEvent } from '../../../src/rpc/events';

export interface FakeBackgroundAgent {
  emitEvent: ReturnType<typeof vi.fn>;
  emittedEvents: AgentEvent[];
  kimiConfig?: { background?: { maxRunningTasks?: number } };
  telemetry: { track: ReturnType<typeof vi.fn> };
  context: { appendUserMessage: ReturnType<typeof vi.fn> };
  turn: { steer: ReturnType<typeof vi.fn> };
  hooks?: { fireAndForgetTrigger: ReturnType<typeof vi.fn> };
}

export interface BackgroundManagerFixture {
  agent: FakeBackgroundAgent;
  manager: BackgroundManager;
  persistence?: BackgroundTaskPersistence;
}

export function createBackgroundManager(options: {
  sessionDir?: string;
  maxRunningTasks?: number;
  hooks?: FakeBackgroundAgent['hooks'];
} = {}): BackgroundManagerFixture {
  const emittedEvents: AgentEvent[] = [];
  const agent: FakeBackgroundAgent = {
    emittedEvents,
    emitEvent: vi.fn((event: AgentEvent) => {
      emittedEvents.push(event);
    }),
    kimiConfig:
      options.maxRunningTasks === undefined
        ? undefined
        : { background: { maxRunningTasks: options.maxRunningTasks } },
    telemetry: { track: vi.fn() },
    context: { appendUserMessage: vi.fn() },
    turn: { steer: vi.fn() },
    hooks: options.hooks,
  };
  const persistence =
    options.sessionDir === undefined
      ? undefined
      : new BackgroundTaskPersistence(options.sessionDir);
  return {
    agent,
    manager: new BackgroundManager(agent as never, persistence),
    persistence,
  };
}

export function registerProcess(
  manager: BackgroundManager,
  proc: KaosProcess,
  command: string,
  description: string,
): string {
  return manager.registerTask(new ProcessBackgroundTask(proc, command, description));
}

export async function waitForTerminal(
  manager: BackgroundManager,
  taskId: string,
  timeoutMs = 30_000,
): Promise<BackgroundTaskInfo | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const info = await manager.wait(taskId, 5);
    if (
      info?.status === 'completed' ||
      info?.status === 'failed' ||
      info?.status === 'timed_out' ||
      info?.status === 'killed' ||
      info?.status === 'lost'
    ) {
      return info;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return manager.getTask(taskId);
}

export async function waitForOutput(
  manager: BackgroundManager,
  taskId: string,
  expected: string,
): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const output = await manager.readOutput(taskId);
    if (output.includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for output: ${expected}`);
}
