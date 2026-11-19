import { describe, expect, it } from 'vitest';

import {
  nextWorktreeDiskRemindedLevel,
  WORKTREE_DISK_REMINDER_STEP_BYTES as GB,
  worktreeDiskReminderLevel,
} from '../src/lib/worktreeDiskReminder';

describe('worktreeDiskReminderLevel', () => {
  it('is unknown without a size', () => {
    expect(worktreeDiskReminderLevel(undefined)).toBeNull();
    expect(worktreeDiskReminderLevel(null)).toBeNull();
    expect(worktreeDiskReminderLevel(Number.NaN)).toBeNull();
  });

  it('is zero below the threshold and the whole gigabyte count above it', () => {
    expect(worktreeDiskReminderLevel(0)).toBe(0);
    expect(worktreeDiskReminderLevel(5 * GB - 1)).toBe(0);
    expect(worktreeDiskReminderLevel(5 * GB)).toBe(5);
    expect(worktreeDiskReminderLevel(6.9 * GB)).toBe(6);
    expect(worktreeDiskReminderLevel(12 * GB)).toBe(12);
  });
});

describe('nextWorktreeDiskRemindedLevel', () => {
  it('keeps the level while the size is unknown', () => {
    expect(nextWorktreeDiskRemindedLevel(undefined, 6, true)).toBe(6);
  });

  it('does not lower the level while usage stays above the threshold', () => {
    expect(nextWorktreeDiskRemindedLevel(6 * GB, 8, true)).toBe(8);
  });
});
