import { describe, expect, it } from 'vitest';

import {
  nextWorktreeDiskRemindedLevel,
  shouldRemindWorktreeDisk,
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

describe('shouldRemindWorktreeDisk', () => {
  it('never reminds when the total size is unknown', () => {
    expect(shouldRemindWorktreeDisk(undefined, 0)).toBe(false);
  });

  it('reminds once when the threshold is crossed', () => {
    expect(shouldRemindWorktreeDisk(4.9 * GB, 0)).toBe(false);
    expect(shouldRemindWorktreeDisk(5 * GB, 0)).toBe(true);
    expect(shouldRemindWorktreeDisk(5.5 * GB, 5)).toBe(false);
  });

  it('reminds again for each additional whole gigabyte', () => {
    expect(shouldRemindWorktreeDisk(6 * GB, 5)).toBe(true);
    expect(shouldRemindWorktreeDisk(6.2 * GB, 6)).toBe(false);
    expect(shouldRemindWorktreeDisk(7 * GB, 6)).toBe(true);
  });
});

describe('nextWorktreeDiskRemindedLevel', () => {
  it('keeps the level while the size is unknown', () => {
    expect(nextWorktreeDiskRemindedLevel(undefined, 6, true)).toBe(6);
  });

  it('records the level only once the user was reminded', () => {
    expect(nextWorktreeDiskRemindedLevel(6 * GB, 5, false)).toBe(5);
    expect(nextWorktreeDiskRemindedLevel(6 * GB, 5, true)).toBe(6);
  });

  it('does not lower the level while usage stays above the threshold', () => {
    expect(nextWorktreeDiskRemindedLevel(6 * GB, 8, true)).toBe(8);
  });

  it('resets once usage drops below the threshold, so the next crossing reminds again', () => {
    const reset = nextWorktreeDiskRemindedLevel(4 * GB, 7, false);
    expect(reset).toBe(0);
    expect(shouldRemindWorktreeDisk(5 * GB, reset)).toBe(true);
  });
});
