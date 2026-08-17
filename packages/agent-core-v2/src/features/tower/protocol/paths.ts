export const TOWER_ROOT = '.tower';
export const COMMS_DIR = `${TOWER_ROOT}/comms`;
export const INBOX_DIR = `${COMMS_DIR}/inbox`;
export const FINDINGS_DIR = `${COMMS_DIR}/findings`;
export const REVIEWS_DIR = `${COMMS_DIR}/reviews`;
export const MISSIONS_DIR = `${COMMS_DIR}/missions`;
export const LOG_DIR = `${COMMS_DIR}/log`;
export const WORKTREES_DIR = `${TOWER_ROOT}/worktrees`;

export const STATE_FILE = `${COMMS_DIR}/state.json`;
export const ACTIVITY_LOG = `${LOG_DIR}/activity.log`;
export const MISSIONS_INDEX = `${COMMS_DIR}/MISSIONS.md`;

export const TOWER_NAME = 'tower';
export const BROADCAST_NAME = 'all';

/** Local YYYYMMDD, used at the start of inbox/finding file names. */
export function dateStamp(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/** `YYYY-MM-DD` for review frontmatter. */
export function dateDash(now = new Date()): string {
  const stamp = dateStamp(now);
  return `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;
}

/**
 * Filesystem-safe slug: lowercase, alnum runs joined by `-`. CJK and other
 * non-ASCII letters are dropped so names stay greppable everywhere.
 */
export function slugify(text: string, maxLength = 60): string {
  const slug = text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replaceAll(/-+$/g, '');
  return slug.length > 0 ? slug : 'item';
}

/** Branch/PR targets become filename segments: `feat/x` → `feat-x`, `#12` → `pr12`. */
export function targetSlug(target: string): string {
  const cleaned = target.trim().replace(/^#/, 'pr');
  return slugify(cleaned.replaceAll(/[/#]+/g, '-'));
}

export function inboxFileName(input: {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly now?: Date;
}): string {
  return `${dateStamp(input.now)}-${slugify(input.from, 30)}-${slugify(input.to, 30)}-${slugify(input.subject)}.md`;
}

export function findingFileName(input: {
  readonly agent: string;
  readonly type: string;
  readonly slug: string;
  readonly now?: Date;
}): string {
  return `${dateStamp(input.now)}-${slugify(input.agent, 30)}-${slugify(input.type, 12)}-${slugify(input.slug)}.md`;
}

export function reviewFileName(input: {
  readonly target: string;
  readonly reviewer: string;
  readonly round: number;
}): string {
  return `review-${targetSlug(input.target)}-${slugify(input.reviewer, 30)}-r${input.round}.md`;
}

export function missionFileName(id: string, slug: string): string {
  return `${id}-${slugify(slug)}.md`;
}
