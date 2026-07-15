/**
 * WriteTool tests for the v2 fileTools domain.
 *
 * Ported from v1 (`packages/agent-core/test/tools/write.test.ts`) and adapted
 * to the v2 constructor `(fs, env, workspace)`. Self-contained: builds a
 * minimal fake `IHostFileSystem` inline so the tool can be exercised without
 * the composition root.
 *
 * Append is routed through `IHostFileSystem.appendText` (a native append), so
 * the tool no longer reads the existing file. The append-call assertions below
 * reflect that single-call mechanic.
 */

import { describe, expect, it, vi } from 'vitest';

import { PathSecurityError } from '#/tool/path-access';
import type { HostFileStat, IHostFileSystem } from '#/os/interface/hostFileSystem';
import { stubWorkspaceContext } from '../../../../session/workspaceContext/stub-workspace-context';
import { type WriteInput, WriteInputSchema, WriteTool } from '#/os/backends/node-local/tools/write';
import type { IHostEnvironment } from '#/os/interface/hostEnvironment';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '#/tool/toolContract';

const signal = new AbortController().signal;
const PERMISSIVE_WORKSPACE = stubWorkspaceContext('/');

function toolContentString(result: ExecutableToolResult): string {
  const c = result.output;
  if (typeof c !== 'string') {
    throw new TypeError(`expected string content, got ${typeof c}`);
  }
  return c;
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

interface WriteFsOptions {
  readText?: (path: string) => Promise<string>;
  writeText?: (path: string, data: string) => Promise<void>;
  appendText?: (path: string, data: string) => Promise<void>;
  stat?: (path: string) => Promise<HostFileStat>;
  mkdir?: (path: string) => Promise<void>;
}

function createWriteFs(options: WriteFsOptions = {}) {
  const readText = vi.fn(
    options.readText ??
      (async () => {
        throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
      }),
  );
  const writeText = vi.fn(options.writeText ?? (async () => {}));
  const appendText = vi.fn(options.appendText ?? (async () => {}));
  const stat = vi.fn(
    options.stat ?? (async () => ({ isFile: false, isDirectory: true, size: 0 })),
  );
  const mkdir = vi.fn(options.mkdir ?? (async () => {}));
  const fs = { cwd: '/', readText, writeText, appendText, stat, mkdir } as unknown as IHostFileSystem;
  return { fs, readText, writeText, appendText, stat, mkdir };
}

function makeTool(options: WriteFsOptions = {}, workspace = PERMISSIVE_WORKSPACE) {
  const fakes = createWriteFs(options);
  const tool = new WriteTool(fakes.fs, createTestEnv(), workspace);
  return { tool, ...fakes };
}

function isPromiseLike(value: ToolExecution | Promise<ToolExecution>): value is Promise<ToolExecution> {
  return typeof (value as Promise<ToolExecution>).then === 'function';
}

async function execute(tool: WriteTool, args: WriteInput): Promise<ExecutableToolResult> {
  let execution: ToolExecution;
  try {
    const resolved = tool.resolveExecution(args);
    execution = isPromiseLike(resolved) ? await resolved : resolved;
  } catch (error) {
    const output =
      error instanceof PathSecurityError
        ? error.message
        : `Tool "${tool.name}" failed to resolve execution: ${
            error instanceof Error ? error.message : String(error)
          }`;
    return { isError: true, output };
  }
  if (execution.isError === true) return execution;
  const ctx: ExecutableToolContext = {
    turnId: 0,
    toolCallId: 'call_write',
    signal,
  };
  return execution.execute(ctx);
}

describe('WriteTool', () => {
  it('exposes current metadata and schema', () => {
    const { tool } = makeTool();

    expect(tool.name).toBe('Write');
    expect(tool.description).toContain('append adds content at EOF without adding a newline');
    expect(tool.description).toContain('\\n stays LF, \\r\\n stays CRLF');
    expect(tool.description).toContain('Write is NOT ALLOWED for incremental changes');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: expect.stringContaining('Raw full file content'),
        },
        mode: {
          enum: ['overwrite', 'append'],
          description: expect.stringContaining('Defaults to overwrite'),
        },
      },
    });
    expect(WriteInputSchema.safeParse({ path: '/tmp/out.txt', content: 'hello' }).success).toBe(
      true,
    );
    expect(
      WriteInputSchema.safeParse({ path: '/tmp/out.txt', content: 'hello', mode: 'append' })
        .success,
    ).toBe(true);
    expect(
      WriteInputSchema.safeParse({ path: '/tmp/out.txt', content: 'hello', mode: 'bad' }).success,
    ).toBe(false);
    expect(WriteInputSchema.safeParse({ path: '/tmp/out.txt' }).success).toBe(false);
  });

  it('describes the working-directory rule for the path parameter', () => {
    const { tool } = makeTool();
    const params = tool.parameters as {
      properties: { path: { description: string } };
    };

    expect(params.properties.path.description).toContain('working directory');
    expect(params.properties.path.description).toMatch(/relative/i);
    expect(params.properties.path.description).toMatch(/absolute/i);
  });

  it('exposes the content on the file_io display so the approval panel can preview it', () => {
    const { tool } = makeTool();
    const execution = tool.resolveExecution({
      path: '/tmp/new.txt',
      content: 'hello\nworld',
    });
    if (execution.isError === true) {
      throw new TypeError('expected runnable execution');
    }
    expect(execution.display).toEqual({
      kind: 'file_io',
      operation: 'write',
      path: '/tmp/new.txt',
      content: 'hello\nworld',
    });
  });

  it('matches permission args with negated glob path semantics', () => {
    const { tool } = makeTool({}, stubWorkspaceContext('/workspace'));
    const insideSrc = tool.resolveExecution({ path: './src/a.ts', content: 'x' });
    const outsideSrc = tool.resolveExecution({ path: './README.md', content: 'x' });
    if (insideSrc.isError === true || outsideSrc.isError === true) {
      throw new TypeError('expected runnable execution');
    }

    expect(insideSrc.matchesRule?.('!./src/**')).toBe(false);
    expect(outsideSrc.matchesRule?.('!./src/**')).toBe(true);
  });

  it('guides batching large content across multiple write calls', () => {
    const { tool } = makeTool();

    expect(tool.description).toMatch(/large/i);
    expect(tool.description).toContain('content too large for one call');
    expect(tool.description).toMatch(/overwrite[^.]*first chunk[^.]*then[^.]*append/i);
  });

  it('writes content through fs and reports bytes written', async () => {
    const { tool, writeText } = makeTool();

    const result = await execute(tool, { path: '/tmp/new.txt', content: 'hello' });

    expect(writeText).toHaveBeenCalledWith('/tmp/new.txt', 'hello');
    expect(result.output).toContain('Wrote 5 bytes');
  });

  it('expands leading tilde paths using the kaos home directory', async () => {
    const fakes = createWriteFs();
    const tool = new WriteTool(fakes.fs, createTestEnv('/home/test'), PERMISSIVE_WORKSPACE);

    const result = await execute(tool, { path: '~/notes/today.txt', content: 'hello' });

    expect(fakes.writeText).toHaveBeenCalledWith('/home/test/notes/today.txt', 'hello');
    expect(result.output).toContain('Wrote 5 bytes');
  });

  it('appends content through appendText without reading existing bytes', async () => {
    const { tool, readText, writeText, appendText } = makeTool();

    const result = await execute(tool, {
      path: '/tmp/existing.txt',
      content: '\nhello',
      mode: 'append',
    });

    expect(appendText).toHaveBeenCalledWith('/tmp/existing.txt', '\nhello');
    expect(readText).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    expect(result.output).toContain('Appended 6 bytes');
  });

  it('reports the real UTF-8 byte count for non-ASCII content', async () => {
    const content = 'こんにちは。';
    const expectedBytes = Buffer.byteLength(content, 'utf8');
    expect(expectedBytes).toBe(18);

    const { tool } = makeTool();

    const result = await execute(tool, { path: '/tmp/jp.txt', content });

    expect(result.output).toContain('Wrote 18 bytes');
    expect(result.output).not.toContain('Wrote 6 bytes');
  });

  it('reports the real UTF-8 byte count for content with surrogate-pair emoji', async () => {
    const content = 'hi😀';
    expect(content.length).toBe(4);
    const expectedBytes = Buffer.byteLength(content, 'utf8');
    expect(expectedBytes).toBe(6);

    const { tool } = makeTool();

    const result = await execute(tool, { path: '/tmp/emoji.txt', content });

    expect(result.output).toContain('Wrote 6 bytes');
    expect(result.output).not.toContain('Wrote 4 bytes');
  });

  it('reports the real UTF-8 byte count for non-ASCII append content', async () => {
    const content = 'café';
    const expectedBytes = Buffer.byteLength(content, 'utf8');
    expect(expectedBytes).toBe(5);

    const { tool, appendText } = makeTool();

    const result = await execute(tool, { path: '/tmp/menu.txt', content, mode: 'append' });

    expect(appendText).toHaveBeenCalledWith('/tmp/menu.txt', 'café');
    expect(result.output).toContain('Appended 5 bytes');
  });

  it('creates missing parent directories automatically before writing', async () => {
    const enoent = Object.assign(new Error('ENOENT: no such file or directory'), {
      code: 'ENOENT',
    });
    const { tool, mkdir, writeText } = makeTool({ stat: vi.fn().mockRejectedValue(enoent) });

    const result = await execute(tool, { path: '/tmp/missing-dir/file.txt', content: 'data' });

    expect(result.isError).toBeFalsy();
    expect(mkdir).toHaveBeenCalledWith('/tmp/missing-dir', { recursive: true });
    expect(writeText).toHaveBeenCalledWith('/tmp/missing-dir/file.txt', 'data');
  });

  it('surfaces mkdir failures when a missing parent cannot be created', async () => {
    const enoent = Object.assign(new Error('ENOENT: no such file or directory'), {
      code: 'ENOENT',
    });
    const { tool, writeText } = makeTool({
      stat: vi.fn().mockRejectedValue(enoent),
      mkdir: vi.fn().mockRejectedValue(new Error('permission denied')),
    });

    const result = await execute(tool, { path: '/tmp/missing-dir/file.txt', content: 'data' });

    expect(result).toMatchObject({ isError: true, output: 'permission denied' });
    expect(writeText).not.toHaveBeenCalled();
  });

  it('rejects writing when the parent path is not a directory', async () => {
    const { tool, writeText } = makeTool({
      stat: vi.fn().mockResolvedValue({ isFile: true, isDirectory: false, size: 0 }),
    });

    const result = await execute(tool, { path: '/tmp/a-file/child.txt', content: 'data' });

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toMatch(/not a directory/i);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('writes when the parent directory exists', async () => {
    const { tool, writeText } = makeTool({
      stat: vi.fn().mockResolvedValue({ isFile: false, isDirectory: true, size: 0 }),
    });

    const result = await execute(tool, { path: '/tmp/exists/file.txt', content: 'data' });

    expect(result.isError).toBeUndefined();
    expect(writeText).toHaveBeenCalledWith('/tmp/exists/file.txt', 'data');
  });

  it('surfaces fs write failures as tool errors', async () => {
    const { tool } = makeTool({
      writeText: vi.fn().mockRejectedValue(new Error('disk full')),
    });

    const result = await execute(tool, { path: '/some/file.txt', content: 'data' });

    expect(result).toMatchObject({ isError: true, output: 'disk full' });
  });

  it('allows explicit absolute writes outside the workspace', async () => {
    const { tool, writeText } = makeTool({}, stubWorkspaceContext('/workspace'));

    const result = await execute(tool, { path: '/tmp/pwned.txt', content: 'x' });

    expect(result.isError).toBeUndefined();
    expect(writeText).toHaveBeenCalledWith('/tmp/pwned.txt', 'x');
  });

  it('rejects relative traversal writes before fs I/O', async () => {
    const { tool, writeText } = makeTool(
      {},
      stubWorkspaceContext('/workspace/project'),
    );

    const result = await execute(tool, { path: '../outside.txt', content: 'x' });

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('absolute path');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('blocks sensitive file writes', async () => {
    const { tool, writeText } = makeTool({}, stubWorkspaceContext('/workspace'));

    const result = await execute(tool, { path: '/workspace/id_rsa', content: 'key' });

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('sensitive-file pattern');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('round-trips unicode content (CJK + emoji + accented Latin) through fs.writeText', async () => {
    const { tool, writeText } = makeTool();
    const content = 'Hello 世界 🌍\nUnicode: café, naïve, résumé';

    const result = await execute(tool, { path: '/tmp/unicode.txt', content });

    expect(result.isError).toBeFalsy();
    expect(writeText).toHaveBeenCalledWith('/tmp/unicode.txt', content);
  });

  it('writes empty content as a zero-byte file via fs.writeText("")', async () => {
    const { tool, writeText } = makeTool();

    const result = await execute(tool, { path: '/tmp/empty.txt', content: '' });

    expect(result.isError).toBeFalsy();
    expect(writeText).toHaveBeenCalledWith('/tmp/empty.txt', '');
  });

  it('still reports parent-directory ENOENT surfaced by writeText itself', async () => {
    const { tool } = makeTool({
      writeText: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }),
        ),
    });

    const result = await execute(tool, { path: '/tmp/missing-dir/file.txt', content: 'data' });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('parent directory does not exist');
  });

  it('appending to a nonexistent file creates it with just the appended bytes', async () => {
    const { tool, readText, appendText } = makeTool();

    const result = await execute(tool, {
      path: '/tmp/new-append.txt',
      content: 'New content',
      mode: 'append',
    });

    expect(result.isError).toBeFalsy();
    expect(toolContentString(result).toLowerCase()).toContain('appended');
    expect(appendText).toHaveBeenCalledWith('/tmp/new-append.txt', 'New content');
    expect(readText).not.toHaveBeenCalled();
  });

  it('allows absolute writes to a sibling dir that merely shares the work-dir prefix', async () => {
    const { tool, writeText } = makeTool({}, stubWorkspaceContext('/workspace'));

    const result = await execute(tool, { path: '/workspace-sneaky/file.txt', content: 'content' });

    expect(result.isError).toBeFalsy();
    expect(writeText).toHaveBeenCalledWith('/workspace-sneaky/file.txt', 'content');
  });
});
