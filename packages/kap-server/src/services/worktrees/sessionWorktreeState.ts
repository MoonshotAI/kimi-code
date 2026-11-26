import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { z } from 'zod';

import {
  sessionWorktreeSchema,
  type SessionWorktree,
  type WorktreeSetup,
} from '../../protocol/worktree';
import { branchExists } from './gitRefs';

export const SESSION_WORKTREE_METADATA_KEY = 'worktree';

const storedSessionWorktreeSchema = sessionWorktreeSchema
  .omit({ missing: true, branch_missing: true })
  .extend({
    repo_root: z.string().min(1),
    pending: z.object({ path: z.string().min(1), branch: z.string().min(1) }).optional(),
    held_request: z
      .discriminatedUnion('route', [
        z.object({ route: z.literal('prompts'), body: z.record(z.string(), z.unknown()) }),
        z.object({ route: z.literal('skills'), skill_id: z.string().min(1), body: z.record(z.string(), z.unknown()) }),
      ])
      .optional(),
  });
export type StoredSessionWorktree = z.infer<typeof storedSessionWorktreeSchema>;
export type HeldPromptRequest = NonNullable<StoredSessionWorktree['held_request']>;

function rebasePath(path: unknown, from: string, to: string): unknown {
  if (typeof path !== 'string') return path;
  const rel = relative(from, path);
  return rel === '' || rel.startsWith('..') || isAbsolute(rel) ? path : join(to, rel);
}

function rebaseSkills(skills: unknown, from: string, to: string): unknown {
  if (!Array.isArray(skills)) return skills;
  return skills.map((skill: unknown) =>
    typeof skill === 'object' && skill !== null && 'path' in skill
      ? { ...skill, path: rebasePath(skill.path, from, to) }
      : skill,
  );
}

export function heldRequestForCheckout(stored: StoredSessionWorktree, request: HeldPromptRequest): HeldPromptRequest {
  const to = stored.setup.status === 'ready' ? stored.path : undefined;
  if (to === undefined || to === stored.repo_root) return request;
  const from = stored.repo_root;
  if (request.route === 'skills') {
    return { ...request, body: { ...request.body, path: rebasePath(request.body['path'], from, to) } };
  }
  return { ...request, body: { ...request.body, skills: rebaseSkills(request.body['skills'], from, to) } };
}

export function worktreeHoldsPrompts(stored: StoredSessionWorktree | undefined): boolean {
  return stored !== undefined && stored.setup.status !== 'ready' && stored.setup.status !== 'local';
}

export function withoutHeldPrompt(stored: StoredSessionWorktree): StoredSessionWorktree {
  const { held_prompt: _held, held_request: _request, ...rest } = stored;
  return rest;
}

export function storedSessionWorktree(
  custom: Record<string, unknown> | undefined,
): StoredSessionWorktree | undefined {
  const raw = custom?.[SESSION_WORKTREE_METADATA_KEY];
  if (raw === undefined) return undefined;
  const parsed = storedSessionWorktreeSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export function withStoredSessionWorktree(
  custom: Record<string, unknown> | undefined,
  stored: StoredSessionWorktree,
): Record<string, unknown> {
  return { ...custom, [SESSION_WORKTREE_METADATA_KEY]: stored };
}

export function settleInterruptedSetup(stored: StoredSessionWorktree): StoredSessionWorktree {
  const { pending: _pending, ...rest } = stored;
  const interrupted = stored.setup.steps.find(
    (step) => step.state === 'running' || step.state === 'pending',
  );
  const steps = stored.setup.steps.map((step) =>
    step.state === 'running' ? { ...step, state: 'stopped' as const } : step,
  );
  const ended_at = new Date().toISOString();
  const created = stored.setup.purpose === 'create' && stored.path !== undefined;
  if (created) {
    return { ...rest, setup: { ...stored.setup, steps, status: 'ready', ended_at } };
  }
  const setup: WorktreeSetup = {
    ...stored.setup,
    steps,
    status: 'stopped',
    stopped_step: interrupted?.kind ?? stored.setup.steps.at(-1)?.kind,
    ended_at,
  };
  return { ...rest, setup };
}

const FACTS_TTL_MS = 2_000;

interface PathFacts {
  readonly branch?: string;
  readonly checkedAt: number;
}

interface BranchFacts {
  readonly missing: boolean;
  readonly checkedAt: number;
}

const pathFacts = new Map<string, PathFacts>();
const branchFacts = new Map<string, BranchFacts>();

function branchKey(repoRoot: string, branch: string): string {
  return `${repoRoot}\0${branch}`;
}

export async function readWorktreeHeadBranch(path: string): Promise<string | undefined> {
  try {
    const pointer = (await readFile(join(path, '.git'), 'utf-8')).trim();
    if (!pointer.startsWith('gitdir:')) return undefined;
    const raw = pointer.slice('gitdir:'.length).trim();
    const gitDir = isAbsolute(raw) ? raw : resolve(path, raw);
    const head = (await readFile(join(gitDir, 'HEAD'), 'utf-8')).trim();
    return head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : undefined;
  } catch {
    return undefined;
  }
}

export async function refreshWorktreeFacts(stored: StoredSessionWorktree): Promise<void> {
  if (stored.path === undefined) return;
  const now = Date.now();
  if (existsSync(stored.path)) {
    const cached = pathFacts.get(stored.path);
    if (cached === undefined || now - cached.checkedAt >= FACTS_TTL_MS) {
      pathFacts.set(stored.path, {
        branch: await readWorktreeHeadBranch(stored.path),
        checkedAt: now,
      });
    }
    return;
  }
  if (stored.branch === undefined) return;
  const key = branchKey(stored.repo_root, stored.branch);
  const cached = branchFacts.get(key);
  if (cached !== undefined && now - cached.checkedAt < FACTS_TTL_MS) return;
  branchFacts.set(key, {
    missing: !(await branchExists(stored.repo_root, stored.branch)),
    checkedAt: now,
  });
}

export function forgetWorktreeFacts(
  stored: Pick<StoredSessionWorktree, 'repo_root' | 'path' | 'branch'>,
): void {
  if (stored.path !== undefined) pathFacts.delete(stored.path);
  if (stored.branch !== undefined) branchFacts.delete(branchKey(stored.repo_root, stored.branch));
}

export function liveWorktreeBranch(stored: StoredSessionWorktree): string | undefined {
  return stored.path === undefined ? undefined : pathFacts.get(stored.path)?.branch;
}

export function sessionWorktreeWire(
  custom: Record<string, unknown> | undefined,
): SessionWorktree | undefined {
  const stored = storedSessionWorktree(custom);
  if (stored === undefined) return undefined;
  const { repo_root: _repoRoot, pending: _pending, held_request: _heldRequest, ...wire } = stored;
  if (stored.path === undefined) return wire;
  if (existsSync(stored.path)) {
    return { ...wire, branch: liveWorktreeBranch(stored) ?? stored.branch };
  }
  const branch =
    stored.branch === undefined
      ? undefined
      : branchFacts.get(branchKey(stored.repo_root, stored.branch));
  return { ...wire, missing: true, branch_missing: branch?.missing === true ? true : undefined };
}
