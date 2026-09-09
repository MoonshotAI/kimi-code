import { describe, expect, it, vi } from 'vitest';

import { PathSecurityError } from '#/tool/path-access';
import { MEDIA_SNIFF_BYTES } from '#/agent/media/file-type';
import type { ISessionSkillCatalog } from '#/features/skill/session/skillCatalog';
import { stubWorkspaceContext } from '../../../../session/workspaceContext/stub-workspace-context';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import {
  type ReadInput,
  ReadInputSchema,
  TRANSCODE_MAX_BYTES,
} from '#/agent/tools/os/read/read';
import { ReadTool } from '#/agent/tools/os/read/readTool';
import { renderToolResultForModel } from '#/agent/contextMemory/toolResultRender';
import { stubToolResultTruncationService } from '../../../../agent/toolResultTruncation/stubs';
import { stubConfigService } from '../../../../app/config/stubs';
import type { IAgentToolResultTruncationService } from '#/agent/toolResultTruncation/toolResultTruncation';
import type { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import { RuntimeRegistry } from '#/runtime/runtimeRegistry';
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

function createReadTool(
  fs: IHostFileSystem,
  env: IHostEnvironment,
  workspace: ReturnType<typeof stubWorkspaceContext>,
  skillCatalog: ISessionSkillCatalog = {
    catalog: { getSkillRoots: () => [] },
  } as unknown as ISessionSkillCatalog,
  truncation: IAgentToolResultTruncationService = stubToolResultTruncationService(),
): ReadTool {
  const runtime = Object.assign(
    new FakeRuntime(
      { workspaceId: 'workspace', runtimeId: 'local', generation: 'test' },
      { capabilities: ['fs'], pathClass: env.pathClass },
    ),
    { environment: env, fs },
  );
  const resolver: IAgentRuntimeService = {
    _serviceBrand: undefined,
    onDidChange: () => ({ dispose: () => {} }),
    isAvailable: () => true,
    inspect: () => runtime,
    acquire: () => ({ runtime, track: (resource) => resource, dispose: () => {} }),
  };
  return new ReadTool(resolver, workspace, skillCatalog, truncation, stubConfigService());
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
  return createReadTool(createSpiedFs(content).fs, createTestEnv(), workspace);
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
  it('reads a 4621-line document in full when the requested character budget fits', async () => {
    const content = Array.from({ length: 4621 }, (_, index) =>
      `section ${String(index + 1)} ${'x'.repeat(55)}`,
    ).join('\n');
    const tool = toolWithContent(content);

    const result = await execute(tool, ReadInputSchema.parse({
      path: '/tmp/paper.md',
      max_chars: 500_000,
    }));
    const output = toolContentString(result);

    expect(result.isError).not.toBe(true);
    expect(output.split('\n')).toHaveLength(4621);
    expect(output.replaceAll(/^\d+\t/gm, '')).toBe(content);
    expect(output.length + 1 + (result.note?.length ?? 0)).toBeLessThanOrEqual(500_000);
  });

  it('recovers a line above the maximum request size through fixed-budget column continuations', async () => {
    const content = Array.from({ length: 60_000 }, (_, index) => `${String(index).padStart(5, '0')}value`).join('');
    const tool = toolWithContent(content);
    const fragments: string[] = [];
    let args: ReadInput | undefined = { path: '/tmp/record.jsonl', line_offset: 1, n_lines: 1, max_chars: 100_000 };
    let consumed = 0;

    for (let page = 0; args !== undefined && page < 20; page += 1) {
      const result = await execute(tool, args);
      const output = toolContentString(result);
      expect(result.isError).not.toBe(true);
      expect(output.startsWith('1\t')).toBe(true);
      expect(output).not.toContain('\n');
      const fragment = output.slice(2);
      expect(fragment.length).toBeGreaterThan(0);
      expect(fragment).toBe(content.slice(consumed, consumed + fragment.length));
      expect(output.length + 1 + (result.note?.length ?? 0)).toBeLessThanOrEqual(100_000);
      expect(result.note).toContain(`columns [${String(consumed)}, ${String(consumed + fragment.length)})`);
      fragments.push(fragment);
      consumed += fragment.length;
      const next = result.note?.match(/Next Read: (\{[^\n]*\})/);
      args = next === undefined || next === null ? undefined : ReadInputSchema.parse(JSON.parse(next[1]!));
      if (args !== undefined) {
        expect(args).toMatchObject({ line_offset: 1, column_offset: consumed, n_lines: 1, max_chars: 100_000 });
        expect(result.note).not.toContain('End of file reached.');
        expect(result.truncated).toBe(true);
      } else {
        expect(result.note).toContain('Requested range complete.');
        expect(result.note).toContain('End of file reached.');
      }
    }

    expect(args).toBeUndefined();
    expect(fragments.length).toBeGreaterThan(5);
    expect(fragments.join('')).toBe(content);
  });

  it.each([650, 651])('keeps every Unicode fragment well formed with a %i-character budget', async (maxChars) => {
    const content = '文🙂'.repeat(400) + 'END';
    const tool = toolWithContent(content);
    const fragments: string[] = [];
    let args: ReadInput | undefined = { path: '/tmp/unicode.txt', n_lines: 1, max_chars: maxChars };

    for (let page = 0; args !== undefined && page < 20; page += 1) {
      const result = await execute(tool, args);
      const output = toolContentString(result);
      expect(result.isError).not.toBe(true);
      const fragment = output.slice(2);
      expect(fragment.length).toBeGreaterThan(0);
      expect(Buffer.from(fragment, 'utf8').toString('utf8')).toBe(fragment);
      expect(output.length + 1 + (result.note?.length ?? 0)).toBeLessThanOrEqual(maxChars);
      fragments.push(fragment);
      const next = result.note?.match(/Next Read: (\{[^\n]*\})/);
      args = next === undefined || next === null ? undefined : ReadInputSchema.parse(JSON.parse(next[1]!));
    }

    expect(args).toBeUndefined();
    expect(fragments.join('')).toBe(content);
  });

  it.each([
    { line_offset: 1, column_offset: 1 },
    { line_offset: 1, column_offset: 100 },
    { line_offset: 2, column_offset: 1 },
    { line_offset: -1, column_offset: 1 },
  ])('rejects an invalid starting column $column_offset at line $line_offset', async (offsets) => {
    const result = await execute(toolWithContent('🙂tail'), { path: '/tmp/column.txt', ...offsets });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('column_offset');
  });

  it('resumes mixed short and long lines without changing the requested ending line', async () => {
    const lines = ['outside before', `START${'🙂文'.repeat(400)}`, 'short target', 'last target '.repeat(150), 'outside after'];
    const tool = toolWithContent(lines.join('\n'));
    const returned = new Map<number, string>();
    let args: ReadInput | undefined = { path: '/tmp/mixed.txt', line_offset: 2, column_offset: 5, n_lines: 3, max_chars: 650 };

    for (let page = 0; args !== undefined && page < 50; page += 1) {
      const result = await execute(tool, args);
      const output = toolContentString(result);
      expect(result.isError).not.toBe(true);
      expect(output.length + 1 + (result.note?.length ?? 0)).toBeLessThanOrEqual(650);
      expect(result.note).not.toContain('End of file reached.');
      for (const row of output.split('\n')) {
        const separator = row.indexOf('\t');
        const line = Number(row.slice(0, separator));
        expect([2, 3, 4]).toContain(line);
        const fragment = row.slice(separator + 1);
        expect(Buffer.from(fragment, 'utf8').toString('utf8')).toBe(fragment);
        returned.set(line, (returned.get(line) ?? '') + fragment);
      }
      const next = result.note?.match(/Next Read: (\{[^\n]*\})/);
      args = next === undefined || next === null ? undefined : ReadInputSchema.parse(JSON.parse(next[1]!));
      if (args !== undefined) expect(args.n_lines).toBe(5 - args.line_offset!);
      else expect(result.note).toContain('Requested range complete.');
    }

    expect(args).toBeUndefined();
    expect(returned.get(2)).toBe(lines[1]!.slice(5));
    expect(returned.get(3)).toBe(lines[2]);
    expect(returned.get(4)).toBe(lines[3]);
  });

  it('pages through the requested range without losing text or exceeding the character budget', async () => {
    const lines = Array.from({ length: 20 }, (_, index) =>
      `section ${String(index + 1)} ${'文'.repeat(70)}`,
    );
    const tool = toolWithContent(lines.join('\n'));
    const contents: string[] = [];
    let args: ReadInput | undefined = { path: '/tmp/range.md', line_offset: 3, n_lines: 12, max_chars: 650 };
    let last: ExecutableToolResult | undefined;

    for (let page = 0; args !== undefined && page < 20; page += 1) {
      const result = await execute(tool, args);
      const output = toolContentString(result);
      expect(result.isError).not.toBe(true);
      expect(output.length).toBeGreaterThan(0);
      expect(output.length + 1 + (result.note?.length ?? 0)).toBeLessThanOrEqual(650);
      contents.push(output.replaceAll(/^\d+\t/gm, ''));
      const next = result.note?.match(/Next Read: (\{[^\n]*\})/);
      args = next === undefined || next === null ? undefined : ReadInputSchema.parse(JSON.parse(next[1]!));
      last = result;
    }

    expect(args).toBeUndefined();
    expect(contents.length).toBeGreaterThan(1);
    expect(contents.join('\n')).toBe(lines.slice(2, 14).join('\n'));
    expect(last?.note).toContain('Requested range complete.');
    expect(last?.note).not.toContain('End of file reached.');
  });

  it('returns the newest part of a tail range and lets the caller recover the omitted earlier lines', async () => {
    const lines = Array.from({ length: 20 }, (_, index) =>
      `section ${String(index + 1)} ${'x'.repeat(70)}`,
    );
    const tool = toolWithContent(lines.join('\n'));
    const returned: string[] = [];
    let args: ReadInput | undefined = { path: '/tmp/tail.md', line_offset: -15, n_lines: 10, max_chars: 650 };

    for (let page = 0; args !== undefined && page < 20; page += 1) {
      const result = await execute(tool, args);
      const output = toolContentString(result);
      expect(result.isError).not.toBe(true);
      expect(output.length + 1 + (result.note?.length ?? 0)).toBeLessThanOrEqual(650);
      expect(result.note).not.toContain('End of file reached.');
      if (page === 0) expect(output.split('\n').at(-1)).toBe(`15\t${lines[14]}`);
      returned.push(...output.split('\n'));
      const next = result.note?.match(/Next Read: (\{[^\n]*\})/);
      args = next === undefined || next === null ? undefined : ReadInputSchema.parse(JSON.parse(next[1]!));
    }

    expect(args).toBeUndefined();
    expect(returned).toHaveLength(10);
    expect(returned.toSorted((left, right) => Number(left.split('\t')[0]) - Number(right.split('\t')[0]))
      .map((line) => line.replace(/^\d+\t/, '')).join('\n')).toBe(lines.slice(5, 15).join('\n'));
  });

  it('exposes current metadata and schema', () => {
    const tool = toolWithContent('');

    expect(tool.name).toBe('Read');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: {
        path: { type: 'string' },
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
      ReadInputSchema.safeParse({ path: '/tmp/test.txt', max_chars: 0 }).success,
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

    expect(result).toMatchObject({
      output: '1\talpha\n2\tbeta',
      note: readNote(
        '2 lines read from file starting from line 1. Total lines in file: 2. Requested range complete. Effective max_chars: 100000. End of file reached.',
      ),
    });
  });

  it('stats the resolved target so symlinked files stay readable', async () => {
    const { fs, stat } = createSpiedFs('alpha\n');
    const tool = createReadTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE);

    const result = await execute(tool, { path: '/tmp/a.txt' });

    expect(result.isError).not.toBe(true);
    expect(stat).toHaveBeenCalledWith('/tmp/a.txt');
  });

  it('normalizes pure CRLF files to the LF model view', async () => {
    const tool = toolWithContent('alpha\r\nbeta\r\n');

    const result = await execute(tool, { path: '/tmp/a.txt' });

    expect(result.output).toBe(['1\talpha', '2\tbeta'].join('\n'));
    expect(result.note).toBe(
      readNote(
        '2 lines read from file starting from line 1. Total lines in file: 2. Requested range complete. Effective max_chars: 100000. End of file reached.',
      ),
    );
  });

  it('makes mixed carriage returns visible instead of normalizing them', async () => {
    const tool = toolWithContent('alpha\r\nbeta\ngamma\rdone');

    const result = await execute(tool, { path: '/tmp/a.txt' });

    expect(result.output).toBe(['1\talpha\\r', '2\tbeta', '3\tgamma\\rdone'].join('\n'));
    expect(result.note).toBe(
      readNote(
        '3 lines read from file starting from line 1. Total lines in file: 3. Requested range complete. Effective max_chars: 100000. End of file reached. Mixed or lone carriage-return line endings are shown as \\r. Use exact \\r\\n or \\r escapes in Edit.old_string for those lines.',
      ),
    );
  });

  it('respects one-based line_offset and positive n_lines', async () => {
    const tool = toolWithContent('a\nb\nc\nd\ne');

    const result = await execute(tool, { path: '/tmp/a.txt', line_offset: 2, n_lines: 2 });

    expect(result).toMatchObject({
      output: '2\tb\n3\tc',
      note: readNote('2 lines read from file starting from line 2. Total lines in file: 5. Requested range complete. Effective max_chars: 100000.'),
    });
  });

  it('returns an empty successful output when line_offset is beyond EOF', async () => {
    const tool = toolWithContent('a\nb');

    const result = await execute(tool, { path: '/tmp/a.txt', line_offset: 20 });

    expect(result).toMatchObject({
      output: '',
      note: readNote('No lines read from file. Total lines in file: 2. Requested range complete. Effective max_chars: 100000. End of file reached.'),
    });
  });

  it('supports negative line_offset as tail mode with absolute line numbers', async () => {
    const tool = toolWithContent('a\nb\nc\nd\ne');

    const result = await execute(tool, { path: '/tmp/a.txt', line_offset: -3 });

    expect(result).toMatchObject({
      output: '3\tc\n4\td\n5\te',
      note: readNote(
        '3 lines read from file starting from line 3. Total lines in file: 5. Requested range complete. Effective max_chars: 100000. End of file reached.',
      ),
    });
  });

  it.each([undefined, 3, 5])('reads the last three lines in one file scan with n_lines=%s', async (nLines) => {
    const { fs, readLines } = createSpiedFs('a\nb\nc\nd\ne');
    const tool = createReadTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE);

    const result = await execute(tool, { path: '/tmp/tail.log', line_offset: -3, n_lines: nLines });

    expect(result.output).toBe('3\tc\n4\td\n5\te');
    expect(result.note).toContain('Requested range complete.');
    expect(readLines).toHaveBeenCalledTimes(1);
  });

  it('applies n_lines from the start of the negative line_offset tail window', async () => {
    const tool = toolWithContent('a\nb\nc\nd\ne');

    const result = await execute(tool, { path: '/tmp/a.txt', line_offset: -5, n_lines: 2 });

    expect(result.output).toBe('1\ta\n2\tb');
    expect(result.note).toBe(
      readNote('2 lines read from file starting from line 1. Total lines in file: 5. Requested range complete. Effective max_chars: 100000.'),
    );
  });

  it('rejects a partial tail range when the file grows during reading', async () => {
    let content = 'a\nb\nc\n';
    const { fs, readLines, stat } = createSpiedFs(content);
    stat.mockImplementation(async () => ({
      isFile: true,
      isDirectory: false,
      size: Buffer.byteLength(content),
    }));
    readLines.mockImplementation(async function* () {
      yield* generateLines(content);
      content += 'd\n';
    });
    const tool = createReadTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE);

    const result = await execute(tool, { path: '/tmp/growing.log', line_offset: -3, n_lines: 1 });

    expect(result).toMatchObject({
      isError: true,
      output: 'File changed while reading its tail. Retry Read with the updated file.',
    });
    expect(result.note).toBeUndefined();
  });

  it('returns newly appended lines observed during a single tail scan', async () => {
    let content = 'a\nb\nc\n';
    const { fs, readLines, stat } = createSpiedFs(content);
    stat.mockImplementation(async () => ({
      isFile: true,
      isDirectory: false,
      size: Buffer.byteLength(content),
    }));
    readLines.mockImplementation(async function* () {
      yield 'a\n';
      content += 'd\n';
      yield* generateLines(content.slice(2));
    });
    const tool = createReadTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE);

    const result = await execute(tool, { path: '/tmp/growing.log', line_offset: -1 });

    expect(result.isError).not.toBe(true);
    expect(result.output).toBe('4\td');
    expect(result.note).toContain('Total lines in file: 4.');
    expect(result.note).toContain('End of file reached.');
    expect(readLines).toHaveBeenCalledTimes(1);
  });

  it('rejects a tail reread that observes a line beyond the counted EOF', async () => {
    const { fs, readLines } = createSpiedFs('a\nb\nc\n');
    readLines.mockReturnValueOnce(generateLines('a\nb\nc\n'))
      .mockReturnValueOnce(generateLines('a\nb\nc\nd\n'));
    const tool = createReadTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE);

    const result = await execute(tool, { path: '/tmp/growing.log', line_offset: -10, n_lines: 3 });

    expect(result).toMatchObject({
      isError: true,
      output: 'File changed while reading its tail. Retry Read with the updated file.',
    });
    expect(result.note).toBeUndefined();
  });

  it.each([
    { change: 'same-size edit', mtimeMs: 2, ino: 1 },
    { change: 'file replacement', mtimeMs: 1, ino: 2 },
  ])('rejects a partial tail range after a $change', async ({ mtimeMs, ino }) => {
    let changed = false;
    const { fs, readLines, stat } = createSpiedFs('a\nb\n');
    stat.mockImplementation(async () => ({
      isFile: true,
      isDirectory: false,
      size: 4,
      mtimeMs: changed ? mtimeMs : 1,
      ino: changed ? ino : 1,
    }));
    readLines.mockImplementation(async function* () {
      yield* generateLines(changed ? 'x\ny\n' : 'a\nb\n');
      changed = true;
    });
    const tool = createReadTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE);

    const result = await execute(tool, { path: '/tmp/changing.log', line_offset: -2, n_lines: 1 });

    expect(result).toMatchObject({
      isError: true,
      output: 'File changed while reading its tail. Retry Read with the updated file.',
    });
    expect(result.note).toBeUndefined();
  });

  it('rejects relative traversal before reading', async () => {
    const { fs, readText } = createSpiedFs('secret');
    const tool = createReadTool(fs, createTestEnv(), stubWorkspaceContext('/workspace/project'));

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
    const tool = createReadTool(
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
    const tool = createReadTool(fs, createTestEnv(), stubWorkspaceContext('/workspace'));

    const result = await execute(tool, { path: '/tmp/external.txt' });

    expect(result.output).toBe('1\texternal');
    expect(result.note).toBe(
      readNote(
        '1 line read from file starting from line 1. Total lines in file: 1. Requested range complete. Effective max_chars: 100000. End of file reached.',
      ),
    );
    expect(readBytes).toHaveBeenCalledWith('/tmp/external.txt', MEDIA_SNIFF_BYTES);
    expect(readLines).toHaveBeenCalledWith('/tmp/external.txt', { errors: 'strict' });
  });

  it('returns a friendly error for missing files before sniffing bytes', async () => {
    const { fs, readBytes, readLines } = createSpiedMapFs({});
    const tool = createReadTool(fs, createTestEnv(), stubWorkspaceContext('/workspace'));

    const result = await execute(tool, { path: '/workspace/missing.txt' });

    expect(result).toMatchObject({
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
    const tool = createReadTool(fs, createTestEnv(), stubWorkspaceContext('/workspace'));

    const result = await execute(tool, { path: '/workspace/src' });

    expect(result).toMatchObject({
      isError: true,
      output: '"/workspace/src" is not a file.',
    });
    expect(readBytes).not.toHaveBeenCalled();
    expect(readLines).not.toHaveBeenCalled();
  });

  it('expands leading tilde paths using the kaos home directory', async () => {
    const { fs, readBytes, readLines } = createSpiedFs('home note');
    const tool = createReadTool(fs, createTestEnv('/home/test'), stubWorkspaceContext('/workspace'));

    const result = await execute(tool, { path: '~/notes/today.txt' });

    expect(result.output).toBe('1\thome note');
    expect(result.note).toBe(
      readNote(
        '1 line read from file starting from line 1. Total lines in file: 1. Requested range complete. Effective max_chars: 100000. End of file reached.',
      ),
    );
    expect(readBytes).toHaveBeenCalledWith('/home/test/notes/today.txt', MEDIA_SNIFF_BYTES);
    expect(readLines).toHaveBeenCalledWith('/home/test/notes/today.txt', { errors: 'strict' });
  });

  it('blocks sensitive files independently from workspace access', async () => {
    const { fs, readText } = createSpiedFs('SECRET=value');
    const tool = createReadTool(fs, createTestEnv(), stubWorkspaceContext('/workspace'));

    const result = await execute(tool, { path: '/workspace/.env' });

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('sensitive-file pattern');
    expect(readText).not.toHaveBeenCalled();
  });

  it('rejects image files before text decoding', async () => {
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { fs, readText } = createSpiedMapFs({
      '/tmp/sample.png': { bytes: pngHeader },
    });
    const tool = createReadTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE);

    const result = await execute(tool, { path: '/tmp/sample.png' });
    const output = toolContentString(result);

    expect(result.isError).toBe(true);
    expect(output).toBe('"/tmp/sample.png" is an image file. Only text files can be read.');
    expect(readText).not.toHaveBeenCalled();
  });

  it('rejects an image-extension file whose bytes are not an image as not readable', async () => {
    const plainText = Buffer.from('this is plain ascii text, not a png');
    const { fs, readText } = createSpiedMapFs({
      '/tmp/fake.png': { bytes: plainText },
    });
    const tool = createReadTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE);

    const result = await execute(tool, { path: '/tmp/fake.png' });
    const output = toolContentString(result);

    expect(result.isError).toBe(true);
    expect(output).toBe(
      '"/tmp/fake.png" is not readable as UTF-8 text. Only text files can be read.',
    );
    expect(readText).not.toHaveBeenCalled();
  });

  it('rejects extensionless image files using magic-byte sniffing', async () => {
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { fs, readText } = createSpiedMapFs({
      '/tmp/sample': { bytes: pngHeader },
    });
    const tool = createReadTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE);

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
    const tool = createReadTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE);

    const result = await execute(tool, { path: '/tmp/sample.mp4' });
    const output = toolContentString(result);

    expect(result.isError).toBe(true);
    expect(output).toBe('"/tmp/sample.mp4" is a video file. Only text files can be read.');
    expect(readText).not.toHaveBeenCalled();
  });

  it('rejects NUL-containing binary files before text decoding', async () => {
    const header = Buffer.concat([Buffer.from('plain prefix'), Buffer.from([0x00, 0x01])]);
    const { fs, readText } = createSpiedMapFs({
      '/tmp/blob.bin': { bytes: header },
    });
    const tool = createReadTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE);

    const result = await execute(tool, { path: '/tmp/blob.bin' });
    const output = toolContentString(result);

    expect(result.isError).toBe(true);
    expect(output).toBe(
      '"/tmp/blob.bin" is not readable as UTF-8 text. Only text files can be read.',
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
    const tool = createReadTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE);

    const result = await execute(tool, { path: '/tmp/blob-with-late-nul' });
    const output = toolContentString(result);

    expect(result.isError).toBe(true);
    expect(output).toBe(
      '"/tmp/blob-with-late-nul" is not readable as UTF-8 text. Only text files can be read.',
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
    const tool = createReadTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE);

    const result = await execute(tool, { path: '/tmp/not-utf8.txt' });
    const output = toolContentString(result);

    expect(result.isError).toBe(true);
    expect(output).toBe(
      '"/tmp/not-utf8.txt" is not valid UTF-8 or UTF-16 text. Only UTF-8 and UTF-16 text files can be read; for other encodings (e.g. GBK), convert the file to UTF-8 first (e.g. with `iconv`).',
    );
    expect(output).not.toContain('Python tools');
    expect(output).not.toContain(replacement);
    expect(output).not.toContain('encoded data was not valid');
  });

  it.each([
    ['utf16-le-unpaired', [0xff, 0xfe, 0x00, 0xd8]],
    ['utf16-be-unpaired', [0xfe, 0xff, 0xd8, 0x00]],
    ['utf16-le-truncated', [0xff, 0xfe, 0x41]],
  ] as const)('returns malformed %s with an explicit lossy-decoding warning', async (name, bytes) => {
    const path = `/tmp/${name}.txt`;
    const { fs } = createSpiedMapFs({ [path]: { bytes: Buffer.from(bytes) } });
    const result = await execute(createReadTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE), { path });

    expect(result.isError).not.toBe(true);
    expect(result.output).toBe('1\t\uFFFD');
    expect(result.note).toContain('Lossy UTF-16 decoding');
    expect(result.note).toContain('may differ from the original file');
    expect(result.note).toContain('Requested range complete.');
  });

  it.each(['utf8', 'utf16le'] as const)('does not flag a literal replacement character in valid %s text', async (encoding) => {
    const content = 'valid \uFFFD and 🙂';
    const encoded = Buffer.from(content, encoding);
    const bytes = encoding === 'utf16le' ? Buffer.concat([Buffer.from([0xff, 0xfe]), encoded]) : encoded;
    const { fs } = createSpiedMapFs({ '/tmp/literal.txt': { bytes } });
    const result = await execute(createReadTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE), { path: '/tmp/literal.txt' });

    expect(result.isError).not.toBe(true);
    expect(result.output).toBe(`1\t${content}`);
    expect(result.note).not.toContain('Lossy');
  });

  it.each([2, -2])('preserves the lossy warning and budget through Read continuation from offset %i', async (lineOffset) => {
    const rawLine = '文'.repeat(1000) + '\uD800' + '🙂'.repeat(500) + 'tail';
    const expected = '文'.repeat(1000) + '\uFFFD' + '🙂'.repeat(500) + 'tail';
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`first\n${rawLine}\nlast`, 'utf16le')]);
    const path = '/tmp/lossy-range.txt';
    const { fs } = createSpiedMapFs({ [path]: { bytes } });
    const tool = createReadTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE);
    const fragments: string[] = [];
    let args: ReadInput | undefined = { path, line_offset: lineOffset, n_lines: 1, max_chars: 1200 };

    for (let page = 0; args !== undefined && page < 20; page += 1) {
      const result = await execute(tool, args);
      expect(result.note).toContain('Lossy UTF-16 decoding');
      if (result.isError) {
        expect(lineOffset).toBe(-2);
        expect(page).toBe(0);
        expect(result.note).toContain('Next Read:');
      } else {
        const output = toolContentString(result);
        expect(output.startsWith('2\t')).toBe(true);
        expect(output.length + 1 + (result.note?.length ?? 0)).toBeLessThanOrEqual(1200);
        fragments.push(output.slice(2));
      }
      const next = result.note?.match(/Next Read: (\{[^\n]*\})/);
      args = next === undefined || next === null ? undefined : ReadInputSchema.parse(JSON.parse(next[1]!));
    }

    expect(args).toBeUndefined();
    expect(fragments.length).toBeGreaterThan(1);
    expect(fragments.join('')).toBe(expected);
  });

  it('fits a lossy tail recovery hint within the model-visible character budget', async () => {
    const path = '/tmp/edge.txt';
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('x'.repeat(2000) + '\uD800', 'utf16le')]);
    const { fs } = createSpiedMapFs({ [path]: { bytes } });
    const result = await execute(createReadTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE), {
      path,
      line_offset: -1,
      max_chars: 650,
    });

    expect(result.isError).toBe(true);
    expect(result.note).toContain('Lossy UTF-16 decoding');
    expect(result.note).toContain('Next Read:');
    const visible = renderToolResultForModel(result)
      .map((part) => part.type === 'text' ? part.text : '').join('');
    expect(visible.length).toBeLessThanOrEqual(650);
  });

  it('reads a UTF-16 LE file with BOM by transcoding to UTF-8', async () => {
    const bytes = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('hello\nworld\n', 'utf16le'),
    ]);
    const { fs } = createSpiedMapFs({ '/tmp/notes.TXT': { bytes } });
    const tool = createReadTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE);

    const result = await execute(tool, { path: '/tmp/notes.TXT' });

    expect(result.isError).not.toBe(true);
    expect(result.output).toContain('1\thello');
    expect(result.output).toContain('2\tworld');
    expect(result.note).toContain('Detected file encoding: UTF-16 LE');
  });

  it('reads a BOM-marked UTF-16 file whose content has no zero bytes (CJK-only)', async () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('你好世界', 'utf16le')]);
    const { fs } = createSpiedMapFs({ '/tmp/cjk.txt': { bytes } });
    const tool = createReadTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE);

    const result = await execute(tool, { path: '/tmp/cjk.txt' });

    expect(result.isError).not.toBe(true);
    expect(result.output).toContain('1\t你好世界');
    expect(result.note).toContain('Detected file encoding: UTF-16 LE');
  });

  it('reads BOM-less UTF-16 LE text via the zero-byte heuristic', async () => {
    const bytes = Buffer.from('first\nsecond\n', 'utf16le');
    const { fs } = createSpiedMapFs({ '/tmp/no-bom.txt': { bytes } });
    const tool = createReadTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE);

    const result = await execute(tool, { path: '/tmp/no-bom.txt' });

    expect(result.isError).not.toBe(true);
    expect(result.output).toContain('1\tfirst');
    expect(result.output).toContain('2\tsecond');
    expect(result.note).toContain('Detected file encoding: UTF-16 LE');
  });

  it('reads a UTF-16 BE file with BOM', async () => {
    const le = Buffer.from('big endian\n', 'utf16le');
    const be = Buffer.alloc(le.length);
    for (let i = 0; i < le.length; i += 2) {
      be[i] = le[i + 1]!;
      be[i + 1] = le[i]!;
    }
    const bytes = Buffer.concat([Buffer.from([0xfe, 0xff]), be]);
    const { fs } = createSpiedMapFs({ '/tmp/be.txt': { bytes } });
    const tool = createReadTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE);

    const result = await execute(tool, { path: '/tmp/be.txt' });

    expect(result.isError).not.toBe(true);
    expect(result.output).toContain('1\tbig endian');
    expect(result.note).toContain('Detected file encoding: UTF-16 BE');
  });

  it('paginates transcoded UTF-16 files in tail mode', async () => {
    const bytes = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('one\ntwo\nthree\n', 'utf16le'),
    ]);
    const { fs } = createSpiedMapFs({ '/tmp/tail.txt': { bytes } });
    const tool = createReadTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE);

    const result = await execute(tool, { path: '/tmp/tail.txt', line_offset: -1 });

    expect(result.isError).not.toBe(true);
    expect(result.output).toContain('3\tthree');
    expect(result.output).not.toContain('1\tone');
    expect(result.note).toContain('Detected file encoding: UTF-16 LE');
  });

  it('refuses a UTF-16 file that exceeds TRANSCODE_MAX_BYTES', async () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('x\n', 'utf16le')]);
    const { fs } = createSpiedMapFs({
      '/tmp/huge.txt': { bytes, size: TRANSCODE_MAX_BYTES + 1 },
    });
    const tool = createReadTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE);

    const result = await execute(tool, { path: '/tmp/huge.txt' });
    const output = toolContentString(result);

    expect(result.isError).toBe(true);
    expect(output).toContain('UTF-16 LE');
    expect(output).toContain('too large to transcode');
  });

  it('returns long lines whole without losing Unicode characters', async () => {
    const long = '文'.repeat(5_000) + '🙂END';
    const tool = toolWithContent([long, 'short', long].join('\n'));
    const result = await execute(tool, { path: '/tmp/long.txt' });

    expect(result.isError).not.toBe(true);
    expect(result.output).toBe(`1\t${long}\n2\tshort\n3\t${long}`);
    expect(result.note).toContain('Requested range complete.');
    expect(result.truncated).toBeUndefined();
  });

  it.each([2, -3])('recovers the entire oversized range at offset %i using only Read', async (lineOffset) => {
    const long = '文'.repeat(700) + '🙂END';
    const tool = toolWithContent(['outside before', 'target head', long, 'outside after'].join('\n'));
    const returned = new Map<number, string>();
    let args: ReadInput | undefined = { path: '/tmp/line.txt', line_offset: lineOffset, n_lines: 2, max_chars: 650 };

    for (let page = 0; args !== undefined && page < 20; page += 1) {
      const result = await execute(tool, args);
      const output = toolContentString(result);
      if (result.isError) {
        expect(lineOffset).toBe(-3);
        expect(page).toBe(0);
        expect(output).not.toContain('Bash');
        expect(result.note).toContain('Next Read:');
      } else {
        expect(output.length + 1 + (result.note?.length ?? 0)).toBeLessThanOrEqual(650);
        for (const row of output.split('\n')) {
          const separator = row.indexOf('\t');
          const line = Number(row.slice(0, separator));
          expect([2, 3]).toContain(line);
          returned.set(line, (returned.get(line) ?? '') + row.slice(separator + 1));
        }
      }
      expect(result.note).not.toContain('End of file reached.');
      const next = result.note?.match(/Next Read: (\{[^\n]*\})/);
      args = next === undefined || next === null ? undefined : ReadInputSchema.parse(JSON.parse(next[1]!));
      if (lineOffset < 0 && page === 0) {
        expect(args).toMatchObject({ line_offset: 2, n_lines: 2, max_chars: 650 });
      }
    }

    expect(args).toBeUndefined();
    expect(returned.get(2)).toBe('target head');
    expect(returned.get(3)).toBe(long);
  });

  it('returns agent event log lines untruncated and marks the read spill-exempt', async () => {
    const long = 'x'.repeat(2_000 + 10);
    const truncation: IAgentToolResultTruncationService = {
      ...stubToolResultTruncationService(),
      isWireJournalPath: (path) => path.endsWith('/wire.jsonl'),
    };
    const tool = createReadTool(
      createSpiedFs([long, 'short'].join('\n')).fs,
      createTestEnv(),
      PERMISSIVE_WORKSPACE,
      undefined,
      truncation,
    );

    const result = await execute(tool, {
      path: '/home/user/.kimi-code/sessions/ws/session/agents/main/wire.jsonl',
    });
    const output = toolContentString(result);

    expect(output).toContain(long);
    expect(output).not.toContain('...');
    expect(result.note).not.toContain('were truncated');
    expect(result.note).toContain('Kimi Code agent event log');
    expect(result.spillExempt).toBe(true);
  });

  it('reads a whole long event log record with an explicit character budget', async () => {
    const huge = 'y'.repeat(150_100);
    const truncation: IAgentToolResultTruncationService = {
      ...stubToolResultTruncationService(),
      isWireJournalPath: (path) => path.endsWith('/wire.jsonl'),
    };
    const tool = createReadTool(createSpiedFs(`${huge}\nshort`).fs, createTestEnv(), PERMISSIVE_WORKSPACE, undefined, truncation);
    const result = await execute(tool, {
      path: '/home/user/.kimi-code/sessions/ws/session/agents/main/wire.jsonl',
      line_offset: 1,
      n_lines: 1,
      max_chars: 500_000,
    });

    expect(result.isError).not.toBe(true);
    expect(result.output).toBe(`1\t${huge}`);
    expect(result.note).toContain('Requested range complete.');
    expect(result.spillExempt).toBe(true);
  });

  it('returns a whole large final event log record within the requested character budget', async () => {
    const huge = 'z'.repeat(105_000);
    const tool = toolWithContent(`first\n${huge}`);
    const result = await execute(tool, {
      path: '/tmp/wire.jsonl',
      line_offset: -1,
      max_chars: 500_000,
    });

    expect(result.isError).not.toBe(true);
    expect(result.output).toBe(`2\t${huge}`);
    expect(result.note).toContain('End of file reached.');
  });

  it('uses the same whole-line and spill policy for ordinary paths', async () => {
    const long = 'x'.repeat(2_010);
    const tool = toolWithContent([long, 'short'].join('\n'));
    const result = await execute(tool, { path: '/tmp/ordinary.txt' });

    expect(result.output).toBe(`1\t${long}\n2\tshort`);
    expect(result.truncated).toBeUndefined();
    expect(result.spillExempt).toBe(true);
  });

  it('fits complete lines and status within the default character budget', async () => {
    const line = '文'.repeat(2_000);
    const tool = toolWithContent(Array.from({ length: 80 }, () => line).join('\n'));
    const result = await execute(tool, { path: '/tmp/characters.txt' });
    const output = toolContentString(result);

    expect(result.isError).not.toBe(true);
    expect(output.length + 1 + (result.note?.length ?? 0)).toBeLessThanOrEqual(100_000);
    expect(Buffer.byteLength(output, 'utf8')).toBeGreaterThan(100_000);
    expect(output.split('\n').every((entry) => entry.replace(/^\d+\t/, '') === line)).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.note).toContain('Next Read:');
  });

  it('reads through bounded byte preflight and streams line iteration without full readText', async () => {
    const bytes = Buffer.from(
      Array.from({ length: 1_000 + 5 }, (_, i) => `line ${String(i + 1)}`).join('\n'),
      'utf8',
    );
    const readText = vi.fn(async () => {
      throw new Error('full readText should not be called');
    });
    let consumed = 0;
    const readLines = vi.fn().mockImplementation(async function* (): AsyncGenerator<string> {
      for (let i = 1; i <= 1_000 + 5; i += 1) {
        consumed = i;
        yield `line ${String(i)}\n`;
      }
    });
    const readBytes = vi.fn(async (_path: string, n?: number) =>
      n === undefined ? bytes : bytes.subarray(0, n),
    );
    const stat = vi.fn(async () => ({ isFile: true, isDirectory: false, size: bytes.length }));
    const fs = { cwd: '/', readBytes, readLines, readText, stat } as unknown as IHostFileSystem;
    const tool = createReadTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE);

    const result = await execute(tool, { path: '/tmp/large.txt' });
    const output = toolContentString(result);

    expect(result.isError).toBeFalsy();
    expect(output).toContain('1\tline 1');
    expect(output).toContain(`${String(1_000)}\tline ${String(1_000)}`);
    expect(result.note).toContain(`Total lines in file: ${String(1_000 + 5)}.`);
    expect(result.note).toContain('Requested range complete.');
    expect(consumed).toBe(1_000 + 5);
    expect(readBytes).toHaveBeenCalledWith('/tmp/large.txt', MEDIA_SNIFF_BYTES);
    expect(readText).not.toHaveBeenCalled();
  });

  it('reads beyond 1000 lines by default when the character budget fits', async () => {
    const content = Array.from({ length: 1001 }, (_, i) => `line ${String(i + 1)}`).join('\n');
    const result = await execute(toolWithContent(content), { path: '/tmp/big.txt' });

    expect(result.isError).not.toBe(true);
    expect(result.output).toContain('1001\tline 1001');
    expect(result.note).toContain('Requested range complete.');
    expect(result.truncated).toBeUndefined();
  });

  it('tail character pagination keeps the newest lines closest to EOF', async () => {
    const numLines = Math.floor(100_000 / 1001) + 20;
    const content = Array.from({ length: numLines }, (_, i) => {
      return `${String(i + 1).padStart(4, '0')}${'B'.repeat(996)}`;
    }).join('\n');
    const tool = toolWithContent(content);

    const result = await execute(tool, { path: '/tmp/tail-bytes.txt', line_offset: -1000 });
    const output = toolContentString(result);
    const outputLines = output.split('\n').filter((line) => line.includes('\t'));

    expect(result.note).toContain('Character limit reached.');
    expect(outputLines.at(-1)).toContain(String(numLines).padStart(4, '0'));
    expect(outputLines[0]).not.toContain('0001');
  });

  it('tail n_lines is applied before character pagination', async () => {
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

  it('interpolates the cap constants into the description and references the Grep tool', () => {
    const tool = toolWithContent('');
    expect(tool.description).toContain('100000');
    expect(tool.description).toContain('500000');
    expect(tool.description).toContain('Grep');
  });

  it('reads files inside additional_dirs via absolute path', async () => {
    const { fs } = createSpiedFs('extra-dir note');
    const tool = createReadTool(fs, createTestEnv(), stubWorkspaceContext('/workspace', ['/extra']));

    const result = await execute(tool, { path: '/extra/notes.txt' });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('1\textra-dir note');
  });

  it('reports nonexistent files with the expected does-not-exist phrasing', async () => {
    const { fs } = createSpiedMapFs({});
    const tool = createReadTool(fs, createTestEnv(), stubWorkspaceContext('/workspace'));

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
      readNote('No lines read from file. Total lines in file: 0. Requested range complete. Effective max_chars: 100000. End of file reached.'),
    );
  });

  it('rejects an empty read when its model-visible status cannot fit the character budget', async () => {
    const result = await execute(toolWithContent(''), { path: '/tmp/empty.txt', max_chars: 150 });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('too small');
    expect(result.output).toContain('Increase max_chars');
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

  it('accepts large positive and negative line ranges without a fixed line cap', () => {
    expect(ReadInputSchema.safeParse({ path: '/tmp/a.txt', line_offset: -1 }).success).toBe(true);
    expect(ReadInputSchema.safeParse({ path: '/tmp/a.txt', line_offset: -10_000, n_lines: 10_000 }).success).toBe(
      true,
    );
    expect(ReadInputSchema.safeParse({ path: '/tmp/a.txt', line_offset: 10_000 }).success).toBe(true);
    expect(ReadInputSchema.safeParse({ path: '/tmp/a.txt', line_offset: 0 }).success).toBe(false);
    expect(ReadInputSchema.safeParse({ path: '/tmp/a.txt', line_offset: -1.5 }).success).toBe(false);
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
    expect(result.note).toContain('Total lines in file: 5. Requested range complete. Effective max_chars: 100000.');
  });

  it('tail mode on an empty file returns empty output without erroring', async () => {
    const tool = toolWithContent('');

    const result = await execute(tool, { path: '/tmp/empty-tail.txt', line_offset: -10 });

    expect(result.isError).toBeFalsy();
    expect(result.note).toContain('Total lines in file: 0. Requested range complete. Effective max_chars: 100000.');
  });

  it('line_offset=-1 returns only the last line with its absolute line number', async () => {
    const tool = toolWithContent('a\nb\nc\nd\ne');

    const result = await execute(tool, { path: '/tmp/last.txt', line_offset: -1 });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('5\te');
    expect(result.note).toContain('1 line read from file starting from line 5.');
  });

  it('keeps absolute line numbers and whole long lines in tail mode', async () => {
    const longLine = 'X'.repeat(2_500);
    const result = await execute(toolWithContent(['short', longLine, 'short', longLine, 'short'].join('\n')), {
      path: '/tmp/tail-long.txt',
      line_offset: -3,
    });

    expect(result.isError).not.toBe(true);
    expect(result.output).toBe(`3\tshort\n4\t${longLine}\n5\tshort`);
    expect(result.truncated).toBeUndefined();
  });

  it('rechecks runtime availability when execution starts after the tool was shown', async () => {
    const env = createTestEnv();
    const fs = createSpiedFs('visible').fs;
    const runtimeValue = new FakeRuntime(
      { workspaceId: 'workspace', runtimeId: 'local', generation: 'test' },
      { capabilities: ['fs'] },
    );
    Object.assign(runtimeValue, { environment: env, fs });
    const registry = new RuntimeRegistry('workspace');
    registry.register(runtimeValue);
    const binding = { workspaceId: 'workspace', runtimeId: 'local' } as const;
    const runtime: IAgentRuntimeService = {
      _serviceBrand: undefined,
      onDidChange: (listener) => registry.onDidChange(() => listener()),
      isAvailable: (required = []) => {
        try {
          const lease = registry.acquire(binding, required);
          lease.dispose();
          return true;
        } catch {
          return false;
        }
      },
      inspect: () => registry.inspect(binding),
      acquire: (required = []) => registry.acquire(binding, required),
    };
    const tool = new ReadTool(
      runtime,
      stubWorkspaceContext('/workspace'),
      { catalog: { getSkillRoots: () => [] } } as unknown as ISessionSkillCatalog,
      stubToolResultTruncationService(),
      stubConfigService(),
    );
    const execution = tool.resolveExecution({ path: '/workspace/a.txt' });
    expect('execute' in execution).toBe(true);

    runtimeValue.setStatus('disconnected');

    if (!('execute' in execution)) throw new Error('expected executable Read tool');
    await expect(
      execution.execute({ turnId: 0, toolCallId: 'call_read_late', signal }),
    ).rejects.toMatchObject({ code: 'runtime.unavailable' });
  });
});
