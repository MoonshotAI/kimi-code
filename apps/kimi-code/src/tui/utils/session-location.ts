import { stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

import type { KimiHarness, SessionSummary, WorkLocation } from '@moonshot-ai/kimi-code-sdk';

import { SESSION_LIST_PAGE_SIZE } from '#/tui/constant/kimi-tui';

export type ResumePlan =
  | { readonly kind: 'here' }
  | { readonly kind: 'switch'; readonly location: WorkLocation }
  | { readonly kind: 'read-only'; readonly cwd: string };

export interface SessionLocationTag {
  readonly worktree?: string;
  readonly missing: boolean;
}

interface Place {
  readonly workDir: string;
  readonly cwd: string;
}

export async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (info) => info.isDirectory(),
    () => false,
  );
}

export function displayDir(path: string): string {
  const home = process.env['HOME'] ?? '';
  if (home === '' || (path !== home && !path.startsWith(home + sep))) return path;
  return '~' + path.slice(home.length);
}

export function switchedNotice(cwd: string): string {
  return `Switched to ${displayDir(cwd)} to resume this session.`;
}

export const READ_ONLY_PLACEHOLDER = 'Read-only: the working directory is missing';

export function readOnlyNotice(cwd: string): string {
  return `This session's working directory is missing: ${displayDir(cwd)}. You can read the conversation, but not continue it.`;
}

export async function planResume(
  harness: Pick<KimiHarness, 'resolveWorkLocation'>,
  session: Pick<SessionSummary, 'workDir' | 'projectWorkDir'>,
  current: Place,
): Promise<ResumePlan> {
  const cwd = session.workDir;
  if (!(await isDirectory(cwd))) return { kind: 'read-only', cwd };
  const workDir = session.projectWorkDir ?? cwd;
  if (resolve(workDir) === resolve(current.workDir) && resolve(cwd) === resolve(current.cwd)) {
    return { kind: 'here' };
  }
  const location = await harness.resolveWorkLocation(cwd).catch(() => undefined);
  return { kind: 'switch', location: { workDir, cwd, worktree: location?.worktree } };
}

export async function sessionLocationTags(
  harness: Pick<KimiHarness, 'resolveWorkLocation'>,
  sessions: readonly Pick<SessionSummary, 'workDir'>[],
): Promise<ReadonlyMap<string, SessionLocationTag>> {
  const dirs = [...new Set(sessions.map((session) => session.workDir))];
  return new Map(
    await Promise.all(
      dirs.map(async (dir): Promise<[string, SessionLocationTag]> => {
        if (!(await isDirectory(dir))) return [dir, { missing: true }];
        const location = await harness.resolveWorkLocation(dir).catch(() => undefined);
        return [dir, { worktree: location?.worktree?.name, missing: false }];
      }),
    ),
  );
}

export async function findContinueSession(
  harness: Pick<KimiHarness, 'resolveWorkLocation' | 'listWorktrees' | 'listSessionsPage'>,
  cwd: string,
): Promise<SessionSummary | undefined> {
  const here = await harness.resolveWorkLocation(cwd);
  const worktreeRoots =
    here.worktree === undefined
      ? ((await harness.listWorktrees(here.workDir).catch(() => undefined))?.worktrees.map(
          (worktree) => worktree.path,
        ) ?? [])
      : [];
  const continuable = async (session: SessionSummary): Promise<boolean> => {
    if (here.worktree !== undefined) return resolve(session.workDir) === resolve(here.cwd);
    if (worktreeRoots.some((root) => isWithin(session.workDir, root))) return false;
    if (!(await isDirectory(session.workDir))) return false;
    const location = await harness.resolveWorkLocation(session.workDir).catch(() => undefined);
    return location?.worktree === undefined;
  };
  let before: string | undefined;
  for (;;) {
    const page = await harness.listSessionsPage({
      workDir: here.workDir,
      limit: SESSION_LIST_PAGE_SIZE,
      before,
    });
    for (const session of page.items) {
      if (await continuable(session)) return session;
    }
    if (page.nextCursor === undefined) return undefined;
    before = page.nextCursor;
  }
}

function isWithin(path: string, root: string): boolean {
  const target = resolve(path);
  const base = resolve(root);
  return target === base || target.startsWith(base + sep);
}
