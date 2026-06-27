import { describe, expect, it, vi } from 'vitest';

import { type WriteInput, WriteInputSchema, WriteTool } from '../../src/tools/builtin/file/write';
import { createFakeKaos, PERMISSIVE_WORKSPACE, toolContentString } from './fixtures/fake-kaos';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;

function context(args: WriteInput) {
  return { turnId: '0', toolCallId: 'call_write', args, signal };
}

/** stat() result for an existing directory (S_IFDIR mode bits). */
const DIR_STAT = vi.fn().mockResolvedValue({ stMode: 0o040755 });

describe('WriteTool', () => {
  it('exposes current metadata and schema', () => {
    const tool = new WriteTool(createFakeKaos(), PERMISSIVE_WORKSPACE);

    expect(tool.name).toBe('Write');
    expect(tool.description).toContain('append adds content at EOF without adding a newline');
    expect(tool.description).toContain('\\n stays LF, \\r\\n stays CRLF');
    // The prompt steers the agent toward Edit for partial changes to an
    // existing file. Pin the prohibition so accidental weakening is caught.
    expect(tool.description).toContain('Write is NOT ALLOWED for incremental changes');
    // Spontaneous doc/README creation is a known anti-pattern; pin the guard.
    expect(tool.description).toContain('documentation files');
    expect(tool.description).toContain('README');
    // ...but the plan-mode plan file is a `.md` the model is told to Write, so the
    // ban must carve it out (plan/index.ts writes plans/<id>.md via Write).
    expect(tool.description.toLowerCase()).toContain('plan-mode plan file');
    // The guard targets UNSOLICITED docs, not every .md file, so an artifact a task or
    // project instruction requires (e.g. a repo-mandated changeset) is not caught either.
    expect(tool.description.toLowerCase()).toContain('unsolicited');
    expect(tool.description.toLowerCase()).toContain('instruction requires it');
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
    const tool = new WriteTool(createFakeKaos(), PERMISSIVE_WORKSPACE);
    const params = tool.parameters as {
      properties: { path: { description: string } };
    };

    expect(params.properties.path.description).toContain('working directory');
    expect(params.properties.path.description).toMatch(/relative/i);
    expect(params.properties.path.description).toMatch(/absolute/i);
  });

  it('exposes the content on the file_io display so the approval panel can preview it', () => {
    const tool = new WriteTool(createFakeKaos(), PERMISSIVE_WORKSPACE);
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
    const tool = new WriteTool(createFakeKaos(), {
      workspaceDir: '/workspace',
      additionalDirs: [],
    });
    const insideSrc = tool.resolveExecution({ path: './src/a.ts', content: 'x' });
    const outsideSrc = tool.resolveExecution({ path: './README.md', content: 'x' });
    if (insideSrc.isError === true || outsideSrc.isError === true) {
      throw new TypeError('expected runnable execution');
    }

    expect(insideSrc.matchesRule?.('!./src/**')).toBe(false);
    expect(outsideSrc.matchesRule?.('!./src/**')).toBe(true);
  });

  it('guides batching large content across multiple write calls', () => {
    const tool = new WriteTool(createFakeKaos(), PERMISSIVE_WORKSPACE);

    // The guidance must mention that a file too large for one call should be
    // chunked, and spell out the first-overwrite-then-append ordering.
    expect(tool.description).toMatch(/large/i);
    expect(tool.description).toContain('content too large for one call');
    expect(tool.description).toMatch(/overwrite[^.]*first chunk[^.]*then[^.]*append/i);
  });

  it('writes content through kaos and reports bytes written', async () => {
    const writeText = vi.fn().mockResolvedValue(5);
    const tool = new WriteTool(createFakeKaos({ writeText, stat: DIR_STAT }), PERMISSIVE_WORKSPACE);

    const result = await executeTool(tool, context({ path: '/tmp/new.txt', content: 'hello' }));

    expect(writeText).toHaveBeenCalledWith('/tmp/new.txt', 'hello');
    expect(result.output).toContain('Wrote 5 bytes');
  });

  it('expands leading tilde paths using the kaos home directory', async () => {
    const writeText = vi.fn().mockResolvedValue(5);
    const tool = new WriteTool(createFakeKaos({ writeText, stat: DIR_STAT }), PERMISSIVE_WORKSPACE);

    const result = await executeTool(tool, context({ path: '~/notes/today.txt', content: 'hello' }));

    expect(writeText).toHaveBeenCalledWith('/home/test/notes/today.txt', 'hello');
    expect(result.output).toContain('Wrote 5 bytes');
  });

  it('appends content through kaos and reports appended bytes', async () => {
    const writeText = vi.fn().mockResolvedValue(6);
    const tool = new WriteTool(createFakeKaos({ writeText, stat: DIR_STAT }), PERMISSIVE_WORKSPACE);

    const result = await executeTool(tool,
      context({ path: '/tmp/existing.txt', content: '\nhello', mode: 'append' }),
    );

    expect(writeText).toHaveBeenCalledWith('/tmp/existing.txt', '\nhello', { mode: 'a' });
    expect(result.output).toContain('Appended 6 bytes');
  });

  it('reports the real UTF-8 byte count for non-ASCII content', async () => {
    // Six Japanese characters: each encodes to 3 UTF-8 bytes → 18 bytes total,
    // even though the JS string length is 6. The reported count must reflect
    // the bytes that land on disk, not the code-unit count.
    const content = 'こんにちは。';
    const expectedBytes = Buffer.byteLength(content, 'utf8');
    expect(expectedBytes).toBe(18);

    // writeText's contract returns a character count; the tool must not rely
    // on it for the byte figure.
    const writeText = vi.fn().mockResolvedValue(content.length);
    const tool = new WriteTool(createFakeKaos({ writeText, stat: DIR_STAT }), PERMISSIVE_WORKSPACE);

    const result = await executeTool(tool, context({ path: '/tmp/jp.txt', content }));

    expect(result.output).toContain('Wrote 18 bytes');
    expect(result.output).not.toContain('Wrote 6 bytes');
  });

  it('reports the real UTF-8 byte count for content with surrogate-pair emoji', async () => {
    // 'hi😀': the emoji is a single code point encoded as a UTF-16 surrogate
    // pair, so JS string length is 4 (2 for 'hi' + 2 code units), but the
    // UTF-8 encoding is 6 bytes (2 for 'hi' + 4 for the emoji). The reported
    // count must reflect the bytes on disk, not the code-unit count — this
    // is the sharpest edge of the byte-counting bug.
    const content = 'hi😀';
    expect(content.length).toBe(4);
    const expectedBytes = Buffer.byteLength(content, 'utf8');
    expect(expectedBytes).toBe(6);

    // writeText's contract returns a character count; the tool must not rely
    // on it for the byte figure.
    const writeText = vi.fn().mockResolvedValue(content.length);
    const tool = new WriteTool(createFakeKaos({ writeText, stat: DIR_STAT }), PERMISSIVE_WORKSPACE);

    const result = await executeTool(tool, context({ path: '/tmp/emoji.txt', content }));

    expect(result.output).toContain('Wrote 6 bytes');
    expect(result.output).not.toContain('Wrote 4 bytes');
  });

  it('reports the real UTF-8 byte count for non-ASCII append content', async () => {
    const content = 'café';
    const expectedBytes = Buffer.byteLength(content, 'utf8');
    expect(expectedBytes).toBe(5);

    const writeText = vi.fn().mockResolvedValue(content.length);
    const tool = new WriteTool(createFakeKaos({ writeText, stat: DIR_STAT }), PERMISSIVE_WORKSPACE);

    const result = await executeTool(tool,
      context({ path: '/tmp/menu.txt', content, mode: 'append' }),
    );

    expect(result.output).toContain('Appended 5 bytes');
  });

  it('creates missing parent directories automatically before writing', async () => {
    const enoent = Object.assign(new Error('ENOENT: no such file or directory'), {
      code: 'ENOENT',
    });
    const stat = vi.fn().mockRejectedValue(enoent);
    const mkdir = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn().mockResolvedValue(4);
    const tool = new WriteTool(createFakeKaos({ stat, mkdir, writeText }), PERMISSIVE_WORKSPACE);

    const result = await executeTool(tool,
      context({ path: '/tmp/missing-dir/file.txt', content: 'data' }),
    );

    expect(result.isError).toBeFalsy();
    expect(mkdir).toHaveBeenCalledWith('/tmp/missing-dir', { parents: true, existOk: true });
    expect(writeText).toHaveBeenCalledWith('/tmp/missing-dir/file.txt', 'data');
  });

  it('surfaces mkdir failures when a missing parent cannot be created', async () => {
    const enoent = Object.assign(new Error('ENOENT: no such file or directory'), {
      code: 'ENOENT',
    });
    const stat = vi.fn().mockRejectedValue(enoent);
    const mkdir = vi.fn().mockRejectedValue(new Error('permission denied'));
    const writeText = vi.fn().mockResolvedValue(4);
    const tool = new WriteTool(createFakeKaos({ stat, mkdir, writeText }), PERMISSIVE_WORKSPACE);

    const result = await executeTool(tool,
      context({ path: '/tmp/missing-dir/file.txt', content: 'data' }),
    );

    expect(result).toMatchObject({ isError: true, output: 'permission denied' });
    expect(writeText).not.toHaveBeenCalled();
  });

  it('rejects writing when the parent path is not a directory', async () => {
    // A regular file (S_IFREG) standing where a directory is expected.
    const stat = vi.fn().mockResolvedValue({ stMode: 0o100644 });
    const writeText = vi.fn().mockResolvedValue(4);
    const tool = new WriteTool(createFakeKaos({ stat, writeText }), PERMISSIVE_WORKSPACE);

    const result = await executeTool(tool,
      context({ path: '/tmp/a-file/child.txt', content: 'data' }),
    );

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toMatch(/not a directory/i);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('writes when the parent directory exists', async () => {
    const stat = vi.fn().mockResolvedValue({ stMode: 0o040755 });
    const writeText = vi.fn().mockResolvedValue(4);
    const tool = new WriteTool(createFakeKaos({ stat, writeText }), PERMISSIVE_WORKSPACE);

    const result = await executeTool(tool, context({ path: '/tmp/exists/file.txt', content: 'data' }));

    expect(result.isError).toBeUndefined();
    expect(writeText).toHaveBeenCalledWith('/tmp/exists/file.txt', 'data');
  });

  it('surfaces kaos write failures as tool errors', async () => {
    const tool = new WriteTool(
      createFakeKaos({
        stat: DIR_STAT,
        writeText: vi.fn().mockRejectedValue(new Error('disk full')),
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(tool, context({ path: '/some/file.txt', content: 'data' }));

    expect(result).toMatchObject({ isError: true, output: 'disk full' });
  });

  it('allows explicit absolute writes outside the workspace', async () => {
    const writeText = vi.fn().mockResolvedValue(1);
    const tool = new WriteTool(createFakeKaos({ writeText, stat: DIR_STAT }), {
      workspaceDir: '/workspace',
      additionalDirs: [],
    });

    const result = await executeTool(tool, context({ path: '/tmp/pwned.txt', content: 'x' }));

    expect(result.isError).toBeUndefined();
    expect(writeText).toHaveBeenCalledWith('/tmp/pwned.txt', 'x');
  });

  it('rejects relative traversal writes before kaos I/O', async () => {
    const writeText = vi.fn().mockResolvedValue(1);
    const tool = new WriteTool(createFakeKaos({ writeText }), {
      workspaceDir: '/workspace/project',
      additionalDirs: [],
    });

    const result = await executeTool(tool, context({ path: '../outside.txt', content: 'x' }));

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('absolute path');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('blocks sensitive file writes', async () => {
    const writeText = vi.fn().mockResolvedValue(1);
    const tool = new WriteTool(createFakeKaos({ writeText }), {
      workspaceDir: '/workspace',
      additionalDirs: [],
    });

    const result = await executeTool(tool, context({ path: '/workspace/id_rsa', content: 'key' }));

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('sensitive-file pattern');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('round-trips unicode content (CJK + emoji + accented Latin) through kaos.writeText', async () => {
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new WriteTool(createFakeKaos({ writeText }), PERMISSIVE_WORKSPACE);
    const content = 'Hello 世界 🌍\nUnicode: café, naïve, résumé';

    const result = await executeTool(tool,context({ path: '/tmp/unicode.txt', content }));

    expect(result.isError).toBeFalsy();
    expect(writeText).toHaveBeenCalledWith('/tmp/unicode.txt', content);
  });

  it('writes empty content as a zero-byte file via kaos.writeText("")', async () => {
    const writeText = vi.fn().mockResolvedValue(0);
    const tool = new WriteTool(createFakeKaos({ writeText }), PERMISSIVE_WORKSPACE);

    const result = await executeTool(tool,context({ path: '/tmp/empty.txt', content: '' }));

    expect(result.isError).toBeFalsy();
    expect(writeText).toHaveBeenCalledWith('/tmp/empty.txt', '');
  });

  it('still reports parent-directory ENOENT surfaced by writeText itself', async () => {
    // When the proactive parent check is inconclusive (e.g. the environment
    // has no `stat`) and the underlying write then fails with ENOENT — for
    // example a parent directory removed between the check and the write —
    // the tool still surfaces a clear "parent directory does not exist"
    // message rather than a raw host error.
    const writeText = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }),
      );
    const tool = new WriteTool(createFakeKaos({ writeText }), PERMISSIVE_WORKSPACE);

    const result = await executeTool(tool,
      context({ path: '/tmp/missing-dir/file.txt', content: 'data' }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('parent directory does not exist');
  });

  it('appending to a nonexistent file creates it with just the appended bytes', async () => {
    // py spec: append mode on a missing path returns success and creates
    // the file. Lock down the create-on-append contract.
    const writeText = vi.fn().mockResolvedValue(11);
    const tool = new WriteTool(createFakeKaos({ writeText }), PERMISSIVE_WORKSPACE);

    const result = await executeTool(tool,
      context({ path: '/tmp/new-append.txt', content: 'New content', mode: 'append' }),
    );

    expect(result.isError).toBeFalsy();
    expect(toolContentString(result).toLowerCase()).toContain('appended');
    expect(writeText).toHaveBeenCalledWith('/tmp/new-append.txt', 'New content', { mode: 'a' });
  });

  it('allows absolute writes to a sibling dir that merely shares the work-dir prefix', async () => {
    // Path policy must distinguish "shares a prefix with workspaceDir" from
    // "is inside workspaceDir". /workspace-sneaky/* is outside /workspace.
    const writeText = vi.fn().mockResolvedValue(1);
    const tool = new WriteTool(createFakeKaos({ writeText }), {
      workspaceDir: '/workspace',
      additionalDirs: [],
    });

    const result = await executeTool(tool,
      context({ path: '/workspace-sneaky/file.txt', content: 'content' }),
    );

    expect(result.isError).toBeFalsy();
    expect(writeText).toHaveBeenCalledWith('/workspace-sneaky/file.txt', 'content');
  });
});
