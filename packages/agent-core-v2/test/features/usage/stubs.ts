import { Event } from '#/_base/event';
import type { UsageRuntime } from '#/features/usage/usageAgentRuntime';

export function stubUsage(): UsageRuntime {
  return {
    onDidRecord: Event.None,
    status: () => ({}),
    recordTurn: () => Promise.resolve(false),
  } as unknown as UsageRuntime;
}
