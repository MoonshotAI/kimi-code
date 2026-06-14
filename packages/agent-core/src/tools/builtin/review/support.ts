import type { Readable } from 'node:stream';

import type { Kaos } from '@moonshot-ai/kaos';

import type { ReviewAgentFacade, ReviewRuntimeRun, ReviewLineRange } from '#/review';
import type { ExecutableToolResult } from '../../../loop';

const GIT_TIMEOUT_MS = 15_000;

export function jsonResult(value: unknown): ExecutableToolResult {
  return { output: JSON.stringify(value, null, 2) };
}

export function jsonError(error: unknown): ExecutableToolResult {
  return {
    isError: true,
    output: JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }),
  };
}

export function requireAssignedPath(review: ReviewAgentFacade, path: string): void {
  if (!review.getAssignment().assignedFiles.includes(path)) {
    throw new Error(`Path is not assigned to this review worker: ${path}`);
  }
}

export interface PatchHunk {
  readonly id: string;
  readonly header: string;
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly ranges: readonly ReviewLineRange[];
  readonly patch: string;
}

export interface ReadPatchResult {
  readonly patch: string;
  readonly hunks: readonly PatchHunk[];
}

export async function readPatchForTarget(
  kaos: Kaos,
  run: ReviewRuntimeRun,
  path: string,
  contextLines: number,
): Promise<ReadPatchResult> {
  const file = run.stats?.files.find((item) => item.path === path);
  if (run.target.scope === 'working_tree' && file?.status === 'untracked') {
    const content = await kaos.readText(joinGitPath(kaos, kaos.getcwd(), path), {
      errors: 'replace',
    });
    const patch = syntheticAddedPatch(path, content);
    return { patch, hunks: parsePatchHunks(patch) };
  }

  const unified = `-U${String(contextLines)}`;
  const patch = await runGit(kaos, patchArgs(run, path, unified));
  return { patch, hunks: parsePatchHunks(patch) };
}

export interface ReadFileVersionInput {
  readonly path: string;
  readonly version?: 'current' | 'base' | 'head';
  readonly ref?: string;
  readonly lineOffset?: number;
  readonly nLines?: number;
}

export interface ReadFileVersionResult {
  readonly path: string;
  readonly version: string;
  readonly ref?: string;
  readonly lineOffset: number;
  readonly nLines: number;
  readonly totalLines: number;
  readonly content: string;
}

export async function readFileVersionForTarget(
  kaos: Kaos,
  run: ReviewRuntimeRun,
  input: ReadFileVersionInput,
): Promise<ReadFileVersionResult> {
  const source = await resolveFileSource(kaos, run, input);
  const text = source.kind === 'worktree'
    ? await kaos.readText(joinGitPath(kaos, kaos.getcwd(), input.path), { errors: 'replace' })
    : await runGit(kaos, ['show', '--end-of-options', `${source.ref}:${input.path}`]);
  const lines = splitLogicalLines(text);
  const totalLines = lines.length;
  const lineOffset = input.lineOffset ?? 1;
  const startIndex = Math.max(0, lineOffset - 1);
  const selected = lines.slice(startIndex, input.nLines === undefined ? undefined : startIndex + input.nLines);
  const rendered = selected
    .map((line, index) => `${String(lineOffset + index)}\t${line}`)
    .join('\n');
  return {
    path: input.path,
    version: source.version,
    ref: source.kind === 'git' ? source.ref : undefined,
    lineOffset,
    nLines: selected.length,
    totalLines,
    content: rendered,
  };
}

export function isChangedFileVersionRead(
  run: ReviewRuntimeRun,
  result: Pick<ReadFileVersionResult, 'path' | 'version'>,
): boolean {
  if (result.version === 'ref') return false;
  const file = run.stats?.files.find((item) => item.path === result.path);
  if (file?.status === 'deleted') {
    if (run.target.scope === 'working_tree') {
      return result.version === 'base' || result.version === 'head';
    }
    return result.version === 'base';
  }
  switch (run.target.scope) {
    case 'working_tree':
      return result.version === 'current';
    case 'current_branch':
    case 'single_commit':
      return result.version === 'head';
  }
}

function patchArgs(run: ReviewRuntimeRun, path: string, unified: string): readonly string[] {
  switch (run.target.scope) {
    case 'working_tree':
      return [
        'diff',
        '--no-ext-diff',
        '--no-color',
        unified,
        '--end-of-options',
        run.target.baseRef ?? 'HEAD',
        '--',
        path,
      ];
    case 'current_branch':
      return [
        'diff',
        '--no-ext-diff',
        '--no-color',
        unified,
        '--end-of-options',
        `${run.target.baseRef}...${run.target.headRef ?? 'HEAD'}`,
        '--',
        path,
      ];
    case 'single_commit':
      return [
        'show',
        '--format=',
        '--no-ext-diff',
        '--no-color',
        unified,
        '--end-of-options',
        run.target.commit,
        '--',
        path,
      ];
  }
}

async function resolveFileSource(
  kaos: Kaos,
  run: ReviewRuntimeRun,
  input: ReadFileVersionInput,
): Promise<
  | { readonly kind: 'worktree'; readonly version: string }
  | { readonly kind: 'git'; readonly version: string; readonly ref: string }
> {
  if (input.ref !== undefined) return { kind: 'git', version: 'ref', ref: input.ref };

  switch (run.target.scope) {
    case 'working_tree':
      if (input.version === 'base' || input.version === 'head') {
        return { kind: 'git', version: input.version, ref: run.target.baseRef ?? 'HEAD' };
      }
      return { kind: 'worktree', version: 'current' };
    case 'current_branch':
      if (input.version === 'base') {
        const mergeBase = await runGit(kaos, [
          'merge-base',
          '--end-of-options',
          run.target.baseRef,
          run.target.headRef ?? 'HEAD',
        ]);
        return { kind: 'git', version: 'base', ref: mergeBase.trim() };
      }
      return { kind: 'git', version: input.version ?? 'head', ref: run.target.headRef ?? 'HEAD' };
    case 'single_commit':
      if (input.version === 'base') {
        return { kind: 'git', version: 'base', ref: `${run.target.commit}^` };
      }
      return { kind: 'git', version: input.version ?? 'head', ref: run.target.commit };
  }
}

function syntheticAddedPatch(path: string, content: string): string {
  const lines = splitLogicalLines(content);
  const body = lines.map((line) => `+${line}`).join('\n');
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${String(lines.length)} @@`,
    body,
  ].join('\n');
}

export function parsePatchHunks(patch: string): readonly PatchHunk[] {
  const lines = patch.split('\n');
  const hunks: PatchHunk[] = [];
  let current: {
    header: string;
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    lines: string[];
  } | null = null;

  for (const line of lines) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match !== null) {
      if (current !== null) hunks.push(toPatchHunk(hunks.length, current));
      current = {
        header: line,
        oldStart: Number.parseInt(match[1]!, 10),
        oldCount: Number.parseInt(match[2] ?? '1', 10),
        newStart: Number.parseInt(match[3]!, 10),
        newCount: Number.parseInt(match[4] ?? '1', 10),
        lines: [line],
      };
      continue;
    }
    current?.lines.push(line);
  }

  if (current !== null) hunks.push(toPatchHunk(hunks.length, current));
  return hunks;
}

function toPatchHunk(
  index: number,
  input: {
    readonly header: string;
    readonly oldStart: number;
    readonly oldCount: number;
    readonly newStart: number;
    readonly newCount: number;
    readonly lines: readonly string[];
  },
): PatchHunk {
  const ranges: ReviewLineRange[] = [];
  if (input.oldCount > 0) {
    ranges.push({ start: input.oldStart, end: input.oldStart + input.oldCount - 1 });
  }
  if (input.newCount > 0) {
    ranges.push({ start: input.newStart, end: input.newStart + input.newCount - 1 });
  }
  return {
    id: `hunk-${String(index + 1)}`,
    header: input.header,
    oldStart: input.oldStart,
    oldCount: input.oldCount,
    newStart: input.newStart,
    newCount: input.newCount,
    ranges,
    patch: input.lines.join('\n'),
  };
}

function splitLogicalLines(text: string): readonly string[] {
  if (text.length === 0) return [];
  const lines = text.split(/\r?\n/);
  if (text.endsWith('\n')) lines.pop();
  return lines;
}

function joinGitPath(kaos: Kaos, cwd: string, relativePath: string): string {
  const separator = kaos.pathClass() === 'win32' ? '\\' : '/';
  const normalizedRelativePath = relativePath.split('/').join(separator);
  const joined = cwd.endsWith('/') || cwd.endsWith('\\')
    ? `${cwd}${normalizedRelativePath}`
    : `${cwd}${separator}${normalizedRelativePath}`;
  return kaos.normpath(joined);
}

async function runGit(kaos: Kaos, args: readonly string[]): Promise<string> {
  const proc = await kaos.exec('git', '-C', kaos.getcwd(), ...args);
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
        reject(new Error(`git ${args.join(' ')} timed out`));
      }, GIT_TIMEOUT_MS);
    });
    const [stdout, stderr, exitCode] = await Promise.race([work, timeout]);
    if (exitCode !== 0) throw new Error(stderr.trim() || stdout.trim() || 'Git command failed');
    return stdout;
  } catch (error) {
    try {
      await proc.kill('SIGKILL');
    } catch {
      /* process already gone */
    }
    await work.catch(() => {});
    throw error;
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
