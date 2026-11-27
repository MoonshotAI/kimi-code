import { expect, vi } from 'vitest';
import type {
  AppWorktreeSessionRef,
  RemoveWorktreeInput,
  RemoveWorktreeResult,
  WorktreeInspection,
  WorktreeList,
} from '@moonshot-ai/app-core/api';
import type { WorktreeRemovalItem } from '../stores/worktrees';

export function worktreeManageApi() {
  return {
    listWorktrees: vi.fn<(input?: { refreshSizes?: boolean }) => Promise<WorktreeList>>(),
    inspectWorktrees: vi.fn<(paths: string[]) => Promise<WorktreeInspection>>(),
    removeWorktree: vi.fn<(input: RemoveWorktreeInput) => Promise<RemoveWorktreeResult>>(),
  };
}

export function sessionRef(id: string, title: string, extra: Partial<AppWorktreeSessionRef> = {}): AppWorktreeSessionRef {
  return { id, title, archived: false, busy: false, ...extra };
}

export async function whenRemovalsSettled(store: { removals: WorktreeRemovalItem[] }): Promise<void> {
  await vi.waitFor(
    () => expect(store.removals.some((item) => item.state === 'waiting' || item.state === 'deleting')).toBe(false),
    { interval: 1 },
  );
  await Promise.resolve();
}
