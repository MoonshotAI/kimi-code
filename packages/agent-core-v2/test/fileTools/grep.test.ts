/**
 * GrepTool tests for the v2 fileTools domain.
 *
 * Ported from v1 (`packages/agent-core/test/tools/grep.test.ts`) and adapted
 * to the v2 constructor `(fs, kaos, workspace)`. Self-contained: builds a
 * minimal fake `ISessionFsService` returning canned `FsGrepResponse`s so the tool's
 * argument mapping and result rendering can be exercised without the
 * composition root or a real ripgrep. The v1 tests that asserted on the exact
 * `rg` argv (which the tool no longer builds — `ISessionFsService.grep` owns the
 * subprocess) are intentionally dropped here.
 */

import type { FsGrepFileHit, FsGrepRequest, FsGrepResponse } from '@moonshot-ai/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { WorkspaceConfig } from '../../src/_base/tools/support/workspace';
import type { ISessionFsService } from '#/session/agentFs';
import {
  type GrepInput,
  GrepInputSchema,
  GrepTool,
} from '#/agent/fileTools/tools/grep';
import type { IHostEnvironment } from '#/app/hostEnvironment';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '#/agent/tool';

const signal = new AbortController().signal;
const workspace: WorkspaceConfig = { workspaceDir: '/workspace', additionalDirs: ['/extra'] };

function fileHit(path: string, lines: number[] = [1], text = 'hit'): FsGrepFileHit {
  return {
    path,
    matches: lines.map((line) => ({ line, col: 1, text, before: [], after: [] })),
  };
}

function emptyResponse(overrides: Partial<FsGrepResponse> = {}): FsGrepResponse {
  return { files: [], files_scanned: 0, truncated: false, elapsed_ms: 1, ...overrides };
}

function createFakeFs(
  response: FsGrepResponse | ((req: FsGrepRequest) => FsGrepResponse | Promise<FsGrepResponse>),
) {
  const grep = vi.fn(async (req: FsGrepRequest) =>
    typeof response === 'function' ? response(req) : response,
  );
  const fs = { grep } as unknown as ISessionFsService;
  return { fs, grep };
}

function createTestEnv(home = '/home'): IHostEnvironment {
  return {
    _serviceBrand: undefined,
    osKind: 'Linux',
    osArch: 'x86_64',
    osVersion: 'test',
    shellName: 'bash',
    shellPath: '/bin/bash',
    pathClass: 'posix',
    homeDir: home,
    ready: Promise.resolve(),
  };
}

function isPromiseLike(value: ToolExecution | Promise<ToolExecution>): value is Promise<ToolExecution> {
  return typeof (value as Promise<ToolExecution>).then === 'function';
}

async function execute(tool: GrepTool, args: GrepInput): Promise<ExecutableToolResult> {
  const resolved = tool.resolveExecution(args);
  const execution = isPromiseLike(resolved) ? await resolved : resolved;
  if (execution.isError === true) return execution;
  const ctx: ExecutableToolContext = {
    turnId: '0',
    toolCallId: 'call_grep',
    signal,
  };
  return execution.execute(ctx);
}

function toolContentString(result: ExecutableToolResult): string {
  const c = result.output;
  if (typeof c !== 'string') {
    throw new TypeError(`expected string content, got ${typeof c}`);
  }
  return c;
}

describe('GrepTool', () => {
  it('exposes current metadata and schema', () => {
    const { fs } = createFakeFs(emptyResponse());
    const tool = new GrepTool(fs, createTestEnv(), workspace);

    expect(tool.name).toBe('Grep');
    expect(tool.description).toContain('unknown content or unknown file locations');
    expect(tool.description).toContain('Do not use shell `grep` or `rg` directly');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: expect.stringContaining('Regular expression'),
        },
        path: {
          description: expect.stringContaining('Use Read instead'),
        },
      },
    });
    expect(GrepInputSchema.safeParse({ pattern: 'needle' }).success).toBe(true);
    expect(GrepInputSchema.safeParse({ pattern: 'needle', output_mode: 'content' }).success).toBe(
      true,
    );
    expect(GrepInputSchema.safeParse({ pattern: 'needle', output_mode: 'bad' }).success).toBe(
      false,
    );
    expect(
      GrepInputSchema.safeParse({ pattern: 'needle', output_mode: 'count_matches' }).success,
    ).toBe(true);
  });

  it('returns matching files in the default files_with_matches mode', async () => {
    const { fs, grep } = createFakeFs(
      emptyResponse({ files: [fileHit('src/a.ts'), fileHit('src/b.ts')] }),
    );
    const tool = new GrepTool(fs, createTestEnv(), workspace);

    const result = await execute(tool, { pattern: 'hit' });

    expect(toolContentString(result)).toBe('src/a.ts\nsrc/b.ts');
    expect(grep).toHaveBeenCalledTimes(1);
  });

  it('renders content matches as path:line:text', async () => {
    const { fs } = createFakeFs(
      emptyResponse({ files: [fileHit('src/a.ts', [10, 20])] }),
    );
    const tool = new GrepTool(fs, createTestEnv(), workspace);

    const result = await execute(tool, { pattern: 'hit', output_mode: 'content' });

    expect(toolContentString(result)).toBe('src/a.ts:10:hit\nsrc/a.ts:20:hit');
  });

  it('treats the pattern as a regex when calling the fs layer', async () => {
    const { fs, grep } = createFakeFs(emptyResponse({ files: [fileHit('src/a.ts')] }));
    const tool = new GrepTool(fs, createTestEnv(), workspace);

    await execute(tool, { pattern: 'foo|bar' });

    const req = grep.mock.calls[0]?.[0] as FsGrepRequest;
    expect(req.pattern).toBe('foo|bar');
    expect(req.regex).toBe(true);
  });

  it('maps -i to a case-insensitive request', async () => {
    const { fs, grep } = createFakeFs(emptyResponse({ files: [fileHit('src/a.ts')] }));
    const tool = new GrepTool(fs, createTestEnv(), workspace);

    await execute(tool, { pattern: 'Hit', '-i': true });

    const req = grep.mock.calls[0]?.[0] as FsGrepRequest;
    expect(req.case_sensitive).toBe(false);
  });

  it('is case-sensitive by default', async () => {
    const { fs, grep } = createFakeFs(emptyResponse({ files: [fileHit('src/a.ts')] }));
    const tool = new GrepTool(fs, createTestEnv(), workspace);

    await execute(tool, { pattern: 'Hit' });

    const req = grep.mock.calls[0]?.[0] as FsGrepRequest;
    expect(req.case_sensitive).toBe(true);
  });

  it('maps glob to include_globs and leaves exclude_globs empty', async () => {
    const { fs, grep } = createFakeFs(emptyResponse({ files: [fileHit('src/a.ts')] }));
    const tool = new GrepTool(fs, createTestEnv(), workspace);

    await execute(tool, { pattern: 'hit', glob: '*.ts' });

    const req = grep.mock.calls[0]?.[0] as FsGrepRequest;
    expect(req.include_globs).toEqual(['*.ts']);
    expect(req.exclude_globs).toBeUndefined();
  });

  it('passes an exclude-style glob through include_globs verbatim', async () => {
    const { fs, grep } = createFakeFs(emptyResponse({ files: [fileHit('src/a.ts')] }));
    const tool = new GrepTool(fs, createTestEnv(), workspace);

    await execute(tool, { pattern: 'hit', glob: '!**/*.test.ts' });

    const req = grep.mock.calls[0]?.[0] as FsGrepRequest;
    expect(req.include_globs).toEqual(['!**/*.test.ts']);
  });

  it('maps type to a recursive include glob', async () => {
    const { fs, grep } = createFakeFs(emptyResponse({ files: [fileHit('src/a.ts')] }));
    const tool = new GrepTool(fs, createTestEnv(), workspace);

    await execute(tool, { pattern: 'hit', type: 'ts' });

    const req = grep.mock.calls[0]?.[0] as FsGrepRequest;
    expect(req.include_globs).toEqual(['**/*.ts']);
  });

  it('maps include_ignored to follow_gitignore=false', async () => {
    const { fs, grep } = createFakeFs(emptyResponse({ files: [fileHit('src/a.ts')] }));
    const tool = new GrepTool(fs, createTestEnv(), workspace);

    await execute(tool, { pattern: 'hit', include_ignored: true });

    const req = grep.mock.calls[0]?.[0] as FsGrepRequest;
    expect(req.follow_gitignore).toBe(false);
  });

  it('surfaces fs-layer truncation as a warning', async () => {
    const { fs } = createFakeFs(
      emptyResponse({ files: [fileHit('src/a.ts')], truncated: true }),
    );
    const tool = new GrepTool(fs, createTestEnv(), workspace);

    const result = await execute(tool, { pattern: 'hit' });
    const output = toolContentString(result);

    expect(output).toContain('src/a.ts');
    expect(output).toContain('stopped early');
    expect(output).toContain('incomplete');
  });

  it('returns a clean no-match result', async () => {
    const { fs, grep } = createFakeFs(emptyResponse());
    const tool = new GrepTool(fs, createTestEnv(), workspace);

    const result = await execute(tool, { pattern: 'missing' });

    expect(result.isError).toBeFalsy();
    expect(toolContentString(result)).toBe('No matches found');
    expect(grep).toHaveBeenCalledTimes(1);
  });

  it('applies offset and head_limit pagination in files_with_matches mode', async () => {
    const { fs } = createFakeFs(
      emptyResponse({
        files: [fileHit('a.ts'), fileHit('b.ts'), fileHit('c.ts'), fileHit('d.ts')],
      }),
    );
    const tool = new GrepTool(fs, createTestEnv(), workspace);

    const result = await execute(tool, { pattern: 'hit', offset: 1, head_limit: 2 });
    const output = toolContentString(result);

    expect(output).toContain('b.ts');
    expect(output).toContain('c.ts');
    expect(output).not.toContain('a.ts');
    expect(output).not.toContain('d.ts');
    expect(output).toContain('Results truncated to 2 lines (total: 4). Use offset=3 to see more.');
  });

  it('treats head_limit zero as unlimited', async () => {
    const files = Array.from({ length: 260 }, (_, i) => fileHit(`src/${String(i)}.ts`));
    const { fs } = createFakeFs(emptyResponse({ files }));
    const tool = new GrepTool(fs, createTestEnv(), workspace);

    const result = await execute(tool, { pattern: 'hit', head_limit: 0 });
    const output = toolContentString(result);

    expect(output.split('\n')).toHaveLength(260);
    expect(output).not.toContain('Results truncated');
  });

  it('limits files_with_matches output to 250 lines by default', async () => {
    const files = Array.from({ length: 251 }, (_, i) => fileHit(`src/${String(i)}.ts`));
    const { fs } = createFakeFs(emptyResponse({ files }));
    const tool = new GrepTool(fs, createTestEnv(), workspace);

    const result = await execute(tool, { pattern: 'hit' });
    const output = toolContentString(result);

    expect(output).toContain('src/0.ts');
    expect(output).toContain('src/249.ts');
    expect(output).not.toContain('src/250.ts');
    expect(output).toContain(
      'Results truncated to 250 lines (total: 251). Use offset=250 to see more.',
    );
  });

  it('summarizes count_matches on the message channel', async () => {
    const { fs } = createFakeFs(
      emptyResponse({ files: [fileHit('src/a.ts', [1, 2, 3]), fileHit('src/b.ts', [1, 2])] }),
    );
    const tool = new GrepTool(fs, createTestEnv(), workspace);

    const result = await execute(tool, { pattern: 'hit', output_mode: 'count_matches' });

    expect(toolContentString(result)).toBe('src/a.ts:3\nsrc/b.ts:2');
    expect(result.message).toBe('Found 5 total occurrences across 2 files.');
  });

  it('keeps count data pure and routes pagination to the message channel', async () => {
    const { fs } = createFakeFs(
      emptyResponse({ files: [fileHit('a.ts', [1]), fileHit('b.ts', [1]), fileHit('c.ts', [1])] }),
    );
    const tool = new GrepTool(fs, createTestEnv(), workspace);

    const result = await execute(tool, {
      pattern: 'hit',
      output_mode: 'count_matches',
      head_limit: 2,
    });
    const output = toolContentString(result);

    expect(output).toBe('a.ts:1\nb.ts:1');
    expect(result.message).toContain('Found 3 total occurrences across 3 files.');
    expect(result.message).toContain('Results truncated to 2 lines (total: 3). Use offset=2 to see more.');
  });

  it('filters sensitive files and appends a warning', async () => {
    const { fs } = createFakeFs(
      emptyResponse({ files: [fileHit('src/main.ts'), fileHit('.env')] }),
    );
    const tool = new GrepTool(fs, createTestEnv(), workspace);

    const result = await execute(tool, { pattern: 'hit' });
    const output = toolContentString(result);

    expect(output).toContain('src/main.ts');
    expect(output).not.toContain('.env:');
    expect(output).toContain('Filtered 1 sensitive file(s): .env');
  });

  it('reports no non-sensitive matches when every result is sensitive', async () => {
    const { fs } = createFakeFs(emptyResponse({ files: [fileHit('.env')] }));
    const tool = new GrepTool(fs, createTestEnv(), workspace);

    const result = await execute(tool, { pattern: 'hit', output_mode: 'content' });
    const output = toolContentString(result);

    expect(output).toContain('No non-sensitive matches found');
    expect(output).toContain('Filtered 1 sensitive file(s): .env');
  });

  it('renders context lines with computed line numbers in content mode', async () => {
    const { fs } = createFakeFs(
      emptyResponse({
        files: [
          {
            path: 'src/a.ts',
            matches: [
              {
                line: 5,
                col: 1,
                text: 'match',
                before: ['pre'],
                after: ['post'],
              },
            ],
          },
        ],
      }),
    );
    const tool = new GrepTool(fs, createTestEnv(), workspace);

    const result = await execute(tool, { pattern: 'match', output_mode: 'content', '-C': 1 });

    expect(toolContentString(result)).toBe('src/a.ts-4-pre\nsrc/a.ts:5:match\nsrc/a.ts-6-post');
  });

  it('aborts before searching when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { fs, grep } = createFakeFs(emptyResponse({ files: [fileHit('src/a.ts')] }));
    const tool = new GrepTool(fs, createTestEnv(), workspace);

    const resolved = tool.resolveExecution({ pattern: 'hit' });
    const execution = isPromiseLike(resolved) ? await resolved : resolved;
    if (execution.isError === true) throw new TypeError('expected runnable execution');
    const result = await execution.execute({
      turnId: '0',
      toolCallId: 'call_grep',
      signal: controller.signal,
    });

    expect(result).toEqual({ isError: true, output: 'Aborted before search started' });
    expect(grep).not.toHaveBeenCalled();
  });

  it('maps an fs timeout error to a friendly message', async () => {
    const { KimiError, ErrorCodes } = await import('../../src/errors');
    const { fs } = createFakeFs(() => {
      throw new KimiError(ErrorCodes.FS_GREP_TIMEOUT, 'grep timed out after 30000ms');
    });
    const tool = new GrepTool(fs, createTestEnv(), workspace);

    const result = await execute(tool, { pattern: 'slow' });

    expect(result).toEqual({
      isError: true,
      output: 'Grep timed out. Try a more specific path or pattern.',
    });
  });
});
