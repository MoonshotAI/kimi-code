export const WORKTREE_DISK_REMINDER_STEP_BYTES = 1024 * 1024 * 1024;

export const WORKTREE_DISK_REMINDER_THRESHOLD_BYTES = 5 * WORKTREE_DISK_REMINDER_STEP_BYTES;

export function worktreeDiskReminderLevel(totalSizeBytes: number | null | undefined): number | null {
  if (totalSizeBytes === null || totalSizeBytes === undefined || !Number.isFinite(totalSizeBytes)) return null;
  if (totalSizeBytes < WORKTREE_DISK_REMINDER_THRESHOLD_BYTES) return 0;
  return Math.floor(totalSizeBytes / WORKTREE_DISK_REMINDER_STEP_BYTES);
}

export function shouldRemindWorktreeDisk(
  totalSizeBytes: number | null | undefined,
  lastRemindedLevel: number,
): boolean {
  const level = worktreeDiskReminderLevel(totalSizeBytes);
  return level !== null && level > 0 && level > lastRemindedLevel;
}

export function nextWorktreeDiskRemindedLevel(
  totalSizeBytes: number | null | undefined,
  lastRemindedLevel: number,
  reminded: boolean,
): number {
  const level = worktreeDiskReminderLevel(totalSizeBytes);
  if (level === null) return lastRemindedLevel;
  if (level === 0) return 0;
  return reminded ? Math.max(level, lastRemindedLevel) : lastRemindedLevel;
}
