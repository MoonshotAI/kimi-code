/**
 * `FsGitService` — implementation of `IFsGitService`.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';

import { Disposable } from '@moonshot-ai/agent-core';
import type { FsGitStatusRequest, FsGitStatusResponse } from '@moonshot-ai/protocol';
import { ISessionService, SessionNotFoundError } from '@moonshot-ai/services';

import { IFsGitService, FsGitUnavailableError, parsePorcelain } from './fsGit';
import { FsPathEscapesError, resolveSafePath } from './fsPathSafety';

export class FsGitService extends Disposable implements IFsGitService {
  readonly _serviceBrand: undefined;

  constructor(@ISessionService protected readonly sessions: ISessionService) {
    super();
  }

  async status(
    sessionId: string,
    req: FsGitStatusRequest,
  ): Promise<FsGitStatusResponse> {
    const session = await this.sessions.get(sessionId);
    const cwd = session.metadata.cwd;
    const realCwd = await fs.realpath(cwd);

    // Resolve any client-supplied path filter through the shared safety
    // guard. Out-of-tree paths fail the whole call with 41304 (matches
    // `:stat_many`'s posture).
    let filterSet: Set<string> | undefined;
    if (req.paths !== undefined && req.paths.length > 0) {
      filterSet = new Set();
      for (const p of req.paths) {
        const safe = await resolveSafePath(realCwd, p);
        filterSet.add(safe.relative);
      }
    }

    // Step 1 — check we're inside a git worktree. Locale-independent via
    // exit code (no stderr text match).
    const insideRes = await runCommand('git', ['rev-parse', '--is-inside-work-tree'], realCwd);
    if (insideRes.exitCode !== 0 || insideRes.stdout.trim() !== 'true') {
      throw new FsGitUnavailableError(
        realCwd,
        insideRes.stderr.trim() || `git rev-parse exit ${insideRes.exitCode}`,
      );
    }

    // Step 2 — run porcelain. `--porcelain=v1 --branch -z` would give NUL
    // separators (handy for newlines in paths), but v1 plain newline output
    // is plenty for our wire shape. We use `--no-renames` is NOT supplied
    // so renames surface as `R`; we surface as `renamed` per SCHEMAS enum.
    const porcRes = await runCommand(
      'git',
      ['status', '--porcelain=v1', '--branch'],
      realCwd,
    );
    if (porcRes.exitCode !== 0) {
      // Treat unexpected `git status` failures as unavailable — bare repo,
      // corrupted index, etc. The wire code is still 40908.
      throw new FsGitUnavailableError(
        realCwd,
        porcRes.stderr.trim() || `git status exit ${porcRes.exitCode}`,
      );
    }

    return parsePorcelain(porcRes.stdout, filterSet);
  }
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runCommand(
  cmd: string,
  args: readonly string[],
  cwd: string,
): Promise<RunResult> {
  return await new Promise<RunResult>((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (c: string) => {
      stdout += c;
    });
    child.stderr.on('data', (c: string) => {
      stderr += c;
    });
    child.once('error', () => {
      resolve({ exitCode: -1, stdout, stderr });
    });
    child.once('close', (code) => {
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}
