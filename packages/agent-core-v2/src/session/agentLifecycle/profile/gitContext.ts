import type { ILogger } from '#/_base/log/log';
import type { IGitService, RunGitResult } from '#/app/git/git';

const GIT_TIMEOUT_MS = 5_000;
const MAX_DIRTY_FILES = 20;
const MAX_COMMIT_LINE_LENGTH = 200;

const ALLOWED_HOSTS = [
  'github.com',
  'gitlab.com',
  'gitee.com',
  'bitbucket.org',
  'codeberg.org',
  'git.sr.ht',
] as const;

type TaggedGitResult = { readonly args: readonly string[]; readonly result: RunGitResult };

export async function collectGitContext(
  git: IGitService,
  cwd: string,
  log?: ILogger,
): Promise<string> {
  const revParseArgs = ['rev-parse', '--is-inside-work-tree'] as const;
  const revParse = await git.runGit(cwd, revParseArgs, { timeoutMs: GIT_TIMEOUT_MS });
  if (revParse.exitCode !== 0) {
    if (isNotARepo(revParse.stderr)) {
      return `<git-context status="unavailable" reason="not-a-repo"/>`;
    }
    logGitFailure(cwd, revParseArgs, revParse, log);
    return '';
  }

  const commandArgs = [
    ['remote', 'get-url', 'origin'],
    ['symbolic-ref', '--short', 'HEAD'],
    ['status', '--porcelain'],
    ['log', '-3', '--format=%h %s'],
  ] as const;
  const [remote, branch, status, gitLog] = (await Promise.all(
    commandArgs.map(async (args) => ({
      args,
      result: await git.runGit(cwd, args, { timeoutMs: GIT_TIMEOUT_MS }),
    })),
  )) as unknown as [TaggedGitResult, TaggedGitResult, TaggedGitResult, TaggedGitResult];

  for (const { args, result } of [remote, branch, status, gitLog]) {
    if (result.exitCode !== 0) logGitFailure(cwd, args, result, log);
  }

  const remoteUrl = stdoutOf(remote.result);
  const branchName = stdoutOf(branch.result);
  const dirtyRaw = stdoutOf(status.result);
  const logRaw = stdoutOf(gitLog.result);

  const sections: string[] = [`Working directory: ${cwd}`];

  if (remoteUrl) {
    const safeUrl = sanitizeRemoteUrl(remoteUrl);
    if (safeUrl) {
      sections.push(`Remote: ${safeUrl}`);
      const project = parseProjectName(safeUrl);
      if (project) sections.push(`Project: ${project}`);
    }
  }

  if (branchName) sections.push(`Branch: ${branchName}`);

  const dirtyLines = dirtyRaw.split('\n').filter((line) => line.trim().length > 0);
  if (dirtyLines.length > 0) {
    const total = dirtyLines.length;
    const shown = dirtyLines.slice(0, MAX_DIRTY_FILES);
    let body = shown.map((line) => `  ${line}`).join('\n');
    if (total > MAX_DIRTY_FILES) {
      body += `\n  ... and ${String(total - MAX_DIRTY_FILES)} more`;
    }
    sections.push(`Dirty files (${String(total)}):\n${body}`);
  }

  if (logRaw) {
    const logLines = logRaw.split('\n').filter((line) => line.trim().length > 0);
    if (logLines.length > 0) {
      const body = logLines.map((line) => `  ${line.slice(0, MAX_COMMIT_LINE_LENGTH)}`).join('\n');
      sections.push(`Recent commits:\n${body}`);
    }
  }

  if (sections.length <= 1) return '';
  return `<git-context>\n${sections.join('\n')}\n</git-context>`;
}

export function sanitizeRemoteUrl(remoteUrl: string): string | null {
  for (const host of ALLOWED_HOSTS) {
    if (remoteUrl.startsWith(`git@${host}:`)) return remoteUrl;
  }

  let parsed: URL;
  try {
    parsed = new URL(remoteUrl);
  } catch {
    return null;
  }
  if ((ALLOWED_HOSTS as readonly string[]).includes(parsed.hostname)) {
    const port = parsed.port ? `:${parsed.port}` : '';
    return `https://${parsed.hostname}${port}${parsed.pathname}`;
  }

  return null;
}

export function parseProjectName(remoteUrl: string): string | null {
  const scp = /^[^/]+@[^/:]+:(.+)$/.exec(remoteUrl);
  const rawPath = scp?.[1] ?? tryUrlPath(remoteUrl);
  if (rawPath === null) return null;
  const project = rawPath
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
  return project.length > 0 ? project : null;
}

function tryUrlPath(remoteUrl: string): string | null {
  try {
    return new URL(remoteUrl).pathname;
  } catch {
    return null;
  }
}

function stdoutOf(result: RunGitResult): string {
  return result.exitCode === 0 ? result.stdout.trim() : '';
}

function isNotARepo(stderr: string): boolean {
  return stderr.includes('not a git repository');
}

function logGitFailure(
  cwd: string,
  args: readonly string[],
  result: RunGitResult,
  log?: ILogger,
): void {
  if (log === undefined) return;
  const command = `git ${args.join(' ')}`;
  if (result.exitCode === -1) {
    log.warn('git context command failed to spawn', { cwd, command, stderr: result.stderr });
  } else {
    log.debug('git context command failed', {
      cwd,
      command,
      exitCode: result.exitCode,
      stderr: result.stderr,
    });
  }
}
