// Use U+25CF instead of U+23FA to avoid emoji/fallback rendering in terminals.
export const STATUS_BULLET = '● ';

// Shared transcript markers. Keep widths stable because message wrapping
// assumes the marker occupies the leading cells.
export const USER_MESSAGE_BULLET = '❯ ';
export const SUCCESS_MARK = '✓ ';
export const FAILURE_MARK = '✗ ';

// Notification badge, including its horizontal padding.
export const NOTIFY_USER_MARK = ' Update ';
export const NOTIFY_USER_MARK_FOREGROUND = '#FFFFFF';

// Shared selector markers — keep every list picker visually consistent.
// SELECT_POINTER marks the highlighted row; CURRENT_MARK is appended to the
// row that is the currently-active value. See .agents/skills/write-tui/DESIGN.md.
export const SELECT_POINTER = '❯';
export const CURRENT_MARK = '← current';
