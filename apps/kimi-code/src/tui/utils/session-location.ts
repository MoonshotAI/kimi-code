import { sameDir, type KimiHarness, type SessionSummary, type WorkLocation } from '@moonshot-ai/kimi-code-sdk';

import { abbreviateHome } from '#/utils/paths';
import { isDirectoryAsync } from '#/utils/session-directory';

const SESSION_LOCATION_PROBE_CONCURRENCY = 8;

export type ResumePlan =
  | { readonly kind: 'here'; readonly missing: boolean }
  | { readonly kind: 'switch'; readonly location: WorkLocation; readonly missing: boolean }
  | { readonly kind: 'other-project' };

export interface SessionLocationTag {
  readonly worktree?: string;
  readonly missing: boolean;
}

interface CurrentPlace {
  readonly workDir: string;
  readonly projectRoot?: string;
  readonly isGitRepo?: boolean;
}

export function switchedNotice(cwd: string): string {
  return `Switched to ${abbreviateHome(cwd)} to resume this session.`;
}

export function missingWorkdirNotice(cwd: string): string {
  return `Working directory ${abbreviateHome(cwd)} no longer exists. You can still send messages, though local file and shell tools won't find it.`;
}

export async function planResume(
  harness: Pick<KimiHarness, 'resolveWorkLocation'>,
  session: { readonly workDir?: string; readonly projectWorkDir?: string },
  current: CurrentPlace,
): Promise<ResumePlan> {
  const targetCwd = session.workDir;
  if (targetCwd === undefined || targetCwd.length === 0) {
    return { kind: 'here', missing: false };
  }
  const missing = !(await isDirectoryAsync(targetCwd));
  if (sameDir(targetCwd, current.workDir)) {
    return { kind: 'here', missing };
  }
  const currentProjectRoot = current.projectRoot ?? current.workDir;
  if (session.projectWorkDir === undefined || !sameDir(session.projectWorkDir, currentProjectRoot)) {
    return { kind: 'other-project' };
  }
  const location: WorkLocation = missing
    ? {
        cwd: targetCwd,
        projectRoot: currentProjectRoot,
        isGitRepo: current.isGitRepo ?? false,
      }
    : ((await harness.resolveWorkLocation(targetCwd).catch(() => undefined)) ?? {
        cwd: targetCwd,
        projectRoot: currentProjectRoot,
        isGitRepo: current.isGitRepo ?? false,
      });
  return { kind: 'switch', location, missing };
}

export async function sessionLocationTags(
  harness: Pick<KimiHarness, 'resolveWorkLocation'>,
  sessions: readonly Pick<SessionSummary, 'workDir'>[],
  options: { readonly isCancelled?: () => boolean } = {},
): Promise<ReadonlyMap<string, SessionLocationTag>> {
  const dirs = [...new Set(sessions.map((session) => session.workDir))];
  if (dirs.length === 0) return new Map();
  const entries: Array<[string, SessionLocationTag]> = [];
  let nextIndex = 0;
  const workerCount = Math.min(SESSION_LOCATION_PROBE_CONCURRENCY, dirs.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < dirs.length) {
        if (options.isCancelled?.() === true) return;
        const dir = dirs[nextIndex];
        nextIndex += 1;
        if (dir === undefined) continue;
        if (!(await isDirectoryAsync(dir))) {
          entries.push([dir, { missing: true }]);
          continue;
        }
        if (options.isCancelled?.() === true) return;
        const location = await harness.resolveWorkLocation(dir).catch(() => undefined);
        entries.push([dir, { worktree: location?.worktree?.name, missing: false }]);
      }
    }),
  );
  return new Map(entries);
}
