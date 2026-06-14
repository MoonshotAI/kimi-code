import type { Readable } from 'node:stream';

import type { Kaos } from '@moonshot-ai/kaos';

import type {
  ReviewBaseRef,
  ReviewCommit,
  ReviewDiffStats,
  ReviewFileChange,
  ReviewFileStatus,
  ReviewHeadSummary,
  ReviewScopeSummary,
  ReviewUpstreamInfo,
  ReviewWorkingTreeSummary,
  ReviewTarget,
} from './types';

const GIT_TIMEOUT_MS = 15_000;
const UNTRACKED_FILE_PREVIEW_BYTES = 1024 * 1024;

export class ReviewGitTargetError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(detail ? `${message}: ${detail}` : message);
    this.name = 'ReviewGitTargetError';
  }
}

export async function resolveReviewTarget(kaos: Kaos, input: ReviewTarget): Promise<ReviewTarget> {
  await ensureGitRepository(kaos);

  switch (input.scope) {
    case 'working_tree':
      return { scope: 'working_tree', baseRef: await resolveCommitRef(kaos, input.baseRef ?? 'HEAD') };

    case 'current_branch': {
      const baseRef = await resolveCommitRef(kaos, input.baseRef);
      const headRef = await resolveCommitRef(kaos, input.headRef ?? 'HEAD');
      return { scope: 'current_branch', baseRef, headRef };
    }

    case 'single_commit': {
      const commit = await resolveCommitRef(kaos, input.commit);
      return { scope: 'single_commit', commit };
    }
  }
}

export async function listReviewBaseRefs(kaos: Kaos): Promise<readonly ReviewBaseRef[]> {
  await ensureGitRepository(kaos);

  const [branchesRaw, tagsRaw, commits] = await Promise.all([
    runGitOrEmpty(kaos, ['for-each-ref', '--format=%(refname:short)%09%(objectname:short)%09%(subject)', 'refs/heads']),
    runGitOrEmpty(kaos, ['for-each-ref', '--format=%(refname:short)%09%(objectname:short)%09%(subject)', 'refs/tags']),
    listReviewCommits(kaos),
  ]);

  return [
    ...parseNamedRefs(branchesRaw, 'branch'),
    ...parseNamedRefs(tagsRaw, 'tag'),
    ...commits.map((commit): ReviewBaseRef => ({
      name: commit.sha,
      kind: 'commit',
      description: commit.title,
    })),
  ];
}

export async function listReviewCommits(kaos: Kaos): Promise<readonly ReviewCommit[]> {
  await ensureGitRepository(kaos);

  const raw = await runGitOrEmpty(kaos, ['log', '-50', '--format=%H%x09%an%x09%aI%x09%s']);
  return raw
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line): ReviewCommit => {
      const [sha = '', author = '', date = '', ...titleParts] = line.split('\t');
      return {
        sha,
        title: titleParts.join('\t'),
        author: author || undefined,
        date: date || undefined,
      };
    })
    .filter((commit) => commit.sha.length > 0);
}

export async function getReviewScopeSummary(kaos: Kaos): Promise<ReviewScopeSummary> {
  await ensureGitRepository(kaos);

  const [workingTree, head, upstream] = await Promise.all([
    getWorkingTreeSummary(kaos),
    getHeadSummary(kaos),
    getReviewUpstreamInfo(kaos),
  ]);
  return { workingTree, head, upstream };
}

export async function previewReviewTarget(
  kaos: Kaos,
  target: ReviewTarget,
): Promise<ReviewDiffStats> {
  await ensureGitRepository(kaos);

  const files = await listChangedFiles(kaos, target);
  return {
    fileCount: files.length,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    files,
  };
}

async function listChangedFiles(kaos: Kaos, target: ReviewTarget): Promise<readonly ReviewFileChange[]> {
  switch (target.scope) {
    case 'working_tree':
      return [
        ...(await diffFileChanges(kaos, [
          'diff',
          '--no-ext-diff',
          '--no-color',
          '-M',
          '--end-of-options',
          target.baseRef ?? 'HEAD',
          '--',
        ])),
        ...(await listUntrackedFileChanges(kaos)),
      ];

    case 'current_branch':
      return diffFileChanges(kaos, [
        'diff',
        '--no-ext-diff',
        '--no-color',
        '-M',
        '--end-of-options',
        `${target.baseRef}...${target.headRef ?? 'HEAD'}`,
        '--',
      ]);

    case 'single_commit':
      return diffFileChanges(kaos, [
        'diff-tree',
        '--root',
        '--no-commit-id',
        '-r',
        '--no-ext-diff',
        '--no-color',
        '-M',
        '--end-of-options',
        target.commit,
      ]);
  }
}

async function getWorkingTreeSummary(kaos: Kaos): Promise<ReviewWorkingTreeSummary> {
  const raw = await runGitOrEmpty(kaos, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  let stagedCount = 0;
  let unstagedCount = 0;
  let untrackedCount = 0;
  let conflictedCount = 0;
  const tokens = raw.split('\0').filter(Boolean);

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const indexStatus = token[0] ?? ' ';
    const worktreeStatus = token[1] ?? ' ';
    if (indexStatus === '?' && worktreeStatus === '?') {
      untrackedCount += 1;
      continue;
    }

    if (isConflictedStatus(indexStatus, worktreeStatus)) {
      conflictedCount += 1;
      unstagedCount += 1;
    } else {
      if (isChangedStatus(indexStatus)) stagedCount += 1;
      if (isChangedStatus(worktreeStatus)) unstagedCount += 1;
    }

    if (indexStatus === 'R' || indexStatus === 'C') {
      i += 1;
    }
  }

  return { stagedCount, unstagedCount, untrackedCount, conflictedCount };
}

async function getHeadSummary(kaos: Kaos): Promise<ReviewHeadSummary | null> {
  const raw = await runGitOrNull(kaos, ['log', '-1', '--format=%H%x09%h%x09%s']);
  const line = raw?.trimEnd();
  if (!line) return null;
  const [sha = '', shortSha = '', ...subjectParts] = line.split('\t');
  if (sha.length === 0) return null;
  return {
    sha,
    shortSha: shortSha || sha.slice(0, 7),
    subject: subjectParts.join('\t'),
  };
}

async function getReviewUpstreamInfo(kaos: Kaos): Promise<ReviewUpstreamInfo | null> {
  const [upstreamRefRaw, upstreamCommitRaw, headCommitRaw, countsRaw] = await Promise.all([
    runGitOrNull(kaos, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']),
    runGitOrNull(kaos, ['rev-parse', '--verify', '--quiet', '--end-of-options', '@{upstream}^{commit}']),
    runGitOrNull(kaos, ['rev-parse', '--verify', '--quiet', '--end-of-options', 'HEAD^{commit}']),
    runGitOrNull(kaos, ['rev-list', '--left-right', '--count', '--end-of-options', '@{upstream}...HEAD']),
  ]);

  const upstreamRef = upstreamRefRaw?.trim();
  const upstreamCommit = upstreamCommitRaw?.trim();
  const headCommit = headCommitRaw?.trim();
  const counts = countsRaw?.trim().split(/\s+/) ?? [];
  const behindCount = Number.parseInt(counts[0] ?? '', 10);
  const aheadCount = Number.parseInt(counts[1] ?? '', 10);
  if (
    !upstreamRef
    || !upstreamCommit
    || !headCommit
    || !Number.isFinite(aheadCount)
    || !Number.isFinite(behindCount)
  ) {
    return null;
  }

  return {
    upstreamRef,
    upstreamCommit,
    headCommit,
    aheadCount,
    behindCount,
  };
}

async function diffFileChanges(kaos: Kaos, baseArgs: readonly string[]): Promise<readonly ReviewFileChange[]> {
  const nameStatusRaw = await runGit(kaos, withGitFormatArgs(baseArgs, ['--name-status', '-z']));
  const numstatRaw = await runGit(kaos, withGitFormatArgs(baseArgs, ['--numstat', '-z']));
  const statsByPath = parseNumstat(numstatRaw);

  return parseNameStatus(nameStatusRaw).map((entry) => {
    const stats = statsByPath.get(entry.path);
    return {
      path: entry.path,
      oldPath: entry.oldPath,
      status: entry.status,
      additions: stats?.additions ?? 0,
      deletions: stats?.deletions ?? 0,
      binary: stats?.binary || undefined,
    };
  });
}

function isChangedStatus(status: string): boolean {
  return status !== ' ' && status !== '?' && status !== '!';
}

function isConflictedStatus(indexStatus: string, worktreeStatus: string): boolean {
  const pair = `${indexStatus}${worktreeStatus}`;
  return pair === 'DD'
    || pair === 'AU'
    || pair === 'UD'
    || pair === 'UA'
    || pair === 'DU'
    || pair === 'AA'
    || pair === 'UU';
}

function withGitFormatArgs(baseArgs: readonly string[], formatArgs: readonly string[]): readonly string[] {
  const endOfOptionsIndex = baseArgs.indexOf('--end-of-options');
  if (endOfOptionsIndex !== -1) {
    return [
      ...baseArgs.slice(0, endOfOptionsIndex),
      ...formatArgs,
      ...baseArgs.slice(endOfOptionsIndex),
    ];
  }
  const separatorIndex = baseArgs.lastIndexOf('--');
  if (separatorIndex === -1) return [...baseArgs, ...formatArgs];
  return [
    ...baseArgs.slice(0, separatorIndex),
    ...formatArgs,
    ...baseArgs.slice(separatorIndex),
  ];
}

async function listUntrackedFileChanges(kaos: Kaos): Promise<readonly ReviewFileChange[]> {
  const raw = await runGitOrEmpty(kaos, ['ls-files', '--others', '--exclude-standard', '-z']);
  const paths = raw.split('\0').filter(Boolean);
  const changes: ReviewFileChange[] = [];

  for (const path of paths) {
    const filePath = joinGitPath(kaos, kaos.getcwd(), path);
    const bytes = await kaos.readBytes(filePath, UNTRACKED_FILE_PREVIEW_BYTES);
    const binary = bytes.includes(0);
    changes.push({
      path,
      status: 'untracked',
      additions: binary ? 0 : countTextLines(bytes.toString('utf8')),
      deletions: 0,
      binary: binary || undefined,
    });
  }

  return changes;
}

async function ensureGitRepository(kaos: Kaos): Promise<void> {
  const output = await runGitOrNull(kaos, ['rev-parse', '--is-inside-work-tree']);
  if (output?.trim() !== 'true') {
    throw new ReviewGitTargetError('Current directory is not inside a Git work tree');
  }
}

async function resolveCommitRef(kaos: Kaos, ref: string): Promise<string> {
  const resolved = await runGitOrNull(kaos, [
    'rev-parse',
    '--verify',
    '--quiet',
    '--end-of-options',
    `${ref}^{commit}`,
  ]);
  const sha = resolved?.trim();
  if (!sha) throw new ReviewGitTargetError('Could not resolve Git commit ref', ref);
  return sha;
}

function parseNamedRefs(raw: string, kind: ReviewBaseRef['kind']): readonly ReviewBaseRef[] {
  return raw
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line): ReviewBaseRef => {
      const [name = '', shortSha = '', ...subjectParts] = line.split('\t');
      const subject = subjectParts.join('\t');
      const description = [shortSha, subject].filter(Boolean).join(' ');
      return {
        name,
        kind,
        description: description || undefined,
      };
    })
    .filter((ref) => ref.name.length > 0);
}

interface NameStatusEntry {
  readonly path: string;
  readonly oldPath?: string;
  readonly status: ReviewFileStatus;
}

function parseNameStatus(raw: string): readonly NameStatusEntry[] {
  const tokens = raw.split('\0');
  const entries: NameStatusEntry[] = [];
  let index = 0;

  while (index < tokens.length) {
    const statusToken = tokens[index++];
    if (!statusToken) continue;

    if (statusToken.startsWith('R')) {
      const oldPath = tokens[index++] ?? '';
      const path = tokens[index++] ?? '';
      if (path) entries.push({ path, oldPath, status: 'renamed' });
      continue;
    }

    if (statusToken.startsWith('C')) {
      index += 1;
      const path = tokens[index++] ?? '';
      if (path) entries.push({ path, status: 'added' });
      continue;
    }

    const path = tokens[index++] ?? '';
    if (!path) continue;
    entries.push({ path, status: mapNameStatus(statusToken) });
  }

  return entries;
}

interface NumstatEntry {
  readonly additions: number;
  readonly deletions: number;
  readonly binary: boolean;
}

function parseNumstat(raw: string): Map<string, NumstatEntry> {
  const tokens = raw.split('\0');
  const stats = new Map<string, NumstatEntry>();
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index++];
    if (!token) continue;

    const match = /^([^\t]+)\t([^\t]+)\t(.*)$/s.exec(token);
    if (!match) continue;

    const [, additionsRaw = '', deletionsRaw = '', inlinePath = ''] = match;
    const binary = additionsRaw === '-' || deletionsRaw === '-';
    const entry = {
      additions: binary ? 0 : Number.parseInt(additionsRaw, 10),
      deletions: binary ? 0 : Number.parseInt(deletionsRaw, 10),
      binary,
    };

    if (inlinePath) {
      stats.set(inlinePath, entry);
      continue;
    }

    index += 1;
    const renamedPath = tokens[index++] ?? '';
    if (renamedPath) stats.set(renamedPath, entry);
  }

  return stats;
}

function mapNameStatus(status: string): ReviewFileStatus {
  switch (status[0]) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    default:
      return 'modified';
  }
}

function countTextLines(text: string): number {
  if (text.length === 0) return 0;
  const lineBreaks = text.match(/\n/g)?.length ?? 0;
  return text.endsWith('\n') ? lineBreaks : lineBreaks + 1;
}

function joinGitPath(kaos: Kaos, cwd: string, relativePath: string): string {
  const separator = kaos.pathClass() === 'win32' ? '\\' : '/';
  const normalizedRelativePath = relativePath.split('/').join(separator);
  const joined = cwd.endsWith('/') || cwd.endsWith('\\')
    ? `${cwd}${normalizedRelativePath}`
    : `${cwd}${separator}${normalizedRelativePath}`;
  return kaos.normpath(joined);
}

async function runGitOrEmpty(kaos: Kaos, args: readonly string[]): Promise<string> {
  return (await runGitOrNull(kaos, args)) ?? '';
}

async function runGitOrNull(kaos: Kaos, args: readonly string[]): Promise<string | null> {
  try {
    return await runGit(kaos, args);
  } catch {
    return null;
  }
}

async function runGit(kaos: Kaos, args: readonly string[]): Promise<string> {
  let proc;
  try {
    proc = await kaos.exec('git', '-C', kaos.getcwd(), ...args);
  } catch (error) {
    throw new ReviewGitTargetError('Failed to start Git command', errorMessage(error));
  }

  try {
    proc.stdin.end();
  } catch {
    /* stdin already closed */
  }

  const work = Promise.all([collectStream(proc.stdout), collectStream(proc.stderr), proc.wait()]);
  work.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new ReviewGitTargetError('Git command timed out', args.join(' ')));
      }, GIT_TIMEOUT_MS);
    });
    const [stdout, stderr, exitCode] = await Promise.race([work, timeout]);
    if (exitCode !== 0) {
      throw new ReviewGitTargetError('Git command failed', stderr.trim() || stdout.trim());
    }
    return stdout;
  } catch (error) {
    try {
      await proc.kill('SIGKILL');
    } catch {
      /* process already gone */
    }
    await work.catch(() => {});
    if (error instanceof ReviewGitTargetError) throw error;
    throw new ReviewGitTargetError('Git command failed', errorMessage(error));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function collectStream(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
