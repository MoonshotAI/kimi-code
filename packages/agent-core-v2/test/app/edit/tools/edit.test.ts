import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as posixPath from 'node:path/posix';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PathSecurityError } from '#/tool/path-access';
import { stubWorkspaceContext } from '../../../session/workspaceContext/stub-workspace-context';
import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { type EditInput, EditInputSchema } from '#/agent/tools/edit/edit';
import { EditTool } from '#/agent/tools/edit/editTool';
import { IFileEditService } from '#/app/edit/fileEdit';
import { FileEditService } from '#/app/edit/fileEditService';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { HostFsError, OsFsErrors } from '#/os/interface/hostFsErrors';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import type { Runtime } from '#/runtime/runtime';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '#/tool/toolContract';

const signal = new AbortController().signal;
const PERMISSIVE_WORKSPACE = stubWorkspaceContext('/');

let disposables: DisposableStore;

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

function createSpiedEditFs(
  options: {
    readText?: ReturnType<typeof vi.fn>;
    writeText?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const readText = options.readText ?? vi.fn(async () => '');
  const writeText = options.writeText ?? vi.fn(async () => undefined);
  const stat = vi.fn(async () => ({ isFile: true, isDirectory: false, size: 0 }));
  const fs = { readText, writeText, stat } as unknown as IHostFileSystem;
  return { fs, readText, writeText };
}

function buildTool(
  fs: IHostFileSystem,
  env: IHostEnvironment,
  workspace: ISessionWorkspaceContext,
  appFs: IHostFileSystem = fs,
): EditTool {
  const ix = createServices(disposables, {
    additionalServices: (reg) => {
      reg.defineInstance(IHostFileSystem, appFs);
      reg.defineInstance(IHostEnvironment, env);
      reg.defineInstance(ISessionWorkspaceContext, workspace);
      reg.define(IFileEditService, FileEditService);
    },
  });
  const runtimeValue = {
    identity: { workspaceId: 'workspace', runtimeId: 'local', generation: 'test' },
    capabilities: new Set(['fs'] as const),
    environment: env,
    path: posixPath,
    workspace: { mapRoots: (roots: { workDir: string; additionalDirs?: readonly string[] }) => roots },
    fs,
    status: 'ready',
    onDidChangeStatus: () => ({ dispose: () => {} }),
    dispose: () => {},
  } as unknown as Runtime;
  const runtime: IAgentRuntimeService = {
    _serviceBrand: undefined,
    onDidChange: () => ({ dispose: () => {} }),
    isAvailable: () => true,
    inspect: () => runtimeValue,
    acquire: () => ({
      runtime: runtimeValue,
      track: (resource) => resource,
      dispose: () => {},
    }),
  };
  return new EditTool(ix.get(IFileEditService), runtime, workspace);
}

function isPromiseLike(
  value: ToolExecution | Promise<ToolExecution>,
): value is Promise<ToolExecution> {
  return typeof (value as Promise<ToolExecution>).then === 'function';
}

async function execute(tool: EditTool, args: EditInput): Promise<ExecutableToolResult> {
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
    toolCallId: 'call_edit',
    signal,
  };
  return execution.execute(ctx);
}

describe('EditTool', () => {
  beforeEach(() => {
    disposables = new DisposableStore();
  });
  afterEach(() => {
    disposables.dispose();
  });

  it('exposes before/after on the file_io display so the approval panel can render a diff', () => {
    const tool = buildTool(createSpiedEditFs().fs, createTestEnv(), PERMISSIVE_WORKSPACE);
    const execution = tool.resolveExecution({
      path: '/tmp/foo.ts',
      old_string: 'a\nb\nc',
      new_string: 'a\nB\nc',
    });
    if (execution.isError === true) {
      throw new TypeError('expected runnable execution');
    }
    expect(execution.display).toEqual({
      kind: 'file_io',
      operation: 'edit',
      path: '/tmp/foo.ts',
      before: 'a\nb\nc',
      after: 'a\nB\nc',
    });
  });

  it('declares readWriteFile access for the edited path', () => {
    const tool = buildTool(createSpiedEditFs().fs, createTestEnv(), PERMISSIVE_WORKSPACE);
    const execution = tool.resolveExecution({
      path: '/tmp/foo.ts',
      old_string: 'a',
      new_string: 'b',
    });
    if (execution.isError === true) {
      throw new TypeError('expected runnable execution');
    }
    expect(execution.accesses).toEqual([
      { kind: 'file', operation: 'readwrite', path: '/tmp/foo.ts' },
    ]);
  });

  it('exposes current metadata and schema', () => {
    const tool = buildTool(createSpiedEditFs().fs, createTestEnv(), PERMISSIVE_WORKSPACE);

    expect(tool.name).toBe('Edit');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
      },
    });
    expect(
      EditInputSchema.safeParse({
        path: '/tmp/a.txt',
        old_string: 'old',
        new_string: 'new',
      }).success,
    ).toBe(true);
    expect(
      EditInputSchema.safeParse({
        path: '/tmp/a.txt',
        old_string: '',
        new_string: 'new',
      }).success,
    ).toBe(false);
  });

  it('replaces a unique first occurrence and writes the updated content', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const { fs } = createSpiedEditFs({
      readText: vi.fn().mockResolvedValue('alpha beta'),
      writeText,
    });
    const tool = buildTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE);

    const result = await execute(tool, {
      path: '/tmp/a.txt',
      old_string: 'beta',
      new_string: 'gamma',
    });

    expect(result.output).toContain('Replaced 1 occurrence');
    expect(writeText).toHaveBeenCalledWith('/tmp/a.txt', 'alpha gamma');
  });

  it('executes against the selected runtime filesystem instead of the App filesystem', async () => {
    const runtimeWrite = vi.fn().mockResolvedValue(undefined);
    const { fs: runtimeFs } = createSpiedEditFs({
      readText: vi.fn().mockResolvedValue('runtime content'),
      writeText: runtimeWrite,
    });
    const appRead = vi.fn().mockRejectedValue(new Error('App filesystem bypass'));
    const appWrite = vi.fn().mockRejectedValue(new Error('App filesystem bypass'));
    const { fs: appFs } = createSpiedEditFs({ readText: appRead, writeText: appWrite });
    const tool = buildTool(runtimeFs, createTestEnv(), PERMISSIVE_WORKSPACE, appFs);

    const result = await execute(tool, {
      path: '/tmp/a.txt',
      old_string: 'content',
      new_string: 'generation',
    });

    expect(result.output).toContain('Replaced 1 occurrence');
    expect(runtimeWrite).toHaveBeenCalledWith('/tmp/a.txt', 'runtime generation');
    expect(appRead).not.toHaveBeenCalled();
    expect(appWrite).not.toHaveBeenCalled();
  });

  it('expands leading tilde paths using the kaos home directory', async () => {
    const readText = vi.fn().mockResolvedValue('alpha beta');
    const writeText = vi.fn().mockResolvedValue(undefined);
    const { fs } = createSpiedEditFs({ readText, writeText });
    const tool = buildTool(fs, createTestEnv('/home/test'), PERMISSIVE_WORKSPACE);

    const result = await execute(tool, {
      path: '~/notes/today.txt',
      old_string: 'beta',
      new_string: 'gamma',
    });

    expect(result.output).toContain('Replaced 1 occurrence');
    expect(readText).toHaveBeenCalledWith('/home/test/notes/today.txt', { errors: 'strict' });
    expect(writeText).toHaveBeenCalledWith('/home/test/notes/today.txt', 'alpha gamma');
  });

  it('treats replacement dollar sequences literally for single edits', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const { fs } = createSpiedEditFs({
      readText: vi.fn().mockResolvedValue('alpha beta gamma'),
      writeText,
    });
    const tool = buildTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE);

    const result = await execute(tool, {
      path: '/tmp/a.txt',
      old_string: 'beta',
      new_string: "$& $$ $` $'",
    });

    expect(result.output).toContain('Replaced 1 occurrence');
    expect(writeText).toHaveBeenCalledWith('/tmp/a.txt', "alpha $& $$ $` $' gamma");
  });

  it('treats replacement dollar sequences literally for replace_all edits', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const { fs } = createSpiedEditFs({
      readText: vi.fn().mockResolvedValue('a b a'),
      writeText,
    });
    const tool = buildTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE);

    const result = await execute(tool, {
      path: '/tmp/a.txt',
      old_string: 'a',
      new_string: '$&',
      replace_all: true,
    });

    expect(result.output).toContain('Replaced 2 occurrences');
    expect(writeText).toHaveBeenCalledWith('/tmp/a.txt', '$& b $&');
  });

  it('matches pure CRLF files through the LF model view and writes back CRLF', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const { fs } = createSpiedEditFs({
      readText: vi.fn().mockResolvedValue('alpha\r\nbeta\r\ngamma\r\n'),
      writeText,
    });
    const tool = buildTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE);

    const result = await execute(tool, {
      path: '/tmp/a.txt',
      old_string: 'alpha\nbeta',
      new_string: 'one\ntwo',
    });

    expect(result.output).toContain('Replaced 1 occurrence');
    expect(writeText).toHaveBeenCalledWith('/tmp/a.txt', 'one\r\ntwo\r\ngamma\r\n');
  });

  it('does not double carriage returns when editing pure CRLF files', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const { fs } = createSpiedEditFs({
      readText: vi.fn().mockResolvedValue('alpha\r\nbeta\r\n'),
      writeText,
    });
    const tool = buildTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE);

    const result = await execute(tool, {
      path: '/tmp/a.txt',
      old_string: 'alpha\nbeta',
      new_string: 'one\r\ntwo',
    });

    expect(result.output).toContain('Replaced 1 occurrence');
    expect(writeText).toHaveBeenCalledWith('/tmp/a.txt', 'one\r\ntwo\r\n');
  });

  it('keeps mixed line ending files on the raw exact path', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const { fs } = createSpiedEditFs({
      readText: vi.fn().mockResolvedValue('alpha\r\nbeta\ngamma\r\n'),
      writeText,
    });
    const tool = buildTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE);

    const result = await execute(tool, {
      path: '/tmp/a.txt',
      old_string: 'alpha\nbeta',
      new_string: 'one\ntwo',
    });

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('old_string not found');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('allows exact raw edits in mixed line ending files without normalizing the rest', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const { fs } = createSpiedEditFs({
      readText: vi.fn().mockResolvedValue('alpha\r\nbeta\ngamma\r\n'),
      writeText,
    });
    const tool = buildTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE);

    const result = await execute(tool, {
      path: '/tmp/a.txt',
      old_string: 'alpha\r\nbeta',
      new_string: 'one\r\ntwo',
    });

    expect(result.output).toContain('Replaced 1 occurrence');
    expect(writeText).toHaveBeenCalledWith('/tmp/a.txt', 'one\r\ntwo\ngamma\r\n');
  });

  it('replace_all replaces every occurrence', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const { fs } = createSpiedEditFs({
      readText: vi.fn().mockResolvedValue('a b a'),
      writeText,
    });
    const tool = buildTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE);

    const result = await execute(tool, {
      path: '/tmp/a.txt',
      old_string: 'a',
      new_string: 'x',
      replace_all: true,
    });

    expect(result.output).toContain('Replaced 2 occurrences');
    expect(writeText).toHaveBeenCalledWith('/tmp/a.txt', 'x b x');
  });

  it('rejects no-op edits before file I/O', async () => {
    const readText = vi.fn().mockResolvedValue('same');
    const writeText = vi.fn().mockResolvedValue(undefined);
    const { fs } = createSpiedEditFs({ readText, writeText });
    const tool = buildTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE);

    const result = await execute(tool, {
      path: '/tmp/a.txt',
      old_string: 'same',
      new_string: 'same',
      replace_all: true,
    });

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('No changes to make');
    expect(readText).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('errors when old_string is missing', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const { fs } = createSpiedEditFs({
      readText: vi.fn().mockResolvedValue('alpha beta'),
      writeText,
    });
    const tool = buildTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE);

    const result = await execute(tool, {
      path: '/tmp/a.txt',
      old_string: 'delta',
      new_string: 'gamma',
    });

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('old_string not found');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('errors when old_string is not unique and replace_all is false', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const { fs } = createSpiedEditFs({
      readText: vi.fn().mockResolvedValue('same same'),
      writeText,
    });
    const tool = buildTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE);

    const result = await execute(tool, {
      path: '/tmp/a.txt',
      old_string: 'same',
      new_string: 'other',
    });

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('not unique');
    expect(result.output).toContain('set replace_all=true');
    expect(result.output).toContain('include more surrounding context');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('rejects relative traversal edits before reading', async () => {
    const readText = vi.fn().mockResolvedValue('secret');
    const { fs } = createSpiedEditFs({ readText });
    const tool = buildTool(fs, createTestEnv(), stubWorkspaceContext('/workspace/project'));

    const result = await execute(tool, {
      path: '../outside.txt',
      old_string: 'secret',
      new_string: 'x',
    });

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('absolute path');
    expect(readText).not.toHaveBeenCalled();
  });

  it('replaces unicode strings (CJK) and round-trips the surrounding text', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const { fs } = createSpiedEditFs({
      readText: vi.fn().mockResolvedValue('Hello 世界! café'),
      writeText,
    });
    const tool = buildTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE);

    const result = await execute(tool, {
      path: '/tmp/u.txt',
      old_string: '世界',
      new_string: '地球',
    });

    expect(result.output).toContain('Replaced 1 occurrence');
    expect(writeText).toHaveBeenCalledWith('/tmp/u.txt', 'Hello 地球! café');
  });

  it('leaves the file byte-identical when old_string is not present', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const original = 'Hello world!';
    const { fs } = createSpiedEditFs({
      readText: vi.fn().mockResolvedValue(original),
      writeText,
    });
    const tool = buildTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE);

    const result = await execute(tool, {
      path: '/tmp/n.txt',
      old_string: 'notfound',
      new_string: 'replacement',
    });

    expect(result.isError).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('errors with an is-not-a-file phrasing when the path resolves to a directory', async () => {
    const { fs } = createSpiedEditFs({
      readText: vi.fn().mockRejectedValue(
        Object.assign(new Error('EISDIR: illegal operation on a directory'), {
          code: 'EISDIR',
        }),
      ),
    });
    const tool = buildTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE);

    const result = await execute(tool, {
      path: '/tmp/dir',
      old_string: 'old',
      new_string: 'new',
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('is not a file');
  });

  it('maps a HostFsError-wrapped EISDIR to the is-not-a-file phrasing', async () => {
    const { fs } = createSpiedEditFs({
      readText: vi.fn().mockRejectedValue(
        new HostFsError(OsFsErrors.codes.OS_FS_IS_DIRECTORY, 'read failed: path is a directory', {
          details: { path: '/tmp/dir', op: 'read', errno: 'EISDIR' },
          cause: Object.assign(new Error('EISDIR: illegal operation on a directory'), {
            code: 'EISDIR',
          }),
        }),
      ),
    });
    const tool = buildTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE);

    const result = await execute(tool, {
      path: '/tmp/dir',
      old_string: 'old',
      new_string: 'new',
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('is not a file');
  });

  it('replaces a substring with an empty new_string (deletion)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const { fs } = createSpiedEditFs({
      readText: vi.fn().mockResolvedValue('Hello world!'),
      writeText,
    });
    const tool = buildTool(fs, createTestEnv(), PERMISSIVE_WORKSPACE);

    const result = await execute(tool, {
      path: '/tmp/e.txt',
      old_string: 'world',
      new_string: '',
    });

    expect(result.output).toContain('Replaced 1 occurrence');
    expect(writeText).toHaveBeenCalledWith('/tmp/e.txt', 'Hello !');
  });

  it('allows absolute edits outside the workspace under default policy', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const { fs } = createSpiedEditFs({
      readText: vi.fn().mockResolvedValue('old content'),
      writeText,
    });
    const tool = buildTool(fs, createTestEnv(), stubWorkspaceContext('/workspace'));

    const result = await execute(tool, {
      path: '/tmp/outside.txt',
      old_string: 'old',
      new_string: 'new',
    });

    expect(result.isError).toBeFalsy();
    expect(writeText).toHaveBeenCalledWith('/tmp/outside.txt', 'new content');
  });

  it('allows absolute edits to a sibling dir that merely shares the work-dir prefix', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const { fs } = createSpiedEditFs({
      readText: vi.fn().mockResolvedValue('content'),
      writeText,
    });
    const tool = buildTool(fs, createTestEnv(), stubWorkspaceContext('/workspace'));

    const result = await execute(tool, {
      path: '/workspace-sneaky/test.txt',
      old_string: 'content',
      new_string: 'new',
    });

    expect(result.isError).toBeFalsy();
    expect(writeText).toHaveBeenCalledWith('/workspace-sneaky/test.txt', 'new');
  });

  it('rejects editing a non-UTF-8 file and leaves its bytes untouched', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'edit-strict-'));
    const file = join(dir, 'sample.txt');
    const original = Buffer.from([0x68, 0x69, 0x20, 0xff, 0x0a, 0x66, 0x6f, 0x6f]);
    await writeFile(file, original);
    try {
      const service = new FileEditService(new HostFileSystem());
      const result = await service.edit({
        path: file,
        displayPath: file,
        old_string: 'foo',
        new_string: 'bar',
        replace_all: false,
      });

      expect(result.ok).toBe(false);
      const after = await readFile(file);
      expect(Buffer.compare(after, original)).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
