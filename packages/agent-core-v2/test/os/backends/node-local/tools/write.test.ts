import { describe, expect, it, vi } from 'vitest';

import { PathSecurityError } from '#/tool/path-access';
import type { HostFileStat, IHostFileSystem } from '#/os/interface/hostFileSystem';
import { stubWorkspaceContext } from '../../../../session/workspaceContext/stub-workspace-context';
import { type WriteInput, WriteInputSchema } from '#/agent/tools/os/write/write';
import { WriteTool } from '#/agent/tools/os/write/writeTool';
import { resolveNewFileEditorStyle } from '#/agent/tools/os/write/editorconfig';
import type { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { FakeRuntime } from '#/runtime/fakeRuntime';
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
  readBytes?: (path: string, n?: number) => Promise<Uint8Array>;
  writeBytes?: (path: string, data: Uint8Array) => Promise<void>;
  createExclusive?: (path: string, data: Uint8Array) => Promise<boolean>;
  stat?: (path: string) => Promise<HostFileStat>;
  mkdir?: (path: string) => Promise<void>;
  readdir?: (path: string) => Promise<readonly { name: string; isFile: boolean; isDirectory: boolean }[]>;
}

function enoentError(): Error {
  return Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
}

function createWriteFs(options: WriteFsOptions = {}) {
  const readText = vi.fn(
    options.readText ??
      (async () => {
        throw enoentError();
      }),
  );
  const writeText = vi.fn(options.writeText ?? (async () => {}));
  const appendText = vi.fn(options.appendText ?? (async () => {}));
  const readBytes = vi.fn(
    options.readBytes ??
      (async () => {
        throw enoentError();
      }),
  );
  const writeBytes = vi.fn(options.writeBytes ?? (async () => {}));
  const createExclusive = vi.fn(options.createExclusive ?? (async () => true));
  const stat = vi.fn(
    options.stat ?? (async () => ({ isFile: false, isDirectory: true, size: 0 })),
  );
  const mkdir = vi.fn(options.mkdir ?? (async () => {}));
  const readdir = vi.fn(options.readdir ?? (async () => []));
  const fs = {
    cwd: '/',
    readText,
    writeText,
    appendText,
    readBytes,
    writeBytes,
    createExclusive,
    stat,
    mkdir,
    readdir,
  } as unknown as IHostFileSystem;
  return { fs, readText, writeText, appendText, readBytes, writeBytes, createExclusive, stat, mkdir, readdir };
}

function makeTool(options: WriteFsOptions = {}, workspace = PERMISSIVE_WORKSPACE) {
  const fakes = createWriteFs(options);
  const backend = Object.assign(
    new FakeRuntime(
      { workspaceId: 'workspace', runtimeId: 'local', generation: 'test' },
      { capabilities: ['fs'] },
    ),
    { fs: fakes.fs, environment: createTestEnv() },
  );
  const runtime: IAgentRuntimeService = {
    _serviceBrand: undefined,
    onDidChange: () => ({ dispose: () => {} }),
    isAvailable: () => true,
    inspect: () => backend,
    acquire: () => ({ runtime: backend, track: (resource) => resource, dispose: () => {} }),
  };
  const tool = new WriteTool(runtime, workspace);
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
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: {
        content: { type: 'string' },
        mode: {
          enum: ['overwrite', 'append'],
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

  it('writes content through fs and reports bytes written', async () => {
    const { tool, writeText } = makeTool();

    const result = await execute(tool, { path: '/tmp/new.txt', content: 'hello' });

    expect(writeText).toHaveBeenCalledWith('/tmp/new.txt', 'hello');
    expect(result.output).toContain('Wrote 5 bytes');
  });

  it('expands leading tilde paths using the kaos home directory', async () => {
    const fakes = createWriteFs();
    const environment = createTestEnv('/home/test');
    const backend = Object.assign(
      new FakeRuntime(
        { workspaceId: 'workspace', runtimeId: 'local', generation: 'test' },
        { capabilities: ['fs'] },
      ),
      { fs: fakes.fs, environment },
    );
    const runtime: IAgentRuntimeService = {
      _serviceBrand: undefined,
      onDidChange: () => ({ dispose: () => {} }),
      isAvailable: () => true,
      inspect: () => backend,
      acquire: () => ({ runtime: backend, track: (resource) => resource, dispose: () => {} }),
    };
    const tool = new WriteTool(runtime, PERMISSIVE_WORKSPACE);

    const result = await execute(tool, { path: '~/notes/today.txt', content: 'hello' });

    expect(fakes.writeText).toHaveBeenCalledWith('/home/test/notes/today.txt', 'hello');
    expect(result.output).toContain('Wrote 5 bytes');
  });

  it('appends content through appendText without reading existing bytes', async () => {
    const { tool, readText, readBytes, writeText, appendText } = makeTool();

    const result = await execute(tool, {
      path: '/tmp/existing.txt',
      content: '\nhello',
      mode: 'append',
    });

    expect(appendText).toHaveBeenCalledWith('/tmp/existing.txt', '\nhello');
    expect(readText).not.toHaveBeenCalled();
    expect(readBytes).not.toHaveBeenCalled();
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
    const { tool, readText, readBytes, appendText } = makeTool();

    const result = await execute(tool, {
      path: '/tmp/new-append.txt',
      content: 'New content',
      mode: 'append',
    });

    expect(result.isError).toBeFalsy();
    expect(toolContentString(result).toLowerCase()).toContain('appended');
    expect(appendText).toHaveBeenCalledWith('/tmp/new-append.txt', 'New content');
    expect(readText).not.toHaveBeenCalled();
    expect(readBytes).not.toHaveBeenCalled();
  });

  it('allows absolute writes to a sibling dir that merely shares the work-dir prefix', async () => {
    const { tool, writeText } = makeTool({}, stubWorkspaceContext('/workspace'));

    const result = await execute(tool, { path: '/workspace-sneaky/file.txt', content: 'content' });

    expect(result.isError).toBeFalsy();
    expect(writeText).toHaveBeenCalledWith('/workspace-sneaky/file.txt', 'content');
  });

  it('preserves a UTF-8 BOM when overwriting an existing file', async () => {
    const readBytes = vi.fn(async () =>
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello\n', 'utf8')]),
    );
    const writeBytes = vi.fn(async (_path: string, _data: Uint8Array) => {});
    const { tool, writeText } = makeTool({ readBytes, writeBytes });

    const result = await execute(tool, { path: '/tmp/bom.txt', content: 'world\n' });

    expect(writeBytes).toHaveBeenCalledTimes(1);
    const payload = writeBytes.mock.calls[0]![1];
    expect([...payload.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(Buffer.from(payload).toString('utf8')).toBe('\uFEFFworld\n');
    expect(writeText).not.toHaveBeenCalled();
    expect(result.output).toContain(`Wrote ${String(payload.length)} bytes`);
  });

  it('does not add a BOM when overwriting a BOM-less file', async () => {
    const readBytes = vi.fn(async () => Buffer.from('old\n', 'utf8'));
    const writeBytes = vi.fn(async (_path: string, _data: Uint8Array) => {});
    const { tool, writeText } = makeTool({ readBytes, writeBytes });

    const result = await execute(tool, { path: '/tmp/plain.txt', content: 'new\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/plain.txt', 'new\n');
    expect(writeBytes).not.toHaveBeenCalled();
    expect(result.output).toContain('Wrote 4 bytes');
  });

  it('strips one leading U+FEFF when overwriting a BOM-less file', async () => {
    const readBytes = vi.fn(async () => Buffer.from('old\n', 'utf8'));
    const writeBytes = vi.fn(async (_path: string, _data: Uint8Array) => {});
    const { tool, writeText } = makeTool({ readBytes, writeBytes });

    const result = await execute(tool, { path: '/tmp/plain.txt', content: '\uFEFFnew\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/plain.txt', 'new\n');
    expect(writeBytes).not.toHaveBeenCalled();
    expect(result.output).toContain('Wrote 4 bytes');
  });

  it('falls back to a literal write when a UTF-8 BOM file carries binary bytes', async () => {
    const readBytes = vi.fn(async () => Buffer.from([0xef, 0xbb, 0xbf, 0x00, 0xd8]));
    const writeBytes = vi.fn(async (_path: string, _data: Uint8Array) => {});
    const { tool, writeText } = makeTool({ readBytes, writeBytes });

    const result = await execute(tool, { path: '/tmp/bombin.txt', content: 'x\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/bombin.txt', 'x\n');
    expect(writeBytes).not.toHaveBeenCalled();
    expect(result.output).toContain('Wrote 2 bytes');
  });

  it('normalizes content line endings to the existing file CRLF style', async () => {
    const readBytes = vi.fn(async () => Buffer.from('a\r\nb\r\n', 'utf8'));
    const { tool, writeText } = makeTool({ readBytes });

    const result = await execute(tool, { path: '/tmp/crlf.txt', content: 'x\ny\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/crlf.txt', 'x\r\ny\r\n');
    expect(result.output).toContain('Wrote 6 bytes');
  });

  it('keeps content line endings unchanged when the file has no dominant style', async () => {
    const readBytes = vi.fn(async () => Buffer.from('one\r\ntwo\nthree\r\nfour\n', 'utf8'));
    const { tool, writeText } = makeTool({ readBytes });

    const result = await execute(tool, { path: '/tmp/tied.txt', content: 'x\ny\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/tied.txt', 'x\ny\n');
  });

  it('normalizes content line endings to the existing file CR-only style', async () => {
    const readBytes = vi.fn(async () => Buffer.from('a\rb\rc', 'utf8'));
    const { tool, writeText } = makeTool({ readBytes });

    const result = await execute(tool, { path: '/tmp/cr.txt', content: 'x\ny\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/cr.txt', 'x\ry\r');
    expect(result.output).toContain('Wrote 4 bytes');
  });

  it('normalizes mixed endings to CR when lone CR dominates', async () => {
    const readBytes = vi.fn(async () => Buffer.from('a\rb\rc\rd\ne', 'utf8'));
    const { tool, writeText } = makeTool({ readBytes });

    await execute(tool, { path: '/tmp/cr-heavy.txt', content: 'x\ny\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/cr-heavy.txt', 'x\ry\r');
  });

  it('keeps content line endings when lone CR ties with LF', async () => {
    const readBytes = vi.fn(async () => Buffer.from('a\rb\rc\nd\ne', 'utf8'));
    const { tool, writeText } = makeTool({ readBytes });

    await execute(tool, { path: '/tmp/cr-tied.txt', content: 'x\ny\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/cr-tied.txt', 'x\ny\n');
  });

  it('writes UTF-16LE with BOM when overwriting an existing UTF-16LE file', async () => {
    const readBytes = vi.fn(async () =>
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a\r\n', 'utf16le')]),
    );
    const writeBytes = vi.fn(async (_path: string, _data: Uint8Array) => {});
    const { tool, writeText } = makeTool({ readBytes, writeBytes });

    const result = await execute(tool, { path: '/tmp/utf16.txt', content: 'x\ny\n' });

    expect(writeBytes).toHaveBeenCalledTimes(1);
    const payload = writeBytes.mock.calls[0]![1];
    expect([...payload.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(Buffer.from(payload.subarray(2)).toString('utf16le')).toBe('x\r\ny\r\n');
    expect(writeText).not.toHaveBeenCalled();
    expect(result.output).toContain(`Wrote ${String(payload.length)} bytes`);
  });

  it('writes UTF-16BE with BOM when overwriting an existing UTF-16BE file', async () => {
    const le = Buffer.from('a\r\n', 'utf16le');
    const be = Buffer.alloc(le.length);
    for (let i = 0; i + 1 < le.length; i += 2) {
      be[i] = le[i + 1]!;
      be[i + 1] = le[i]!;
    }
    const readBytes = vi.fn(async () => Buffer.concat([Buffer.from([0xfe, 0xff]), be]));
    const writeBytes = vi.fn(async (_path: string, _data: Uint8Array) => {});
    const { tool, writeText } = makeTool({ readBytes, writeBytes });

    const result = await execute(tool, { path: '/tmp/utf16be.txt', content: 'x\ny\n' });

    expect(writeBytes).toHaveBeenCalledTimes(1);
    const payload = writeBytes.mock.calls[0]![1];
    expect([...payload.subarray(0, 2)]).toEqual([0xfe, 0xff]);
    const leBody = Buffer.alloc(payload.length - 2);
    const body = payload.subarray(2);
    for (let i = 0; i + 1 < body.length; i += 2) {
      leBody[i] = body[i + 1]!;
      leBody[i + 1] = body[i]!;
    }
    expect(leBody.toString('utf16le')).toBe('x\r\ny\r\n');
    expect(writeText).not.toHaveBeenCalled();
    expect(result.output).toContain(`Wrote ${String(payload.length)} bytes`);
  });

  it('well-forms lone surrogates when re-encoding a UTF-16 file', async () => {
    const readBytes = vi.fn(async () =>
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a\n', 'utf16le')]),
    );
    const writeBytes = vi.fn(async (_path: string, _data: Uint8Array) => {});
    const { tool } = makeTool({ readBytes, writeBytes });

    await execute(tool, { path: '/tmp/utf16-lone.txt', content: 'x\uD800y\n' });

    expect(writeBytes).toHaveBeenCalledTimes(1);
    const payload = writeBytes.mock.calls[0]![1];
    expect(new TextDecoder('utf-16le', { fatal: true }).decode(payload.subarray(2))).toBe(
      'x\uFFFDy\n',
    );
  });

  it('falls back to a literal write when overwriting an unsupported UTF-32 file', async () => {
    const readBytes = vi.fn(async () =>
      Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x61, 0x00, 0x00, 0x00, 0x0a, 0x00, 0x00, 0x00]),
    );
    const writeBytes = vi.fn(async (_path: string, _data: Uint8Array) => {});
    const { tool, writeText } = makeTool({ readBytes, writeBytes });

    const result = await execute(tool, { path: '/tmp/utf32.txt', content: 'x\ny\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/utf32.txt', 'x\ny\n');
    expect(writeBytes).not.toHaveBeenCalled();
    expect(result.output).toContain('Wrote 4 bytes');
  });

  it('does not double the BOM when the content already starts with one', async () => {
    const readBytes = vi.fn(async () =>
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello\n', 'utf8')]),
    );
    const writeBytes = vi.fn(async (_path: string, _data: Uint8Array) => {});
    const { tool, writeText } = makeTool({ readBytes, writeBytes });

    const result = await execute(tool, { path: '/tmp/bom.txt', content: '\uFEFFworld\n' });

    expect(writeBytes).toHaveBeenCalledTimes(1);
    const payload = writeBytes.mock.calls[0]![1];
    expect(Buffer.from(payload).toString('utf8')).toBe('\uFEFFworld\n');
    expect(writeText).not.toHaveBeenCalled();
    expect(result.output).toContain(`Wrote ${String(payload.length)} bytes`);
  });

  it('does not derive an EOL style from UTF-32 bytes decoded as UTF-8', async () => {
    const readBytes = vi.fn(async () =>
      Buffer.from([
        0xff, 0xfe, 0x00, 0x00, 0x61, 0x00, 0x00, 0x00, 0x0a, 0x00, 0x00, 0x00, 0x62, 0x00,
        0x00, 0x00, 0x0a, 0x00, 0x00, 0x00,
      ]),
    );
    const writeBytes = vi.fn(async (_path: string, _data: Uint8Array) => {});
    const { tool, writeText } = makeTool({ readBytes, writeBytes });

    const result = await execute(tool, { path: '/tmp/utf32-eol.txt', content: 'x\r\ny\r\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/utf32-eol.txt', 'x\r\ny\r\n');
    expect(writeBytes).not.toHaveBeenCalled();
  });

  it('falls back to a literal write when the existing file is BOM-less UTF-16', async () => {
    const readBytes = vi.fn(async () => Buffer.from('a\nb\n', 'utf16le'));
    const writeBytes = vi.fn(async (_path: string, _data: Uint8Array) => {});
    const { tool, writeText } = makeTool({ readBytes, writeBytes });

    const result = await execute(tool, { path: '/tmp/utf16nobom.txt', content: 'x\r\ny\r\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/utf16nobom.txt', 'x\r\ny\r\n');
    expect(writeBytes).not.toHaveBeenCalled();
  });

  it('treats BOM-less UTF-16 bytes that are also valid UTF-8 as a UTF-8 file', async () => {
    const readBytes = vi.fn(async () => Buffer.from('你好世界', 'utf16le'));
    const writeBytes = vi.fn(async (_path: string, _data: Uint8Array) => {});
    const { tool, writeText } = makeTool({ readBytes, writeBytes });

    const result = await execute(tool, { path: '/tmp/ambig.txt', content: 'x\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/ambig.txt', 'x\n');
    expect(writeBytes).not.toHaveBeenCalled();
    expect(result.output).toContain('Wrote 2 bytes');
  });

  it('falls back to a literal write when a UTF-8 BOM file carries UTF-16 bytes', async () => {
    const readBytes = vi.fn(async () =>
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\nb\r\n', 'utf16le')]),
    );
    const writeBytes = vi.fn(async (_path: string, _data: Uint8Array) => {});
    const { tool, writeText } = makeTool({ readBytes, writeBytes });

    const result = await execute(tool, { path: '/tmp/mixed.txt', content: 'x\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/mixed.txt', 'x\n');
    expect(writeBytes).not.toHaveBeenCalled();
    expect(result.output).toContain('Wrote 2 bytes');
  });

  it('falls back to a literal write when a UTF-16 file is malformed', async () => {
    const readBytes = vi.fn(async () => Buffer.from([0xff, 0xfe, 0x61, 0x00, 0x00, 0xdc]));
    const writeBytes = vi.fn(async (_path: string, _data: Uint8Array) => {});
    const { tool, writeText } = makeTool({ readBytes, writeBytes });

    const result = await execute(tool, { path: '/tmp/utf16-bad.txt', content: 'x\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/utf16-bad.txt', 'x\n');
    expect(writeBytes).not.toHaveBeenCalled();
    expect(result.output).toContain('Wrote 2 bytes');
  });

  it('keeps the UTF-16 style when the sample ends on a surrogate boundary', async () => {
    const full = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('a'.repeat(4094), 'utf16le'),
      Buffer.from('\u{10000}', 'utf16le'),
    ]);
    const readBytes = vi.fn(async (_path: string, n?: number) =>
      full.subarray(0, n ?? full.length),
    );
    const writeBytes = vi.fn(async (_path: string, _data: Uint8Array) => {});
    const { tool, writeText } = makeTool({ readBytes, writeBytes });

    await execute(tool, { path: '/tmp/utf16-boundary.txt', content: 'x\n' });

    expect(writeBytes).toHaveBeenCalledTimes(1);
    const payload = writeBytes.mock.calls[0]![1];
    expect([...payload.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('falls back to a literal write when a malformed sequence sits at the boundary of a BOM file', async () => {
    const full = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('a'.repeat(8192), 'utf8'),
      Buffer.from([0xc2, 0x61]),
    ]);
    expect(full.length).toBe(8197);
    const readBytes = vi.fn(async (_path: string, n?: number) =>
      full.subarray(0, n ?? full.length),
    );
    const writeBytes = vi.fn(async (_path: string, _data: Uint8Array) => {});
    const { tool, writeText } = makeTool({ readBytes, writeBytes });

    const result = await execute(tool, { path: '/tmp/bom-boundary-bad.txt', content: 'x\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/bom-boundary-bad.txt', 'x\n');
    expect(writeBytes).not.toHaveBeenCalled();
    expect(result.output).toContain('Wrote 2 bytes');
  });

  it('keeps the sampled style when a boundary sequence completes in a BOM file', async () => {
    const full = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('x\r\n'.repeat(2730), 'utf8'),
      Buffer.from([0xc2, 0xa9]),
    ]);
    expect(full.length).toBe(8195);
    const readBytes = vi.fn(async (_path: string, n?: number) =>
      full.subarray(0, n ?? full.length),
    );
    const writeBytes = vi.fn(async (_path: string, _data: Uint8Array) => {});
    const { tool, writeText } = makeTool({ readBytes, writeBytes });

    await execute(tool, { path: '/tmp/bom-boundary-good.txt', content: 'a\n' });

    expect(writeBytes).toHaveBeenCalledTimes(1);
    const payload = writeBytes.mock.calls[0]![1];
    expect([...payload.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(Buffer.from(payload.subarray(3)).toString('utf8')).toBe('a\r\n');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('falls back to a literal write when the file ends in the lookahead tail with malformed bytes', async () => {
    const full = Buffer.concat([
      Buffer.from('a'.repeat(8196), 'utf8'),
      Buffer.from([0xc2, 0x61]),
    ]);
    expect(full.length).toBe(8198);
    const readBytes = vi.fn(async (_path: string, n?: number) =>
      full.subarray(0, n ?? full.length),
    );
    const writeBytes = vi.fn(async (_path: string, _data: Uint8Array) => {});
    const { tool, writeText } = makeTool({ readBytes, writeBytes });

    const result = await execute(tool, { path: '/tmp/tail-bad.txt', content: 'x\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/tail-bad.txt', 'x\n');
    expect(writeBytes).not.toHaveBeenCalled();
    expect(result.output).toContain('Wrote 2 bytes');
  });

  it('falls back to a literal write for a complete file malformed at the sample boundary', async () => {
    const full = Buffer.concat([
      Buffer.from('a'.repeat(8191), 'utf8'),
      Buffer.from([0xc2, 0x61]),
    ]);
    expect(full.length).toBe(8193);
    const readBytes = vi.fn(async (_path: string, n?: number) =>
      full.subarray(0, n ?? full.length),
    );
    const writeBytes = vi.fn(async (_path: string, _data: Uint8Array) => {});
    const { tool, writeText } = makeTool({ readBytes, writeBytes });

    const result = await execute(tool, { path: '/tmp/boundary-bad.txt', content: 'x\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/boundary-bad.txt', 'x\n');
    expect(writeBytes).not.toHaveBeenCalled();
    expect(result.output).toContain('Wrote 2 bytes');
  });

  it('adopts the sampled style for a complete file whose boundary sequence completes', async () => {
    const full = Buffer.concat([
      Buffer.from('x\r\n'.repeat(2730), 'utf8'),
      Buffer.from('q', 'utf8'),
      Buffer.from([0xc2, 0xa9]),
    ]);
    expect(full.length).toBe(8193);
    const readBytes = vi.fn(async (_path: string, n?: number) =>
      full.subarray(0, n ?? full.length),
    );
    const { tool, writeText } = makeTool({ readBytes });

    await execute(tool, { path: '/tmp/boundary-good.txt', content: 'a\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/boundary-good.txt', 'a\r\n');
  });

  it('falls back to a literal write for a complete UTF-16 file malformed at the boundary', async () => {
    const full = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('a'.repeat(4095), 'utf16le'),
      Buffer.from([0xd8]),
    ]);
    expect(full.length).toBe(8193);
    const readBytes = vi.fn(async (_path: string, n?: number) =>
      full.subarray(0, n ?? full.length),
    );
    const writeBytes = vi.fn(async (_path: string, _data: Uint8Array) => {});
    const { tool, writeText } = makeTool({ readBytes, writeBytes });

    const result = await execute(tool, { path: '/tmp/utf16-boundary-bad.txt', content: 'x\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/utf16-boundary-bad.txt', 'x\n');
    expect(writeBytes).not.toHaveBeenCalled();
    expect(result.output).toContain('Wrote 2 bytes');
  });

  it('keeps the UTF-16 style when the file continues past the sampled region', async () => {
    const full = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('a'.repeat(4095), 'utf16le'),
      Buffer.from('\u{10000}', 'utf16le'),
      Buffer.from('bbbb', 'utf8'),
    ]);
    expect(full.length).toBe(8200);
    const readBytes = vi.fn(async (_path: string, n?: number) =>
      full.subarray(0, n ?? full.length),
    );
    const writeBytes = vi.fn(async (_path: string, _data: Uint8Array) => {});
    const { tool, writeText } = makeTool({ readBytes, writeBytes });

    await execute(tool, { path: '/tmp/utf16-long.txt', content: 'x\n' });

    expect(writeBytes).toHaveBeenCalledTimes(1);
    const payload = writeBytes.mock.calls[0]![1];
    expect([...payload.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('falls back to a literal write for a complete file with malformed UTF-8', async () => {
    const readBytes = vi.fn(async () => Buffer.from([0x61, 0xc2]));
    const writeBytes = vi.fn(async (_path: string, _data: Uint8Array) => {});
    const { tool, writeText } = makeTool({ readBytes, writeBytes });

    const result = await execute(tool, { path: '/tmp/bad-utf8.txt', content: 'x\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/bad-utf8.txt', 'x\n');
    expect(writeBytes).not.toHaveBeenCalled();
    expect(result.output).toContain('Wrote 2 bytes');
  });

  it('falls back to a literal write for a UTF-8 BOM file with malformed UTF-8', async () => {
    const readBytes = vi.fn(async () => Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0xc2]));
    const writeBytes = vi.fn(async (_path: string, _data: Uint8Array) => {});
    const { tool, writeText } = makeTool({ readBytes, writeBytes });

    const result = await execute(tool, { path: '/tmp/bom-bad-utf8.txt', content: 'x\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/bom-bad-utf8.txt', 'x\n');
    expect(writeBytes).not.toHaveBeenCalled();
    expect(result.output).toContain('Wrote 2 bytes');
  });

  it('falls back to a literal write for a complete UTF-16 file with a trailing half unit', async () => {
    const readBytes = vi.fn(async () => Buffer.from([0xff, 0xfe, 0x61, 0x00, 0xd8]));
    const writeBytes = vi.fn(async (_path: string, _data: Uint8Array) => {});
    const { tool, writeText } = makeTool({ readBytes, writeBytes });

    const result = await execute(tool, { path: '/tmp/utf16-odd.txt', content: 'x\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/utf16-odd.txt', 'x\n');
    expect(writeBytes).not.toHaveBeenCalled();
    expect(result.output).toContain('Wrote 2 bytes');
  });

  it('falls back to a literal write for a complete UTF-16 file ending on a lone high surrogate', async () => {
    const readBytes = vi.fn(async () => Buffer.from([0xff, 0xfe, 0x61, 0x00, 0x00, 0xd8]));
    const writeBytes = vi.fn(async (_path: string, _data: Uint8Array) => {});
    const { tool, writeText } = makeTool({ readBytes, writeBytes });

    const result = await execute(tool, { path: '/tmp/utf16-lone-hi.txt', content: 'x\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/utf16-lone-hi.txt', 'x\n');
    expect(writeBytes).not.toHaveBeenCalled();
    expect(result.output).toContain('Wrote 2 bytes');
  });

  it('treats an empty existing file like a new file (no BOM, no EOL rewrite)', async () => {
    const readBytes = vi.fn(async () => new Uint8Array());
    const { tool, writeText } = makeTool({ readBytes });

    const result = await execute(tool, { path: '/tmp/empty-existing.txt', content: 'data\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/empty-existing.txt', 'data\n');
  });

  it('falls back to a plain overwrite when the existing file cannot be sampled', async () => {
    const readBytes = vi.fn(async () => {
      throw Object.assign(new Error('EISDIR: illegal operation on a directory'), {
        code: 'EISDIR',
      });
    });
    const { tool, writeText } = makeTool({ readBytes });

    const result = await execute(tool, { path: '/tmp/unsampled.txt', content: 'data\n' });

    expect(result.isError).toBeFalsy();
    expect(writeText).toHaveBeenCalledWith('/tmp/unsampled.txt', 'data\n');
  });
});

describe('WriteTool new-file conventions', () => {
  function editorConfigFs(configs: Record<string, string>) {
    return {
      readText: vi.fn(async (path: string) => {
        const content = configs[path];
        if (content !== undefined) return content;
        throw enoentError();
      }),
    };
  }

  it('applies end_of_line from the closest .editorconfig to a new file', async () => {
    const { tool, writeText } = makeTool(
      editorConfigFs({ '/tmp/.editorconfig': '[*]\nend_of_line = crlf\n' }),
    );

    const result = await execute(tool, { path: '/tmp/new.txt', content: 'a\nb\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/new.txt', 'a\r\nb\r\n');
    expect(result.output).toContain('Wrote 6 bytes');
  });

  it('writes a UTF-8 BOM for a new file when charset = utf-8-bom', async () => {
    const writeBytes = vi.fn(async (_path: string, _data: Uint8Array) => {});
    const { tool, writeText } = makeTool({
      ...editorConfigFs({ '/tmp/.editorconfig': '[*.{cpp,h}]\ncharset = utf-8-bom\n' }),
      writeBytes,
    });

    const result = await execute(tool, { path: '/tmp/new.h', content: 'int x;\n' });

    expect(writeText).not.toHaveBeenCalled();
    const payload = writeBytes.mock.calls[0]![1];
    expect([...payload.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(Buffer.from(payload.subarray(3)).toString('utf8')).toBe('int x;\n');
    expect(result.output).toContain(`Wrote ${String(payload.length)} bytes`);
  });

  it('leaves a new file as supplied when no .editorconfig section matches it', async () => {
    const { tool, writeText } = makeTool(
      editorConfigFs({ '/tmp/.editorconfig': '[*.py]\nend_of_line = crlf\n' }),
    );

    await execute(tool, { path: '/tmp/new.txt', content: 'a\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/new.txt', 'a\n');
  });

  it('drops a leading U+FEFF for a new file when charset = utf-8', async () => {
    const writeBytes = vi.fn(async (_path: string, _data: Uint8Array) => {});
    const { tool, writeText } = makeTool({
      ...editorConfigFs({ '/tmp/.editorconfig': '[*]\ncharset = utf-8\n' }),
      writeBytes,
    });

    await execute(tool, { path: '/tmp/new.txt', content: '\uFEFFa\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/new.txt', 'a\n');
    expect(writeBytes).not.toHaveBeenCalled();
  });

  it('keeps a leading U+FEFF literally for a new file with no style signal', async () => {
    const writeBytes = vi.fn(async (_path: string, _data: Uint8Array) => {});
    const { tool, writeText } = makeTool({ writeBytes });

    await execute(tool, { path: '/tmp/new.txt', content: '\uFEFFa\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/new.txt', '\uFEFFa\n');
    expect(writeBytes).not.toHaveBeenCalled();
  });

  it('ignores .editorconfig when overwriting an existing file', async () => {
    const readBytes = vi.fn(async () => Buffer.from('old\n', 'utf8'));
    const { tool, writeText } = makeTool({
      ...editorConfigFs({ '/tmp/.editorconfig': '[*]\nend_of_line = crlf\ncharset = utf-8-bom\n' }),
      readBytes,
    });

    await execute(tool, { path: '/tmp/existing.txt', content: 'new\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/existing.txt', 'new\n');
  });

  it('inherits end_of_line from a parent .editorconfig when the target dir has none', async () => {
    const { tool, writeText } = makeTool(editorConfigFs({ '/.editorconfig': '[*]\nend_of_line = crlf\n' }));

    await execute(tool, { path: '/tmp/new.txt', content: 'a\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/new.txt', 'a\r\n');
  });

  it('stops the upward walk at root = true', async () => {
    const { tool, writeText } = makeTool(
      editorConfigFs({
        '/tmp/.editorconfig': 'root = true\n\n[*]\nend_of_line = lf\n',
        '/.editorconfig': '[*]\nend_of_line = crlf\n',
      }),
    );

    await execute(tool, { path: '/tmp/new.txt', content: 'a\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/new.txt', 'a\n');
  });

  it('lets the closest .editorconfig win over a parent declaration', async () => {
    const { tool, writeText } = makeTool(
      editorConfigFs({
        '/tmp/.editorconfig': '[*]\nend_of_line = lf\n',
        '/.editorconfig': '[*]\nend_of_line = crlf\n',
      }),
    );

    await execute(tool, { path: '/tmp/new.txt', content: 'a\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/new.txt', 'a\n');
  });

  it('lets a later matching section override an earlier one in the same file', async () => {
    const { tool, writeText } = makeTool(
      editorConfigFs({
        '/tmp/.editorconfig': '[*]\nend_of_line = crlf\n\n[*.h]\nend_of_line = lf\n',
      }),
    );

    await execute(tool, { path: '/tmp/new.h', content: 'a\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/new.h', 'a\n');
  });

  it('ignores an unsupported value in a later section instead of erasing an earlier valid one', async () => {
    const { tool, writeText } = makeTool(
      editorConfigFs({
        '/tmp/.editorconfig': '[*]\nend_of_line = crlf\n\n[*.ts]\nend_of_line = bogus\n',
      }),
    );

    await execute(tool, { path: '/tmp/a.ts', content: 'x\ny\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/a.ts', 'x\r\ny\r\n');
  });

  it('ignores an unsupported charset in a later section instead of erasing an earlier valid one', async () => {
    const writeBytes = vi.fn(async (_path: string, _data: Uint8Array) => {});
    const { tool, writeText } = makeTool({
      ...editorConfigFs({
        '/tmp/.editorconfig': '[*]\ncharset = utf-8-bom\n\n[*.ts]\ncharset = latin1\n',
      }),
      writeBytes,
    });

    await execute(tool, { path: '/tmp/a.ts', content: 'x\n' });

    expect(writeText).not.toHaveBeenCalled();
    const payload = writeBytes.mock.calls[0]![1];
    expect([...payload.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(Buffer.from(payload.subarray(3)).toString('utf8')).toBe('x\n');
  });

  it('lets unset in a later section clear an earlier value in the same file', async () => {
    const { tool, writeText } = makeTool(
      editorConfigFs({
        '/tmp/.editorconfig': '[*]\nend_of_line = crlf\n\n[*.ts]\nend_of_line = unset\n',
      }),
    );

    await execute(tool, { path: '/tmp/a.ts', content: 'x\ny\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/a.ts', 'x\ny\n');
  });

  it('treats end_of_line = unset in a closer file as no preference', async () => {
    const { tool, writeText } = makeTool(
      editorConfigFs({
        '/tmp/.editorconfig': 'root = true\n\n[*]\nend_of_line = unset\n',
      }),
    );

    await execute(tool, { path: '/tmp/new.txt', content: 'a\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/new.txt', 'a\n');
  });

  it('resolves charset = utf-8 in a closer file to no BOM over a parent utf-8-bom', async () => {
    const writeBytes = vi.fn(async (_path: string, _data: Uint8Array) => {});
    const { tool, writeText } = makeTool({
      ...editorConfigFs({
        '/tmp/.editorconfig': 'root = true\n\n[*]\ncharset = utf-8\n',
        '/.editorconfig': '[*]\ncharset = utf-8-bom\n',
      }),
      writeBytes,
    });

    await execute(tool, { path: '/tmp/new.txt', content: 'a\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/new.txt', 'a\n');
    expect(writeBytes).not.toHaveBeenCalled();
  });

  it('applies end_of_line = cr literally', async () => {
    const { tool, writeText } = makeTool(
      editorConfigFs({ '/tmp/.editorconfig': '[*]\nend_of_line = cr\n' }),
    );

    await execute(tool, { path: '/tmp/new.txt', content: 'a\nb\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/new.txt', 'a\rb\r');
  });

  it('matches a root-anchored section only against the config directory level', async () => {
    const writeBytes = vi.fn(async (_path: string, _data: Uint8Array) => {});
    const { tool, writeText } = makeTool({
      ...editorConfigFs({ '/tmp/.editorconfig': '[/*.txt]\ncharset = utf-8-bom\n' }),
      writeBytes,
    });

    await execute(tool, { path: '/tmp/new.txt', content: 'a\n' });
    await execute(tool, { path: '/tmp/sub/new.txt', content: 'a\n' });

    const bommed = writeBytes.mock.calls.find((call) => call[0] === '/tmp/new.txt');
    expect(bommed).toBeDefined();
    expect([...bommed![1].subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(writeText).toHaveBeenCalledWith('/tmp/sub/new.txt', 'a\n');
  });

  it('lets a parent charset apply when the closer value is unsupported', async () => {
    const writeBytes = vi.fn(async (_path: string, _data: Uint8Array) => {});
    const { tool } = makeTool({
      ...editorConfigFs({
        '/tmp/.editorconfig': '[*]\ncharset = latin1\n',
        '/.editorconfig': '[*]\ncharset = utf-8-bom\n',
      }),
      writeBytes,
    });

    await execute(tool, { path: '/tmp/new.txt', content: 'a\n' });

    const payload = writeBytes.mock.calls[0]![1];
    expect([...payload.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('lets a parent end_of_line apply when the closer value is unsupported', async () => {
    const { tool, writeText } = makeTool(
      editorConfigFs({
        '/tmp/.editorconfig': '[*]\nend_of_line = bogus\n',
        '/.editorconfig': '[*]\nend_of_line = crlf\n',
      }),
    );

    await execute(tool, { path: '/tmp/new.txt', content: 'a\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/new.txt', 'a\r\n');
  });

  it('does not search for .editorconfig above the workspace root', async () => {
    const { tool, writeText } = makeTool(
      editorConfigFs({ '/.editorconfig': '[*]\nend_of_line = crlf\n' }),
      stubWorkspaceContext('/repo'),
    );

    await execute(tool, { path: '/repo/new.txt', content: 'a\n' });

    expect(writeText).toHaveBeenCalledWith('/repo/new.txt', 'a\n');
  });

  it('applies the .editorconfig at the workspace root itself', async () => {
    const { tool, writeText } = makeTool(
      editorConfigFs({ '/repo/.editorconfig': '[*]\nend_of_line = crlf\n' }),
      stubWorkspaceContext('/repo'),
    );

    await execute(tool, { path: '/repo/new.txt', content: 'a\n' });

    expect(writeText).toHaveBeenCalledWith('/repo/new.txt', 'a\r\n');
  });

  it('honors a BOM-prefixed .editorconfig including its root declaration', async () => {
    const writeBytes = vi.fn(async (_path: string, _data: Uint8Array) => {});
    const { tool, writeText } = makeTool({
      ...editorConfigFs({
        '/tmp/.editorconfig': '\uFEFFroot = true\n\n[*]\nend_of_line = crlf\n',
        '/.editorconfig': '[*]\ncharset = utf-8-bom\n',
      }),
      writeBytes,
    });

    await execute(tool, { path: '/tmp/new.txt', content: 'a\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/new.txt', 'a\r\n');
    expect(writeBytes).not.toHaveBeenCalled();
  });

  it('honors a BOM-prefixed .editorconfig whose first line is a section header', async () => {
    const { tool, writeText } = makeTool(
      editorConfigFs({ '/tmp/.editorconfig': '\uFEFF[*]\nend_of_line = crlf\n' }),
    );

    await execute(tool, { path: '/tmp/new.txt', content: 'a\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/new.txt', 'a\r\n');
  });

  it('bounds the walk at the workspace root for ..-prefixed directory names', async () => {
    const { tool, writeText } = makeTool(
      editorConfigFs({ '/ws/.editorconfig': '[*]\nend_of_line = crlf\n' }),
      stubWorkspaceContext('/ws'),
    );

    await execute(tool, { path: '/ws/..cache/new.txt', content: 'a\n' });

    expect(writeText).toHaveBeenCalledWith('/ws/..cache/new.txt', 'a\r\n');
  });

  it('keeps the outer workspace boundary for roots nested under the workspace', async () => {
    const { tool, writeText } = makeTool(
      editorConfigFs({ '/repo/.editorconfig': '[*]\nend_of_line = crlf\n' }),
      stubWorkspaceContext('/repo', ['/repo/.agents/skills/my-skill']),
    );

    await execute(tool, { path: '/repo/.agents/skills/my-skill/new.txt', content: 'a\n' });

    expect(writeText).toHaveBeenCalledWith('/repo/.agents/skills/my-skill/new.txt', 'a\r\n');
  });

  it('writes UTF-16LE with BOM for a new file when charset = utf-16le', async () => {
    const writeBytes = vi.fn(async (_path: string, _data: Uint8Array) => {});
    const { tool, writeText } = makeTool({
      ...editorConfigFs({ '/tmp/.editorconfig': '[*]\ncharset = utf-16le\n' }),
      writeBytes,
    });

    await execute(tool, { path: '/tmp/new.txt', content: 'a\nb\n' });

    expect(writeText).not.toHaveBeenCalled();
    const payload = writeBytes.mock.calls[0]![1];
    expect([...payload.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(Buffer.from(payload.subarray(2)).toString('utf16le')).toBe('a\nb\n');
  });

  it('writes UTF-16BE with BOM for a new file when charset = utf-16be', async () => {
    const writeBytes = vi.fn(async (_path: string, _data: Uint8Array) => {});
    const { tool, writeText } = makeTool({
      ...editorConfigFs({ '/tmp/.editorconfig': '[*]\ncharset = utf-16be\n' }),
      writeBytes,
    });

    await execute(tool, { path: '/tmp/new.txt', content: 'a\n' });

    expect(writeText).not.toHaveBeenCalled();
    const payload = writeBytes.mock.calls[0]![1];
    expect([...payload.subarray(0, 2)]).toEqual([0xfe, 0xff]);
    const body = payload.subarray(2);
    const le = Buffer.alloc(body.length);
    for (let i = 0; i + 1 < body.length; i += 2) {
      le[i] = body[i + 1]!;
      le[i + 1] = body[i]!;
    }
    expect(le.toString('utf16le')).toBe('a\n');
  });
});

describe('WriteTool sibling-style fallback', () => {
  function siblingFs(files: Record<string, Uint8Array>, targetPath: string, dir = '/tmp') {
    return {
      readdir: vi.fn(async (path: string) => {
        if (path !== dir) return [];
        return Object.keys(files).map((full) => ({
          name: full.slice(dir.length + 1),
          isFile: true,
          isDirectory: false,
        }));
      }),
      readBytes: vi.fn(async (path: string) => {
        if (path === targetPath) throw enoentError();
        const data = files[path];
        if (data !== undefined) return data;
        throw enoentError();
      }),
    };
  }

  it('inherits the dominant sibling line ending for a new file', async () => {
    const { tool, writeText } = makeTool(
      siblingFs(
        {
          '/tmp/a.txt': Buffer.from('x\r\ny\r\n', 'utf8'),
          '/tmp/b.txt': Buffer.from('x\r\n', 'utf8'),
          '/tmp/c.txt': Buffer.from('x\n', 'utf8'),
        },
        '/tmp/d.txt',
      ),
    );

    await execute(tool, { path: '/tmp/d.txt', content: 'x\ny\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/d.txt', 'x\r\ny\r\n');
  });

  it('inherits a dominant CR-only sibling line ending for a new file', async () => {
    const { tool, writeText } = makeTool(
      siblingFs(
        {
          '/tmp/a.txt': Buffer.from('x\ry\r', 'utf8'),
          '/tmp/b.txt': Buffer.from('x\r', 'utf8'),
          '/tmp/c.txt': Buffer.from('x\n', 'utf8'),
        },
        '/tmp/d.txt',
      ),
    );

    await execute(tool, { path: '/tmp/d.txt', content: 'x\ny\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/d.txt', 'x\ry\r');
  });

  it('inherits a BOM only from same-extension siblings', async () => {
    const writeBytes = vi.fn(async (_path: string, _data: Uint8Array) => {});
    const { tool, writeText } = makeTool({
      ...siblingFs(
        {
          '/tmp/a.h': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\n', 'utf8')]),
          '/tmp/b.h': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('b\n', 'utf8')]),
          '/tmp/c.h': Buffer.from('c\n', 'utf8'),
        },
        '/tmp/d.h',
      ),
      writeBytes,
    });

    await execute(tool, { path: '/tmp/d.h', content: 'int x;\n' });

    expect(writeText).not.toHaveBeenCalled();
    const payload = writeBytes.mock.calls[0]![1];
    expect([...payload.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('never inherits a BOM across file extensions', async () => {
    const { tool, writeText, writeBytes } = makeTool(
      siblingFs(
        {
          '/tmp/a.cpp': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\n', 'utf8')]),
          '/tmp/b.cpp': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('b\n', 'utf8')]),
        },
        '/tmp/n.py',
      ),
    );

    await execute(tool, { path: '/tmp/n.py', content: 'print(1)\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/n.py', 'print(1)\n');
    expect(writeBytes).not.toHaveBeenCalled();
  });

  it('drops a leading U+FEFF when same-extension siblings are BOM-less', async () => {
    const writeBytes = vi.fn(async (_path: string, _data: Uint8Array) => {});
    const { tool, writeText } = makeTool({
      ...siblingFs(
        {
          '/tmp/a.h': Buffer.from('a\n', 'utf8'),
          '/tmp/b.h': Buffer.from('b\n', 'utf8'),
        },
        '/tmp/d.h',
      ),
      writeBytes,
    });

    await execute(tool, { path: '/tmp/d.h', content: '\uFEFFint x;\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/d.h', 'int x;\n');
    expect(writeBytes).not.toHaveBeenCalled();
  });

  it('does not inherit line endings across file extensions', async () => {
    const { tool, writeText } = makeTool(
      siblingFs(
        {
          '/tmp/a.cpp': Buffer.from('x\r\n', 'utf8'),
          '/tmp/b.cpp': Buffer.from('y\r\n', 'utf8'),
        },
        '/tmp/n.md',
      ),
    );

    await execute(tool, { path: '/tmp/n.md', content: 'heading\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/n.md', 'heading\n');
  });

  it('keeps supplied line endings when siblings are tied', async () => {
    const { tool, writeText } = makeTool(
      siblingFs(
        {
          '/tmp/a.txt': Buffer.from('x\r\n', 'utf8'),
          '/tmp/b.txt': Buffer.from('x\n', 'utf8'),
        },
        '/tmp/c.txt',
      ),
    );

    await execute(tool, { path: '/tmp/c.txt', content: 'x\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/c.txt', 'x\n');
  });

  it('prefers .editorconfig declarations over sibling style', async () => {
    const readText = vi.fn(async (path: string) => {
      if (path === '/tmp/.editorconfig') return '[*]\nend_of_line = crlf\ncharset = utf-8\n';
      throw enoentError();
    });
    const { tool, writeText } = makeTool({
      readText,
      ...siblingFs({ '/tmp/a.txt': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('x\n', 'utf8')]) }, '/tmp/b.txt'),
    });

    await execute(tool, { path: '/tmp/b.txt', content: 'x\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/b.txt', 'x\r\n');
  });

  it('skips binary siblings when sampling style', async () => {
    const { tool, writeText } = makeTool(
      siblingFs({ '/tmp/a.txt': Buffer.from([0x00, 0x0a, 0x0a, 0x00]) }, '/tmp/b.txt'),
    );

    await execute(tool, { path: '/tmp/b.txt', content: 'x\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/b.txt', 'x\n');
  });

  it('writes UTF-16LE when same-extension siblings are predominantly UTF-16LE', async () => {
    const writeBytes = vi.fn(async (_path: string, _data: Uint8Array) => {});
    const { tool, writeText } = makeTool({
      ...siblingFs(
        {
          '/tmp/a.txt': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('x\r\n', 'utf16le')]),
          '/tmp/b.txt': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('y\r\n', 'utf16le')]),
          '/tmp/c.txt': Buffer.from('z\n', 'utf8'),
        },
        '/tmp/d.txt',
      ),
      writeBytes,
    });

    await execute(tool, { path: '/tmp/d.txt', content: 'x\ny\n' });

    expect(writeText).not.toHaveBeenCalled();
    const payload = writeBytes.mock.calls[0]![1];
    expect([...payload.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(Buffer.from(payload.subarray(2)).toString('utf16le')).toBe('x\r\ny\r\n');
  });

  it('reads BOM-less UTF-16 sibling line endings with the detected encoding', async () => {
    const { tool, writeText } = makeTool(
      siblingFs(
        {
          '/tmp/a.txt': Buffer.from('x\r\ny\r\n', 'utf16le'),
          '/tmp/b.txt': Buffer.from('z\r\n', 'utf16le'),
        },
        '/tmp/d.txt',
      ),
    );

    await execute(tool, { path: '/tmp/d.txt', content: 'x\ny\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/d.txt', 'x\r\ny\r\n');
  });

  it('skips UTF-32 siblings instead of inheriting a false UTF-16 style', async () => {
    const writeBytes = vi.fn(async (_path: string, _data: Uint8Array) => {});
    const { tool, writeText } = makeTool({
      ...siblingFs(
        {
          '/tmp/a.txt': Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x78, 0x00, 0x00, 0x00]),
        },
        '/tmp/d.txt',
      ),
      writeBytes,
    });

    await execute(tool, { path: '/tmp/d.txt', content: 'x\n' });

    expect(writeText).toHaveBeenCalledWith('/tmp/d.txt', 'x\n');
    expect(writeBytes).not.toHaveBeenCalled();
  });
});

describe('WriteTool append conventions', () => {
  function editorConfigFs(configs: Record<string, string>) {
    return {
      readText: vi.fn(async (path: string) => {
        const content = configs[path];
        if (content !== undefined) return content;
        throw enoentError();
      }),
    };
  }

  it('applies new-file conventions when append creates the file', async () => {
    const createExclusive = vi.fn(async (_path: string, _data: Uint8Array) => true);
    const { tool, appendText, writeText, writeBytes } = makeTool({
      ...editorConfigFs({ '/tmp/.editorconfig': '[*]\nend_of_line = crlf\ncharset = utf-8-bom\n' }),
      createExclusive,
      stat: vi.fn(async () => {
        throw enoentError();
      }),
    });

    const result = await execute(tool, { path: '/tmp/new.txt', content: 'a\nb\n', mode: 'append' });

    expect(appendText).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    expect(writeBytes).not.toHaveBeenCalled();
    const payload = createExclusive.mock.calls[0]![1];
    expect([...payload.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(Buffer.from(payload.subarray(3)).toString('utf8')).toBe('a\r\nb\r\n');
    expect(result.output).toContain(`Appended ${String(payload.length)} bytes`);
  });

  it('writes a plain new file when append creates it without any signal', async () => {
    const createExclusive = vi.fn(async (_path: string, _data: Uint8Array) => true);
    const { tool, writeText } = makeTool({
      createExclusive,
      stat: vi.fn(async () => {
        throw enoentError();
      }),
    });

    const result = await execute(tool, { path: '/tmp/new.txt', content: 'a\n', mode: 'append' });

    expect(writeText).not.toHaveBeenCalled();
    expect(createExclusive).toHaveBeenCalledWith(
      '/tmp/new.txt',
      Buffer.from('a\n', 'utf8'),
    );
    expect(result.output).toContain('Appended 2 bytes');
  });

  it('appends literally when an exclusive create loses the race to another writer', async () => {
    const createExclusive = vi.fn(async (_path: string, _data: Uint8Array) => false);
    const { tool, appendText, writeText } = makeTool({
      ...editorConfigFs({ '/tmp/.editorconfig': '[*]\nend_of_line = crlf\ncharset = utf-8-bom\n' }),
      createExclusive,
      stat: vi.fn(async () => {
        throw enoentError();
      }),
    });

    const result = await execute(tool, { path: '/tmp/new.txt', content: 'a\n', mode: 'append' });

    expect(createExclusive).toHaveBeenCalledTimes(1);
    expect(appendText).toHaveBeenCalledWith('/tmp/new.txt', 'a\n');
    expect(writeText).not.toHaveBeenCalled();
    expect(result.output).toContain('Appended 2 bytes');
  });

  it('appends literally to an existing file regardless of .editorconfig', async () => {
    const { tool, appendText, writeBytes } = makeTool({
      ...editorConfigFs({ '/tmp/.editorconfig': '[*]\nend_of_line = crlf\n' }),
      stat: vi.fn(async (path: string) =>
        path === '/tmp/existing.txt'
          ? { isFile: true, isDirectory: false, size: 10 }
          : { isFile: false, isDirectory: true, size: 0 },
      ),
    });

    await execute(tool, { path: '/tmp/existing.txt', content: 'x\n', mode: 'append' });

    expect(appendText).toHaveBeenCalledWith('/tmp/existing.txt', 'x\n');
    expect(writeBytes).not.toHaveBeenCalled();
  });
});

describe('resolveNewFileEditorStyle', () => {
  it('stops the walk at a backslash-form workspace root', async () => {
    const readText = vi.fn(async (path: string) => {
      if (path === 'D:/.editorconfig') return '[*]\nend_of_line = crlf\n';
      throw enoentError();
    });

    const style = await resolveNewFileEditorStyle(
      { readText } as unknown as IHostFileSystem,
      'D:/repo/sub/new.h',
      'D:\\repo',
    );

    expect(style).toEqual({ eol: undefined, bom: undefined });
    expect(readText).toHaveBeenCalledWith('D:/repo/sub/.editorconfig');
    expect(readText).toHaveBeenCalledWith('D:/repo/.editorconfig');
    expect(readText).not.toHaveBeenCalledWith('D:/.editorconfig');
  });
});
