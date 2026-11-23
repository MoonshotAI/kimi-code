import { randomInt } from 'node:crypto';

import { Error2, ErrorCodes } from '#/errors';

export type WorktreeNameViolation = 'slash' | 'length' | 'chars' | 'edge' | 'dots';

const MAX_NAME_LENGTH = 64;
const RANDOM_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const RANDOM_LENGTH = 4;

const NAME_RULES: readonly {
  readonly reason: WorktreeNameViolation;
  readonly violatedBy: (name: string) => boolean;
  readonly rule: string;
}[] = [
  {
    reason: 'slash',
    violatedBy: (name) => /[/\\]/.test(name),
    rule: 'it cannot contain "/" or "\\" because it names the worktree directory, not a branch; create or switch branches inside the worktree',
  },
  {
    reason: 'length',
    violatedBy: (name) => name.length === 0 || name.length > MAX_NAME_LENGTH,
    rule: `it must be 1 to ${MAX_NAME_LENGTH} characters long`,
  },
  {
    reason: 'chars',
    violatedBy: (name) => !/^[a-z0-9._-]*$/.test(name),
    rule: 'it can only contain ASCII letters, digits, ".", "_" and "-"',
  },
  {
    reason: 'edge',
    violatedBy: (name) => /^[-.]|[-.]$/.test(name),
    rule: 'it cannot start or end with "-" or "."',
  },
  {
    reason: 'dots',
    violatedBy: (name) => name.includes('..'),
    rule: 'it cannot contain ".."',
  },
];

export function normalizeWorktreeName(input: string): string {
  const requested = input.trim();
  const name = requested.toLowerCase();
  const broken = NAME_RULES.find((rule) => rule.violatedBy(name));
  if (broken !== undefined) {
    throw new Error2(
      ErrorCodes.WORKTREE_INVALID_NAME,
      `Invalid worktree name "${requested}": ${broken.rule}.`,
      { details: { name: requested, reason: broken.reason } },
    );
  }
  return name;
}

export function generateWorktreeName(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  let suffix = '';
  for (let i = 0; i < RANDOM_LENGTH; i++) {
    suffix += RANDOM_ALPHABET[randomInt(RANDOM_ALPHABET.length)];
  }
  return `${month}${day}-${suffix}`;
}
