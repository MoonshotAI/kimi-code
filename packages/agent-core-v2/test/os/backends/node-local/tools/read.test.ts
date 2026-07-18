/**
 * ReadTool tests for the v2 fileTools domain.
 *
 * Ported from v1 (`packages/agent-core/test/tools/read.test.ts`) and adapted
 * to the v2 constructor `(fs, env, workspace)`. Self-contained: builds a
 * minimal fake `IHostFileSystem` inline so the tool can be exercised without
 * the composition root.
 *
 * The v1 fast-path tests (`scanTextFile` / `readLineRange` / `readTailLines` /
 * `readTextPreview`) are intentionally dropped: `IHostFileSystem` streams
 * through `readLines` only, so `readForward` / `readTail` always take the
 * line-iteration path.
 *
 * The status block rides the result's `note` side channel (rendered to the
 * model at projection time, never to UIs); the tool keeps its own `<system>`
 * wrapping as a wording choice, and `output` is the rendered file content
 * and nothing else.
 */

import { describe, expect, it, vi } from 'vitest';

import { PathSecurityError } from '#/tool/path-access';
import { MEDIA_SNIFF_BYTES } from '#/agent/media/file-type';
import type { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { stubWorkspaceContext } from '../../../../session/workspaceContext/stub-workspace-context';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import {
  MAX_BYTES,
  MAX_LINE_LENGTH,
  MAX_LINES,
  type ReadInput,
  ReadInputSchema,
  ReadTool,
} from '#/os/backends/node-local/tools/read';
import type { IHostEnvironment } from '#/os/interface/hostEnvironment';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '#/tool/toolContract';

const signal = new AbortController().signal;
const PERMISSIVE_WORKSPACE = stubWorkspaceContext('/');

function linesFromContent(content: string): string[] {
  if (content === '') return [];
  const rawLines = content.split('\n');
  return rawLines.flatMap((line, index) => {
    if (index < rawLines.length - 1) return [`${line}\n`];
    return line === '' ? [] : [line];
  });
}

async function* generateLines(content: string): AsyncGenerator<string> {
  for (const line of linesFromContent(content)) {
    yield line;
  }
}

function readNote(status: string): string {
  return `<system>${status}</system>`;
}

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

function createSpiedFs(content: string) {
  const bytes = Buffer.from(content, 'utf8');
  const readBytes = vi.fn(async (_path: string, n?: number) =>
    n === undefined ? bytes : bytes.subarray(0, n),
  );
  const readLines = vi.fn().mockImplementation(() => generateLines(content));
  const readText = vi.fn(async () => content);
  const stat = vi.fn(async () => ({ isFile: true, isDirectory: false, size: bytes.length }));
  const fs = { cwd: '/', readBytes, readLines, readText, stat } as unknown as IHostFileSystem;
  return { fs, readBytes, readLines, readText, stat };
}

interface FakeFile {
  readonly bytes: Buffer;
  readonly isFile?: boolean;
  readonly isDirectory?: boolean;
  readonly size?: number;
  readonly readLines?: (
    path: string,
    options?: { errors?: 'strict' | 'replace' | 'ignore' },
  ) => AsyncGenerator<string>;
}

function createSpiedMapFs(files: Record<string, FakeFile>) {
  const lookup = (path: string): FakeFile | undefined => files[path];
  const readBytes = vi.fn(async (path: string, n?: number) => {
    const data = lookup(path)?.bytes ?? Buffer.alloc(0);
    return n === undefined ? data : data.subarray(0, n);
  });
  const readLines = vi
    .fn()
    .mockImplementation((path: string, options?: { errors?: 'strict' | 'replace' | 'ignore' }) => {
      const file = lookup(path);
      if (file?.readLines !== undefined) return file.readLines(path, options);
      return generateLines((file?.bytes ?? Buffer.alloc(0)).toString('utf8'));
    });
  const readText = vi.fn(async (path: string) =>
    (lookup(path)?.bytes ?? Buffer.alloc(0)).toString('utf8'),
  );
  const stat = vi.fn(async (path: string) => {
    const file = lookup(path);
    if (file === undefined) {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }
    return {
      isFile: file.isFile ?? true,
      isDirectory: file.isDirectory ?? false,
      size: file.size ?? file.bytes.length,
    };
  });
  const fs = { cwd: '/', readBytes, readLines, readText, stat } as unknown as IHostFileSystem;
  return { fs, readBytes, readLines, readText, stat };
}

function toolWithContent(content: string, workspace = PERMISSIVE_WORKSPACE) {
  return new ReadTool(createSpiedFs(content).fs, createTestEnv(), workspace);
}

function isPromiseLike(value: ToolExecution | Promise<ToolExecution>): value is Promise<ToolExecution> {
  return typeof (value as Promise<ToolExecution>).then === 'function';
}

async function execute(tool: ReadTool, args: ReadInput): Promise<ExecutableToolResult> {
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
    toolCallId: 'call_read',
    signal,
  };
  return execution.execute(ctx);
}

describe('ReadTool', () => {
  it('exposes current metadata and schema', () => {
    const tool = toolWithContent('');

    expect(tool.name).toBe('Read');
    expect(tool.description).toContain('concrete file path');
    expect(tool.description).toContain('Pure CRLF files are displayed with LF');
    expect(tool.description).not.toContain('skip the verification re-read');
    expect(tool.description).toContain('final external contract');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: expect.stringContaining('working directory'),
        },
        line_offset: {
          description: expect.stringContaining('line number to start reading from'),
        },
        n_lines: {
          description: expect.stringContaining('number of lines to read'),
        },
      },
    });
    expect(ReadInputSchema.safeParse({ path: '/tmp/test.txt' }).success).toBe(true);
    expect(
      ReadInputSchema.safeParse({ path: '/tmp/test.txt', line_offset: 1, n_lines: 2 }).success,
    ).toBe(true);
    expect(ReadInputSchema.safeParse({ path: '/tmp/test.txt', line_offset: 0 }).success).toBe(
      false,
    );
    expect(
      ReadInputSchema.safeParse({ path: '/tmp/test.txt', line_offset: -(MAX_LINES + 1) }).success,
    ).toBe(false);
  });

  it('matches permission args with glob path semantics', () => {
    const tool = toolWithContent('');
    const execution = tool.resolveExecution({ path: '/etc/passwd' });
    if (execution.isError === true) throw new TypeError('expected runnable execution');

    expect(execution.matchesRule?.('/etc/**')).toBe(true);
    expect(execution.matchesRule?.('/var/**')).toBe(false);
  });

  it('reads text content with stable one-based line numbers', async () => {
    const tool = toolWithContent('alpha\nbeta\n');

    const result = await execute(tool, { path: '/tmp/a.txt' });

    expect(result).toEqual({
      output: '1\talpha\n2\tbeta',
      note: readNote(
        '2 lines read from file starting from line 1. Total lines in file: 2. End of file reached.',
      ),
    });
  });

  it('normalizes pure CRLF files to the LF model view', async () => {
    const tool = toolWithContent('alpha\r\nbeta\r\n');

    const result = await execute(tool, { path: '/tmp/a.txt' });

    expect(result.output).toBe(['1\talpha', '2\tbeta'].join('\n'));
    expect(result.note).toBe(
      readNote(
        '2 lines read from file starting from line 1. Total lines in file: 2. End of file reached.',
      ),
    );
  });

  it('makes mixed carriage returns visible instead of normalizing them', async () => {
    const tool = toolWithContent('alpha\r\nbeta\ngamma\rdone');

    const result = await execute(tool, { path: '/tmp/a.txt' });

    expect(result.output).toBe(['1\talpha\\r', '2\tbeta', '3\tgamma\\rdone'].join('\n'));
    expect(result.note).toBe(
      readNote(
        '3 lines read from file starting from line 1. Total lines in file: 3. End of file reached. Mixed or lone carriage-return line endings are shown as \\r. Use exact \\r\\n or \\r escapes in Edit.old_string for those lines.',
      ),
    );
  });

  it('respects one-based line_offset and positive n_lines', async () => {
    const tool = toolWithContent('a\nb\nc\nd\ne');

    const result = await execute(tool, { path: '/tmp/a.txt', line_offset: 2, n_lines: 2 });

    expect(result).toEqual({
      output: '2\tb\n3\tc',
      note: readNote('2 lines read from file starting from line 2. Total lines in file: 5.'),
    });
  });

  it('returns an empty successful output when line_offset is beyond EOF', async () => {
    const tool = toolWithContent('a\nb');

    const result = await execute(tool, { path: '/tmp/a.txt', line_offset: 20 });

    expect(result).toEqual({
      output: '',
      note: readNote('No lines read from file. Total lines in file: 2. End of file reached.'),
    });
  });

  it('supports negative line_offset as tail mode with absolute line numbers', async () => {
    const tool = toolWithContent('a\nb\nc\nd\ne');

    const result = await execute(tool, { path: '/tmp/a.txt', line_offset: -3 });

    expect(result).toEqual({
      output: '3\tc\n4\td\n5\te',
      note: readNote(
        '3 lines read from file starting from line 3. Total lines in file: 5. End of file reached.',
      ),
    });
  });

  it('applies n_lines from the start of the negative line_offset tail window', async () => {
    const tool = toolWithContent('a\nb\nc\nd\ne');

    const result = await execute(tool, { path: '/tmp/a.txt', line_offset: -5, n_lines: 2 });

    expect(result.output).toBe('1\ta\n2\tb');
    expect(result.note).toBe(
      readNote('2 lines read from file starting from line 1. Total lines in file: 5.'),
    );
  });

  it('rejects relative traversal before reading', async () => {
    const { fs, readText } = createSpiedFs('secret');
    const tool = new ReadTool(fs, createTestEnv(), stubWorkspaceContext('/workspace/project'));

    const result = await execute(tool, { path: '../../outside.txt' });

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('absolute path');
    expect(readText).not.toHaveBeenCalled();
  });

  it('allows relative traversal into a skill root the session catalog provides', async () => {
    const { fs } = createSpiedFs('skill body');
    const skillCatalog = {
      _serviceBrand: undefined,
      catalog: { getSkillRoots: () => ['/skills'] },
    } as unknown as ISessionSkillCatalog;
    const tool = new ReadTool(
      fs,
      createTestEnv(),
      stubWorkspaceContext('/workspace/project'),
      skillCatalog,
    );

    const result = await execute(tool, { path: '../../skills/SKILL.md' });

    expect(result.isError ?? false).toBe(false);
    expect(result.output).toBe('1\tskill body');
  });

  it('allows explicit absolute paths outside the workspace', async () => {
    const { fs, readBytes, readLines } = createSpiedFs('external');
    const tool = new ReadTool(fs, createTestEnv(), stubWorkspaceContext('/workspace'));

    const result = await execute(tool, { path: '/tmp/external.txt' });

    expect(result.output).toBe('1\texternal');
    expect(result.note).toBe(
      readNote(
        '1 line read from file starting from line 1. Total lines in file: 1. End of file reached.',
      ),
    );
    expect(readBytes).toHaveBeenCalledWith('/tmp/external.txt', MEDIA_SNIFF_BYTES);
    expect(readLines).toHaveBeenCalledWith('/tmp/external.txt', { errors: 'strict' });
  });

  it('returns a friendly error for missing files before sniffing bytes', async () => {
    const { fs, readBytes, readLines } = createSpiedMapFs({});
    const tool = new ReadTool(fs, createTestEnv(), stubWorkspaceContext('/workspace'));

    const result = await execute(tool, { path: '/workspace/missing.txt' });

    expect(result).toEqual({
      isError: true,
      output: '"/workspace/missing.txt" does not exist.',
    });
    expect(readBytes).not.toHaveBeenCalled();
    expect(readLines).not.toHaveBeenCalled();
  });

  it('returns a friendly error for directories before sniffing bytes', async () => {
    const { fs, readBytes, readLines } = createSpiedMapFs({
      '/workspace/src': { bytes: Buffer.alloc(0), isFile: false, isDirectory: true },
    });
    const tool = new ReadTool(fs, createTestEnv(), stubWorkspaceContext('/workspace'));

    const result = await execute(tool, { path: '/workspace/src' });

    expect(result).toEqual({
      isError: true,
      output: '"/workspace/src" is not a file.',
    });
    expect(readBytes).not.toHaveBeenCalled();
    expect(readLines).not.toHaveBeenCalled();
  });

  it('expands leading tilde paths using the kaos home directory', async () => {
    const { fs, readBytes, readLines } = createSpiedFs('home note');
    const tool = new ReadTool(fs, createTestEnv('/home/test'), stubWorkspaceContext('/workspace'));

    const result = await execute(tool, { path: '~/notes/today.txt' });

    expect(result.output).toBe('1\thome note');
    expect(result.note).toBe(
      readNote(
        '1 line read from file starting from line 1. Total lines in file: 1. End of file reached.',
      ),
    );
    expect(readBytes).toHaveBeenCalledWith('/home/test/notes/today.txt', MEDIA_SNIFF_BYTES);
    expect(readLines).toHaveBeenCalledWith('/home/test/notes/today.txt', { errors: 'strict' });
  });

  it('blocks sensitive files independently from workspace access', async () => {
    const { fs, readText } = createSpiedFs('SECRET=value');
    const tool = new ReadTool(fs, createTestEnv(), stubWorkspaceContext('/workspace'));

    const result = await execute(tool, { path: '/workspace/.env' });

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('sensitive-file pattern');
    expect(readText).not.toHaveBeenCalled();
  });

  it('rejects image files before text decoding and points to ReadMediaFile', async () => {
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { fs, readText } = createSpiedMapFs({
      '/tmp/sample.png': { bytes: pngHeader },
    });
    const tool = new ReadTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE);

    const result = await execute(tool, { path: '/tmp/sample.png' });
    const output = toolContentString(result);

    expect(result.isError).toBe(true);
    expect(output).toMatch(/image file/i);
    expect(output).toMatch(/ReadMediaFile|media/i);
    expect(readText).not.toHaveBeenCalled();
  });

  it('rejects an image-extension file whose bytes are not an image as not readable', async () => {
    const plainText = Buffer.from('this is plain ascii text, not a png');
    const { fs, readText } = createSpiedMapFs({
      '/tmp/fake.png': { bytes: plainText },
    });
    const tool = new ReadTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE);

    const result = await execute(tool, { path: '/tmp/fake.png' });
    const output = toolContentString(result);

    expect(result.isError).toBe(true);
    expect(output).toBe(
      '"/tmp/fake.png" is not readable as UTF-8 text. If it is an image or video, use ReadMediaFile. For other binary formats, use Bash or an MCP tool if available.',
    );
    expect(readText).not.toHaveBeenCalled();
  });

  it('rejects extensionless image files using magic-byte sniffing', async () => {
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { fs, readText } = createSpiedMapFs({
      '/tmp/sample': { bytes: pngHeader },
    });
    const tool = new ReadTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE);

    const result = await execute(tool, { path: '/tmp/sample' });
    const output = toolContentString(result);

    expect(result.isError).toBe(true);
    expect(output).toMatch(/image file/i);
    expect(readText).not.toHaveBeenCalled();
  });

  it('rejects video files before text decoding', async () => {
    const mp4Header = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18]),
      Buffer.from('ftyp'),
      Buffer.from('mp42'),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
      Buffer.from('mp42isom'),
    ]);
    const { fs, readText } = createSpiedMapFs({
      '/tmp/sample.mp4': { bytes: mp4Header },
    });
    const tool = new ReadTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE);

    const result = await execute(tool, { path: '/tmp/sample.mp4' });
    const output = toolContentString(result);

    expect(result.isError).toBe(true);
    expect(output).toMatch(/video file/i);
    expect(output).toMatch(/ReadMediaFile|media/i);
    expect(readText).not.toHaveBeenCalled();
  });

  it('rejects NUL-containing binary files before text decoding', async () => {
    const header = Buffer.concat([Buffer.from('plain prefix'), Buffer.from([0x00, 0x01])]);
    const { fs, readText } = createSpiedMapFs({
      '/tmp/blob.bin': { bytes: header },
    });
    const tool = new ReadTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE);

    const result = await execute(tool, { path: '/tmp/blob.bin' });
    const output = toolContentString(result);

    expect(result.isError).toBe(true);
    expect(output).toBe(
      '"/tmp/blob.bin" is not readable as UTF-8 text. If it is an image or video, use ReadMediaFile. For other binary formats, use Bash or an MCP tool if available.',
    );
    expect(output).not.toContain('Python tools');
    expect(readText).not.toHaveBeenCalled();
  });

  it('rejects NUL bytes that appear after the preflight header', async () => {
    const header = Buffer.from('text prefix without nul', 'utf8');
    const { fs } = createSpiedMapFs({
      '/tmp/blob-with-late-nul': {
        bytes: header,
        readLines: async function* readLines(): AsyncGenerator<string> {
          yield 'safe text\n';
          yield `binary${String.fromCodePoint(0)}tail\n`;
        },
      },
    });
    const tool = new ReadTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE);

    const result = await execute(tool, { path: '/tmp/blob-with-late-nul' });
    const output = toolContentString(result);

    expect(result.isError).toBe(true);
    expect(output).toBe(
      '"/tmp/blob-with-late-nul" is not readable as UTF-8 text. If it is an image or video, use ReadMediaFile. For other binary formats, use Bash or an MCP tool if available.',
    );
    expect(output).not.toContain('Python tools');
  });

  it('rejects invalid UTF-8 instead of returning replacement characters', async () => {
    const replacement = String.fromCodePoint(0xfffd);
    const { fs } = createSpiedMapFs({
      '/tmp/not-utf8.txt': {
        bytes: Buffer.from('text header'),
        readLines: async function* readLines(
          _path: string,
          options?: { errors?: 'strict' | 'replace' | 'ignore' },
        ): AsyncGenerator<string> {
          if (options?.errors === 'strict') {
            throw new TypeError('The encoded data was not valid for encoding utf-8');
          }
          yield `bad${replacement}text\n`;
        },
      },
    });
    const tool = new ReadTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE);

    const result = await execute(tool, { path: '/tmp/not-utf8.txt' });
    const output = toolContentString(result);

    expect(result.isError).toBe(true);
    expect(output).toBe(
      '"/tmp/not-utf8.txt" is not readable as UTF-8 text. If it is an image or video, use ReadMediaFile. For other binary formats, use Bash or an MCP tool if available.',
    );
    expect(output).not.toContain('Python tools');
    expect(output).not.toContain(replacement);
    expect(output).not.toContain('encoded data was not valid');
  });

  it('truncates long lines and surfaces the affected line numbers', async () => {
    const long = 'x'.repeat(MAX_LINE_LENGTH + 10);
    const tool = toolWithContent([long, 'short', long].join('\n'));

    const result = await execute(tool, { path: '/tmp/long.txt' });

    expect(result.note).toContain('Lines [1, 3] were truncated.');
    expect(result.output).toContain('...');
  });

  it('checks the byte cap before adding the next rendered line', async () => {
    const line = 'x'.repeat(MAX_LINE_LENGTH);
    const content = Array.from({ length: 80 }, () => line).join('\n');
    const tool = toolWithContent(content);

    const result = await execute(tool, { path: '/tmp/bytes.txt' });
    const output = toolContentString(result);

    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(MAX_BYTES);
    expect(result.note).toContain(`Max ${String(MAX_BYTES)} bytes reached.`);
  });

  it('reads through bounded byte preflight and streams line iteration without full readText', async () => {
    const bytes = Buffer.from(
      Array.from({ length: MAX_LINES + 5 }, (_, i) => `line ${String(i + 1)}`).join('\n'),
      'utf8',
    );
    const readText = vi.fn(async () => {
      throw new Error('full readText should not be called');
    });
    let consumed = 0;
    const readLines = vi.fn().mockImplementation(async function* (): AsyncGenerator<string> {
      for (let i = 1; i <= MAX_LINES + 5; i += 1) {
        consumed = i;
        yield `line ${String(i)}\n`;
      }
    });
    const readBytes = vi.fn(async (_path: string, n?: number) =>
      n === undefined ? bytes : bytes.subarray(0, n),
    );
    const stat = vi.fn(async () => ({ isFile: true, isDirectory: false, size: bytes.length }));
    const fs = { cwd: '/', readBytes, readLines, readText, stat } as unknown as IHostFileSystem;
    const tool = new ReadTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE);

    const result = await execute(tool, { path: '/tmp/large.txt' });
    const output = toolContentString(result);

    expect(result.isError).toBeFalsy();
    expect(output).toContain('1\tline 1');
    expect(output).toContain(`${String(MAX_LINES)}\tline ${String(MAX_LINES)}`);
    expect(result.note).toContain(`Total lines in file: ${String(MAX_LINES + 5)}.`);
    expect(result.note).toContain(`Max ${String(MAX_LINES)} lines reached.`);
    expect(consumed).toBe(MAX_LINES + 5);
    expect(readBytes).toHaveBeenCalledWith('/tmp/large.txt', MEDIA_SNIFF_BYTES);
    expect(readText).not.toHaveBeenCalled();
  });

  it('caps default reads at MAX_LINES', async () => {
    const content = Array.from({ length: MAX_LINES + 1 }, (_, i) => `line ${String(i + 1)}`).join(
      '\n',
    );
    const tool = toolWithContent(content);

    const result = await execute(tool, { path: '/tmp/big.txt' });

    expect(result.note).toContain(`Max ${String(MAX_LINES)} lines reached.`);
    expect(result.output).toContain(`${String(MAX_LINES)}\tline ${String(MAX_LINES)}`);
    expect(result.output).not.toContain(`${String(MAX_LINES + 1)}\tline ${String(MAX_LINES + 1)}`);
  });

  it('tail byte truncation keeps the newest lines closest to EOF', async () => {
    const numLines = Math.floor(MAX_BYTES / 1001) + 20;
    const content = Array.from({ length: numLines }, (_, i) => {
      return `${String(i + 1).padStart(4, '0')}${'B'.repeat(996)}`;
    }).join('\n');
    const tool = toolWithContent(content);

    const result = await execute(tool, { path: '/tmp/tail-bytes.txt', line_offset: -1000 });
    const output = toolContentString(result);
    const outputLines = output.split('\n').filter((line) => line.includes('\t'));

    expect(result.note).toContain(`Max ${String(MAX_BYTES)} bytes reached.`);
    expect(outputLines.at(-1)).toContain(String(numLines).padStart(4, '0'));
    expect(outputLines[0]).not.toContain('0001');
  });

  it('tail n_lines is applied before byte truncation', async () => {
    const numLines = 500;
    const content = Array.from({ length: numLines }, (_, i) => {
      return `${String(i + 1).padStart(4, '0')}${'X'.repeat(1996)}`;
    }).join('\n');
    const tool = toolWithContent(content);

    const result = await execute(tool, {
      path: '/tmp/tail-small-window.txt',
      line_offset: -200,
      n_lines: 1,
    });
    const output = toolContentString(result);

    expect(output).toMatch(/^301\t0301/);
    expect(output).not.toContain('Max');
  });

  it('description pins line/byte caps, tail mode, and the Grep-over-Read preference', () => {
    const tool = toolWithContent('');
    expect(tool.description).toContain(String(MAX_LINES));
    expect(tool.description).toContain(String(MAX_LINE_LENGTH));
    expect(tool.description).toMatch(/negative line_offset|reads from the end/i);
    expect(tool.description).toContain('Grep');
  });

  it('reads files inside additional_dirs via absolute path', async () => {
    const { fs } = createSpiedFs('extra-dir note');
    const tool = new ReadTool(fs, createTestEnv(), stubWorkspaceContext('/workspace', ['/extra']));

    const result = await execute(tool, { path: '/extra/notes.txt' });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('1\textra-dir note');
  });

  it('reports nonexistent files with the expected does-not-exist phrasing', async () => {
    const { fs } = createSpiedMapFs({});
    const tool = new ReadTool(fs, createTestEnv(), stubWorkspaceContext('/workspace'));

    const result = await execute(tool, { path: '/workspace/ghost.txt' });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('does not exist');
    expect(result.output).toMatch(/not found|does not exist/i);
  });

  it('returns empty output and Total lines: 0 for an empty file', async () => {
    const tool = toolWithContent('');

    const result = await execute(tool, { path: '/tmp/empty.txt' });

    expect(result.isError).toBeFalsy();
    expect(result.output).toBe('');
    expect(result.note).toBe(
      readNote('No lines read from file. Total lines in file: 0. End of file reached.'),
    );
  });

  it('reads unicode (CJK + emoji + accented Latin) without loss', async () => {
    const tool = toolWithContent('Hello 世界 🌍\nUnicode test: café, naïve, résumé');

    const result = await execute(tool, { path: '/tmp/unicode.txt' });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('1\tHello 世界 🌍');
    expect(result.output).toContain('2\tUnicode test: café, naïve, résumé');
  });

  it('schema validation rejects n_lines=0 and n_lines=-1 with an n_lines-keyed error', () => {
    const zero = ReadInputSchema.safeParse({ path: '/tmp/a.txt', n_lines: 0 });
    expect(zero.success).toBe(false);
    if (!zero.success) {
      const message = JSON.stringify(zero.error.issues);
      expect(message).toContain('n_lines');
    }

    const negative = ReadInputSchema.safeParse({ path: '/tmp/a.txt', n_lines: -1 });
    expect(negative.success).toBe(false);
    if (!negative.success) {
      const message = JSON.stringify(negative.error.issues);
      expect(message).toContain('n_lines');
    }
  });

  it('schema validation accepts -1 and -MAX_LINES but rejects -(MAX_LINES + 1)', () => {
    expect(ReadInputSchema.safeParse({ path: '/tmp/a.txt', line_offset: -1 }).success).toBe(true);
    expect(ReadInputSchema.safeParse({ path: '/tmp/a.txt', line_offset: -MAX_LINES }).success).toBe(
      true,
    );
    expect(
      ReadInputSchema.safeParse({ path: '/tmp/a.txt', line_offset: -(MAX_LINES + 1) }).success,
    ).toBe(false);
  });

  it('reads non-sensitive dotfiles like .gitignore successfully', async () => {
    const tool = toolWithContent('node_modules/\n');

    const result = await execute(tool, { path: '/workspace/.gitignore' });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('node_modules/');
  });

  it('negative line_offset exceeding total lines returns the entire file', async () => {
    const tool = toolWithContent('a\nb\nc\nd\ne');

    const result = await execute(tool, { path: '/tmp/short.txt', line_offset: -100 });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('1\ta');
    expect(result.output).toContain('5\te');
    expect(result.note).toContain('Total lines in file: 5.');
  });

  it('tail mode on an empty file returns empty output without erroring', async () => {
    const tool = toolWithContent('');

    const result = await execute(tool, { path: '/tmp/empty-tail.txt', line_offset: -10 });

    expect(result.isError).toBeFalsy();
    expect(result.note).toContain('Total lines in file: 0.');
  });

  it('line_offset=-1 returns only the last line with its absolute line number', async () => {
    const tool = toolWithContent('a\nb\nc\nd\ne');

    const result = await execute(tool, { path: '/tmp/last.txt', line_offset: -1 });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('5\te');
    expect(result.note).toContain('1 line read from file starting from line 5.');
  });

  it('tail mode reports absolute line numbers when long lines are truncated', async () => {
    const shortLine = 'short';
    const longLine = 'X'.repeat(MAX_LINE_LENGTH + 500);
    const content = [shortLine, longLine, shortLine, longLine, shortLine].join('\n');
    const tool = toolWithContent(content);

    const result = await execute(tool, { path: '/tmp/tail-trunc.txt', line_offset: -3 });

    expect(result.isError).toBeFalsy();
    expect(result.note).toContain('Total lines in file: 5.');
    expect(result.note).toContain('Lines [4] were truncated.');
  });
});

describe('ReadTool description and schema parity', () => {
  it('encourages reading multiple files in parallel', () => {
    const tool = toolWithContent('');

    expect(tool.description).toMatch(/parallel/i);
    expect(tool.description).toMatch(/multiple `Read` calls in a single response/i);
  });

  it('explains the trailing <system> status block', () => {
    const tool = toolWithContent('');

    expect(tool.description).toContain('<system>');
    expect(tool.description).toMatch(/after the file content/i);
  });

  it('describes the path parameter with accurate working-directory semantics', () => {
    const tool = toolWithContent('');
    const pathProperty = (tool.parameters as { properties: { path: { description: string } } })
      .properties.path;

    expect(pathProperty.description).toContain('working directory');
    expect(pathProperty.description).not.toMatch(/^Absolute path/);
  });

  it('documents the default for n_lines when omitted', () => {
    const tool = toolWithContent('');
    const nLinesProperty = (tool.parameters as { properties: { n_lines: { description: string } } })
      .properties.n_lines;

    expect(nLinesProperty.description).toMatch(/omit/i);
    expect(nLinesProperty.description).toContain(String(MAX_LINES));
  });

  it('warns that sensitive files are refused', () => {
    const tool = toolWithContent('');

    expect(tool.description).toMatch(/refuse|reject|decline|block/i);
    expect(tool.description).toMatch(/sensitive|credential|secret|\.env|SSH key/i);
  });

  it('explains that non-UTF-8 and binary files are refused', () => {
    const tool = toolWithContent('');

    expect(tool.description).toMatch(/UTF-?8/i);
    expect(tool.description).toMatch(/binary/i);
  });
});
