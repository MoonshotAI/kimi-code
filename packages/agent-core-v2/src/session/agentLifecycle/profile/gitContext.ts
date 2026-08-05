/**
 * Git context collection for explore agents.
 *
 * `collectGitContext` produces a `<git-context>` block that is prepended to a
 * fresh explore agent's prompt so it can orient itself in the repository
 * before searching. Every git probe is best-effort: probes fail in perfectly
 * normal states (no `origin` remote, no commits yet, detached HEAD, older
 * Git), so a failed probe is logged and its section omitted rather than
 * dropping the whole block. The block is omitted entirely only when nothing
 * useful was collected. The one explicit state surfaced to the agent is
 * `reason="not-a-repo"`, so it doesn't waste turns probing git history in a
 * non-repo directory. Remote URLs are sanitized so internal infrastructure
 * is not surfaced to the model.
 */

import type { Readable } from 'node:stream';

import type { ILogger } from '#/_base/log/log';
import type { IProcess, ISessionProcessRunner } from '#/session/process/processRunner';

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

type GitFailure =
  | { readonly kind: 'timeout' }
  | { readonly kind: 'spawn-error' }
  | { readonly kind: 'command-failed'; readonly exitCode?: number; readonly stderr?: string };

type GitResult =
  | { readonly ok: true; readonly stdout: string }
  | ({ readonly ok: false } & GitFailure);

type TaggedGitResult = { readonly args: readonly string[]; readonly result: GitResult };

export async function collectGitContext(
  runner: ISessionProcessRunner,
  cwd: string,
  log?: ILogger,
): Promise<string> {
  const revParseArgs = ['rev-parse', '--is-inside-work-tree'] as const;
  const revParse = await runGit(runner, cwd, revParseArgs);
  if (!revParse.ok) {
    if (revParse.kind === 'command-failed' && isNotARepo(revParse.stderr)) {
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
    commandArgs.map(async (args) => ({ args, result: await runGit(runner, cwd, args) })),
  )) as unknown as [TaggedGitResult, TaggedGitResult, TaggedGitResult, TaggedGitResult];

  for (const { args, result } of [remote, branch, status, gitLog]) {
    if (!result.ok) logGitFailure(cwd, args, result, log);
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

function stdoutOf(result: GitResult): string {
  return result.ok ? result.stdout : '';
}

function isNotARepo(stderr: string | undefined): boolean {
  return stderr !== undefined && stderr.includes('not a git repository');
}

function logGitFailure(
  cwd: string,
  args: readonly string[],
  failure: GitFailure,
  log?: ILogger,
): void {
  if (log === undefined) return;
  const command = `git ${args.join(' ')}`;
  if (failure.kind === 'timeout') {
    log.debug('git context command timed out', { cwd, command });
  } else if (failure.kind === 'spawn-error') {
    log.warn('git context command failed to spawn', { cwd, command });
  } else {
    log.debug('git context command failed', {
      cwd,
      command,
      exitCode: failure.exitCode,
      stderr: failure.stderr,
    });
  }
}

async function runGit(
  runner: ISessionProcessRunner,
  cwd: string,
  args: readonly string[],
): Promise<GitResult> {
  let proc: IProcess | undefined;
  try {
    proc = await runner.exec(['git', '-C', cwd, ...args]);
  } catch {
    return { ok: false, kind: 'spawn-error' };
  }

  try {
    proc.stdin.end();
  } catch {
  }

  const work = Promise.all([collectStream(proc.stdout), collectStream(proc.stderr), proc.wait()]);
  work.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error(`git ${args.join(' ')} timed out`));
      }, GIT_TIMEOUT_MS);
    });
    const [stdout, stderr, exitCode] = await Promise.race([work, timeout]);
    if (exitCode !== 0) {
      return { ok: false, kind: 'command-failed', exitCode, stderr: stderr.trim() };
    }
    return { ok: true, stdout: stdout.trim() };
  } catch {
    try {
      await proc.kill('SIGKILL');
    } catch {
    }
    await work.catch(() => {});
    if (timedOut) return { ok: false, kind: 'timeout' };
    return { ok: false, kind: 'command-failed' };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (proc !== undefined) await disposeProcess(proc);
  }
}

async function collectStream(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function disposeProcess(proc: IProcess): Promise<void> {
  try {
    await proc.dispose();
  } catch {
  }
}
