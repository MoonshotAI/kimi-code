/**
 * Git repository context for explore subagents.
 *
 * `collectGitContext` produces a `<git-context>` block that is prepended to a
 * fresh explore subagent's prompt so it can orient itself in the repository
 * before searching. Every git command is individually guarded — a single
 * failure never aborts the whole collection — and remote URLs are sanitized
 * so internal infrastructure is not surfaced to the model.
 */

import type { Readable } from 'node:stream';

import type { Kaos, KaosProcess } from '@moonshot-ai/kaos';

const GIT_TIMEOUT_MS = 5_000;
const MAX_DIRTY_FILES = 20;
const MAX_COMMIT_LINE_LENGTH = 200;

// Well-known public hosts whose remote URLs are safe to surface. Self-hosted
// or unrecognized hosts are excluded to avoid leaking internal infrastructure.
const ALLOWED_HOSTS = [
  'github.com',
  'gitlab.com',
  'gitee.com',
  'bitbucket.org',
  'codeberg.org',
  'git.sr.ht',
] as const;

async function disposeProcess(proc: KaosProcess): Promise<void> {
  try {
    await proc.dispose();
  } catch {
    /* best-effort cleanup */
  }
}

/**
 * Collect git context for the explore agent.
 *
 * Returns a formatted `<git-context>` block, or an empty string if the
 * directory is not a git repository or no useful information was collected.
 */
export async function collectGitContext(kaos: Kaos, cwd: string): Promise<string> {
  // Quick check: is this a git repo?
  if ((await runGit(kaos, cwd, ['rev-parse', '--is-inside-work-tree'])) === null) {
    return '';
  }

  const [remoteUrl, branch, dirtyRaw, logRaw] = await Promise.all([
    runGit(kaos, cwd, ['remote', 'get-url', 'origin']),
    runGit(kaos, cwd, ['branch', '--show-current']),
    runGit(kaos, cwd, ['status', '--porcelain']),
    runGit(kaos, cwd, ['log', '-3', '--format=%h %s']),
  ]);

  const sections: string[] = [`Working directory: ${cwd}`];

  if (remoteUrl) {
    const safeUrl = sanitizeRemoteUrl(remoteUrl);
    if (safeUrl) {
      sections.push(`Remote: ${safeUrl}`);
      // Derive the project slug only from an allowed remote — deriving it from
      // a rejected host would leak an internal owner/repo into the prompt.
      const project = parseProjectName(safeUrl);
      if (project) sections.push(`Project: ${project}`);
    }
  }

  if (branch) sections.push(`Branch: ${branch}`);

  if (dirtyRaw !== null) {
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
  }

  if (logRaw) {
    const logLines = logRaw.split('\n').filter((line) => line.trim().length > 0);
    if (logLines.length > 0) {
      const body = logLines.map((line) => `  ${line.slice(0, MAX_COMMIT_LINE_LENGTH)}`).join('\n');
      sections.push(`Recent commits:\n${body}`);
    }
  }

  if (sections.length <= 1) {
    // Only the working directory line — nothing useful collected.
    return '';
  }

  return `<git-context>\n${sections.join('\n')}\n</git-context>`;
}

/**
 * Return the remote URL if it points to a well-known public host, stripping
 * credentials from HTTPS URLs. Returns `null` for unrecognized hosts.
 */
export function sanitizeRemoteUrl(remoteUrl: string): string | null {
  // SSH format: git@host:owner/repo.git — no credentials possible.
  for (const host of ALLOWED_HOSTS) {
    if (remoteUrl.startsWith(`git@${host}:`)) return remoteUrl;
  }

  // HTTPS format: parse the hostname exactly and drop any userinfo.
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

/**
 * Extract the project path from a git remote URL — `owner/repo`, or the full
 * `group/subgroup/repo` for nested namespaces (e.g. GitLab subgroups).
 * Supports scp-like SSH (`git@host:path`) and URL forms (`https://`, `ssh://`).
 */
export function parseProjectName(remoteUrl: string): string | null {
  // scp-like SSH (`git@host:owner/.../repo.git`) is not a valid URL — match it
  // directly; everything else goes through URL parsing. The whole path is kept
  // so nested namespaces survive.
  const scp = /^[^/]+@[^/:]+:(.+)$/.exec(remoteUrl);
  const rawPath = scp?.[1] ?? tryUrlPath(remoteUrl);
  if (rawPath === null) return null;
  const project = rawPath.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');
  return project.length > 0 ? project : null;
}

function tryUrlPath(remoteUrl: string): string | null {
  try {
    return new URL(remoteUrl).pathname;
  } catch {
    return null;
  }
}

/**
 * Run a single `git -C <cwd> <args>` command and return its trimmed stdout,
 * or `null` on any failure (spawn error, non-zero exit, or timeout). The
 * `git -C` form runs in the target directory regardless of the Kaos backend.
 */
async function runGit(kaos: Kaos, cwd: string, args: readonly string[]): Promise<string | null> {
  let proc: KaosProcess | undefined;
  try {
    proc = await kaos.exec('git', '-C', cwd, ...args);
  } catch {
    return null;
  }

  try {
    proc.stdin.end();
  } catch {
    /* stdin already closed */
  }

  const work = Promise.all([collectStream(proc.stdout), proc.wait()]);
  // Attach a rejection handler up front: if `work` rejects during the
  // timeout-handling window (before the catch block re-awaits it), Node must
  // not flag it as an unhandled rejection.
  work.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`git ${args.join(' ')} timed out`));
      }, GIT_TIMEOUT_MS);
    });
    const [stdout, exitCode] = await Promise.race([work, timeout]);
    if (exitCode !== 0) return null;
    return stdout.trim();
  } catch {
    try {
      await proc.kill('SIGKILL');
    } catch {
      /* process already gone */
    }
    // Let the stdout drain settle so the process resources are released,
    // even though the timed-out output is discarded.
    await work.catch(() => {});
    return null;
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
