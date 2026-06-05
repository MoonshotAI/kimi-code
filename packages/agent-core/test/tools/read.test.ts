import type { Kaos } from '@moonshot-ai/kaos';
import { describe, expect, it, vi } from 'vitest';

import {
  MAX_BYTES,
  MAX_LINE_LENGTH,
  MAX_LINES,
  type ReadInput,
  ReadInputSchema,
  ReadTool,
} from '../../src/tools/builtin/file/read';
import { MEDIA_SNIFF_BYTES } from '../../src/tools/support/file-type';
import type { WorkspaceConfig } from '../../src/tools/support/workspace';
import { createFakeKaos, PERMISSIVE_WORKSPACE, toolContentString } from './fixtures/fake-kaos';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;
const REGULAR_FILE_STAT = {
  stMode: 0o100_644,
  stIno: 1,
  stDev: 1,
  stNlink: 1,
  stUid: 1000,
  stGid: 1000,
  stSize: 0,
  stAtime: 0,
  stMtime: 0,
  stCtime: 0,
} satisfies Awaited<ReturnType<Kaos['stat']>>;

const DIRECTORY_STAT = {
  ...REGULAR_FILE_STAT,
  stMode: 0o040_755,
} satisfies Awaited<ReturnType<Kaos['stat']>>;

function context(args: ReadInput) {
  return {
    turnId: '0',
    toolCallId: 'call_read',
    args,
    signal,
  };
}

function linesFromContent(content: string): string[] {
  if (content === '') return [];
  const rawLines = content.split('\n');
  return rawLines.flatMap((line, index) => {
    if (index < rawLines.length - 1) return [`${line}\n`];
    return line === '' ? [] : [line];
  });
}

function readLinesFromContent(content: string): Kaos['readLines'] {
  return async function* readLines(): AsyncGenerator<string> {
    for (const line of linesFromContent(content)) {
      yield line;
    }
  };
}

function withReadStatus(output: string, status: string): string {
  const note = `<system>${status}</system>`;
  return output.length > 0 ? `${output}\n${note}` : note;
}

function toolWithContent(content: string, workspace: WorkspaceConfig = PERMISSIVE_WORKSPACE) {
  const bytes = Buffer.from(content, 'utf8');
  return new ReadTool(
    createFakeKaos({
      stat: vi.fn<Kaos['stat']>().mockResolvedValue(REGULAR_FILE_STAT),
      readBytes: vi.fn<Kaos['readBytes']>().mockImplementation(async (_path, n) => {
        return n === undefined ? bytes : bytes.subarray(0, n);
      }),
      readLines: vi.fn<Kaos['readLines']>().mockImplementation(readLinesFromContent(content)),
      readText: vi.fn<Kaos['readText']>().mockResolvedValue(content),
    }),
    workspace,
  );
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

    const result = await executeTool(tool, context({ path: '/tmp/a.txt' }));

    expect(result).toEqual({
      output: withReadStatus(
        '1\talpha\n2\tbeta',
        '2 lines read from file starting from line 1. Total lines in file: 2. End of file reached.',
      ),
    });
  });

  it('normalizes pure CRLF files to the LF model view', async () => {
    const tool = toolWithContent('alpha\r\nbeta\r\n');

    const result = await executeTool(tool, context({ path: '/tmp/a.txt' }));

    expect(result.output).toBe(
      withReadStatus(
        ['1\talpha', '2\tbeta'].join('\n'),
        '2 lines read from file starting from line 1. Total lines in file: 2. End of file reached.',
      ),
    );
  });

  it('makes mixed carriage returns visible instead of normalizing them', async () => {
    const tool = toolWithContent('alpha\r\nbeta\ngamma\rdone');

    const result = await executeTool(tool, context({ path: '/tmp/a.txt' }));

    expect(result.output).toBe(
      withReadStatus(
        ['1\talpha\\r', '2\tbeta', '3\tgamma\\rdone'].join('\n'),
        '3 lines read from file starting from line 1. Total lines in file: 3. End of file reached. Mixed or lone carriage-return line endings are shown as \\r. Use exact \\r\\n or \\r escapes in Edit.old_string for those lines.',
      ),
    );
  });

  it('respects one-based line_offset and positive n_lines', async () => {
    const tool = toolWithContent('a\nb\nc\nd\ne');

    const result = await executeTool(tool, context({ path: '/tmp/a.txt', line_offset: 2, n_lines: 2 }));

    expect(result).toEqual({
      output: withReadStatus(
        '2\tb\n3\tc',
        '2 lines read from file starting from line 2. Total lines in file: 5.',
      ),
    });
  });

  it('returns an empty successful output when line_offset is beyond EOF', async () => {
    const tool = toolWithContent('a\nb');

    const result = await executeTool(tool, context({ path: '/tmp/a.txt', line_offset: 20 }));

    expect(result).toEqual({
      output: withReadStatus(
        '',
        'No lines read from file. Total lines in file: 2. End of file reached.',
      ),
    });
  });

  it('supports negative line_offset as tail mode with absolute line numbers', async () => {
    const tool = toolWithContent('a\nb\nc\nd\ne');

    const result = await executeTool(tool, context({ path: '/tmp/a.txt', line_offset: -3 }));

    expect(result).toEqual({
      output: withReadStatus(
        '3\tc\n4\td\n5\te',
        '3 lines read from file starting from line 3. Total lines in file: 5. End of file reached.',
      ),
    });
  });

  it('applies n_lines from the start of the negative line_offset tail window', async () => {
    const tool = toolWithContent('a\nb\nc\nd\ne');

    const result = await executeTool(tool, context({ path: '/tmp/a.txt', line_offset: -5, n_lines: 2 }));

    expect(result.output).toBe(
      withReadStatus(
        '1\ta\n2\tb',
        '2 lines read from file starting from line 1. Total lines in file: 5.',
      ),
    );
  });

  it('rejects relative traversal before reading', async () => {
    const readText = vi.fn().mockResolvedValue('secret');
    const tool = new ReadTool(createFakeKaos({ readText }), {
      workspaceDir: '/workspace/project',
      additionalDirs: [],
    });

    const result = await executeTool(tool, context({ path: '../../outside.txt' }));

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('absolute path');
    expect(readText).not.toHaveBeenCalled();
  });

  it('allows explicit absolute paths outside the workspace', async () => {
    const content = 'external';
    const bytes = Buffer.from(content, 'utf8');
    const readBytes = vi.fn<Kaos['readBytes']>().mockImplementation(async (_path, n) => {
      return n === undefined ? bytes : bytes.subarray(0, n);
    });
    const readLines = vi.fn<Kaos['readLines']>().mockImplementation(readLinesFromContent(content));
    const tool = new ReadTool(
      createFakeKaos({
        stat: vi.fn<Kaos['stat']>().mockResolvedValue(REGULAR_FILE_STAT),
        readBytes,
        readLines,
      }),
      {
        workspaceDir: '/workspace',
        additionalDirs: [],
      },
    );

    const result = await executeTool(tool, context({ path: '/tmp/external.txt' }));

    expect(result.output).toBe(
      withReadStatus(
        '1\texternal',
        '1 line read from file starting from line 1. Total lines in file: 1. End of file reached.',
      ),
    );
    expect(readBytes).toHaveBeenCalledWith('/tmp/external.txt', MEDIA_SNIFF_BYTES);
    expect(readLines).toHaveBeenCalledWith('/tmp/external.txt', { errors: 'strict' });
  });

  it('returns a friendly error for missing files before sniffing bytes', async () => {
    const statError = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const readBytes = vi
      .fn<Kaos['readBytes']>()
      .mockRejectedValue(new Error('readBytes should not be called for missing files'));
    const readLines = vi.fn<Kaos['readLines']>().mockImplementation(readLinesFromContent(''));
    const tool = new ReadTool(
      createFakeKaos({
        stat: vi.fn<Kaos['stat']>().mockRejectedValue(statError),
        readBytes,
        readLines,
      }),
      {
        workspaceDir: '/workspace',
        additionalDirs: [],
      },
    );

    const result = await executeTool(tool, context({ path: '/workspace/missing.txt' }));

    expect(result).toEqual({
      isError: true,
      output: '"/workspace/missing.txt" does not exist.',
    });
    expect(readBytes).not.toHaveBeenCalled();
    expect(readLines).not.toHaveBeenCalled();
  });

  it('returns a friendly error for directories before sniffing bytes', async () => {
    const readBytes = vi
      .fn<Kaos['readBytes']>()
      .mockRejectedValue(new Error('readBytes should not be called for directories'));
    const readLines = vi.fn<Kaos['readLines']>().mockImplementation(readLinesFromContent(''));
    const tool = new ReadTool(
      createFakeKaos({
        stat: vi.fn<Kaos['stat']>().mockResolvedValue(DIRECTORY_STAT),
        readBytes,
        readLines,
      }),
      {
        workspaceDir: '/workspace',
        additionalDirs: [],
      },
    );

    const result = await executeTool(tool, context({ path: '/workspace/src' }));

    expect(result).toEqual({
      isError: true,
      output: '"/workspace/src" is not a file.',
    });
    expect(readBytes).not.toHaveBeenCalled();
    expect(readLines).not.toHaveBeenCalled();
  });

  it('expands leading tilde paths using the kaos home directory', async () => {
    const content = 'home note';
    const bytes = Buffer.from(content, 'utf8');
    const readBytes = vi.fn<Kaos['readBytes']>().mockImplementation(async (_path, n) => {
      return n === undefined ? bytes : bytes.subarray(0, n);
    });
    const readLines = vi.fn<Kaos['readLines']>().mockImplementation(readLinesFromContent(content));
    const tool = new ReadTool(
      createFakeKaos({
        gethome: () => '/home/test',
        stat: vi.fn<Kaos['stat']>().mockResolvedValue(REGULAR_FILE_STAT),
        readBytes,
        readLines,
      }),
      {
        workspaceDir: '/workspace',
        additionalDirs: [],
      },
    );

    const result = await executeTool(tool, context({ path: '~/notes/today.txt' }));

    expect(result.output).toBe(
      withReadStatus(
        '1\thome note',
        '1 line read from file starting from line 1. Total lines in file: 1. End of file reached.',
      ),
    );
    expect(readBytes).toHaveBeenCalledWith('/home/test/notes/today.txt', MEDIA_SNIFF_BYTES);
    expect(readLines).toHaveBeenCalledWith('/home/test/notes/today.txt', { errors: 'strict' });
  });

  it('blocks sensitive files independently from workspace access', async () => {
    const readText = vi.fn().mockResolvedValue('SECRET=value');
    const tool = new ReadTool(createFakeKaos({ readText }), {
      workspaceDir: '/workspace',
      additionalDirs: [],
    });

    const result = await executeTool(tool, context({ path: '/workspace/.env' }));

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('sensitive-file pattern');
    expect(readText).not.toHaveBeenCalled();
  });

  it('rejects image files before text decoding and points to ReadMediaFile', async () => {
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const readText = vi
      .fn<Kaos['readText']>()
      .mockRejectedValue(new Error('readText should not be called for images'));
    const tool = new ReadTool(
      createFakeKaos({
        stat: vi.fn<Kaos['stat']>().mockResolvedValue(REGULAR_FILE_STAT),
        readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(pngHeader),
        readText,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(tool, context({ path: '/tmp/sample.png' }));
    const output = toolContentString(result);

    expect(result.isError).toBe(true);
    expect(output).toMatch(/image file/i);
    expect(output).toMatch(/ReadMediaFile|media/i);
    expect(readText).not.toHaveBeenCalled();
  });

  it('rejects extensionless image files using magic-byte sniffing', async () => {
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const readText = vi
      .fn<Kaos['readText']>()
      .mockRejectedValue(new Error('readText should not be called for extensionless images'));
    const tool = new ReadTool(
      createFakeKaos({
        stat: vi.fn<Kaos['stat']>().mockResolvedValue(REGULAR_FILE_STAT),
        readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(pngHeader),
        readText,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(tool, context({ path: '/tmp/sample' }));
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
    const readText = vi
      .fn<Kaos['readText']>()
      .mockRejectedValue(new Error('readText should not be called for videos'));
    const tool = new ReadTool(
      createFakeKaos({
        stat: vi.fn<Kaos['stat']>().mockResolvedValue(REGULAR_FILE_STAT),
        readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(mp4Header),
        readText,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(tool, context({ path: '/tmp/sample.mp4' }));
    const output = toolContentString(result);

    expect(result.isError).toBe(true);
    expect(output).toMatch(/video file/i);
    expect(output).toMatch(/ReadMediaFile|media/i);
    expect(readText).not.toHaveBeenCalled();
  });

  it('rejects NUL-containing binary files before text decoding', async () => {
    const header = Buffer.concat([Buffer.from('plain prefix'), Buffer.from([0x00, 0x01])]);
    const readText = vi
      .fn<Kaos['readText']>()
      .mockRejectedValue(new Error('readText should not be called for binary files'));
    const tool = new ReadTool(
      createFakeKaos({
        stat: vi.fn<Kaos['stat']>().mockResolvedValue(REGULAR_FILE_STAT),
        readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(header),
        readText,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(tool, context({ path: '/tmp/blob.bin' }));
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
    const readLines = vi.fn<Kaos['readLines']>().mockImplementation(async function* readLines() {
      yield 'safe text\n';
      yield `binary${String.fromCodePoint(0)}tail\n`;
    });
    const tool = new ReadTool(
      createFakeKaos({
        stat: vi.fn<Kaos['stat']>().mockResolvedValue(REGULAR_FILE_STAT),
        readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(header),
        readLines,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(tool, context({ path: '/tmp/blob-with-late-nul' }));
    const output = toolContentString(result);

    expect(result.isError).toBe(true);
    expect(output).toBe(
      '"/tmp/blob-with-late-nul" is not readable as UTF-8 text. If it is an image or video, use ReadMediaFile. For other binary formats, use Bash or an MCP tool if available.',
    );
    expect(output).not.toContain('Python tools');
  });

  it('rejects invalid UTF-8 instead of returning replacement characters', async () => {
    const replacement = String.fromCodePoint(0xfffd);
    const readLines = vi.fn<Kaos['readLines']>().mockImplementation(async function* readLines(
      _path,
      options,
    ) {
      if (options?.errors === 'strict') {
        throw new TypeError('The encoded data was not valid for encoding utf-8');
      }
      yield `bad${replacement}text\n`;
    });
    const tool = new ReadTool(
      createFakeKaos({
        stat: vi.fn<Kaos['stat']>().mockResolvedValue(REGULAR_FILE_STAT),
        readBytes: vi.fn<Kaos['readBytes']>().mockResolvedValue(Buffer.from('text header')),
        readLines,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(tool, context({ path: '/tmp/not-utf8.txt' }));
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

    const result = await executeTool(tool, context({ path: '/tmp/long.txt' }));

    expect(result.output).toContain('Lines [1, 3] were truncated.');
    expect(result.output).toContain('...');
  });

  it('checks the byte cap before adding the next rendered line', async () => {
    const line = 'x'.repeat(MAX_LINE_LENGTH);
    const content = Array.from({ length: 80 }, () => line).join('\n');
    const tool = toolWithContent(content);

    const result = await executeTool(tool, context({ path: '/tmp/bytes.txt' }));
    const output = toolContentString(result);

    const marker = '\n<system>';
    const markerIndex = output.indexOf(marker);
    expect(markerIndex).toBeGreaterThan(0);
    const body = output.slice(0, markerIndex);
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(MAX_BYTES);
    expect(output).toContain(`Max ${String(MAX_BYTES)} bytes reached.`);
  });

  it('uses text preview for sniffing before falling back to readBytes', async () => {
    const content = 'hello from acp buffer\nsecond line\n';
    const readBytes = vi.fn<Kaos['readBytes']>().mockImplementation(async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const readTextPreview = vi.fn(async (_path: string, n: number) => Buffer.from(content.slice(0, n), 'utf8'));
    const tool = new ReadTool(
      createFakeKaos({
        stat: vi.fn<Kaos['stat']>().mockResolvedValue(REGULAR_FILE_STAT),
        readBytes,
        readTextPreview,
        readLines: vi.fn<Kaos['readLines']>().mockImplementation(readLinesFromContent(content)),
        readText: vi.fn<Kaos['readText']>().mockRejectedValue(new Error('full readText should not be called')),
      } as unknown as Partial<Kaos>),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(tool, context({ path: '/tmp/acp.txt' }));
    const output = toolContentString(result);

    expect(result.isError).toBeFalsy();
    expect(output).toContain('1	hello from acp buffer');
    expect(output).toContain('2	second line');
    expect(readTextPreview).toHaveBeenCalledWith('/tmp/acp.txt', MEDIA_SNIFF_BYTES);
    expect(readBytes).not.toHaveBeenCalled();
  });

  it('reads through bounded byte preflight and streams line iteration without full readText', async () => {
    const content = Array.from({ length: MAX_LINES + 5 }, (_, i) => `line ${String(i + 1)}`).join(
      '\n',
    );
    const bytes = Buffer.from(content, 'utf8');
    const readText = vi
      .fn<Kaos['readText']>()
      .mockRejectedValue(new Error('full readText should not be called'));
    let consumed = 0;
    const readLines: Kaos['readLines'] = async function* readLines(): AsyncGenerator<string> {
      for (let i = 1; i <= MAX_LINES + 5; i += 1) {
        consumed = i;
        yield `line ${String(i)}\n`;
      }
    };
    const readBytes = vi.fn<Kaos['readBytes']>().mockImplementation(async (_path, n) => {
      return n === undefined ? bytes : bytes.subarray(0, n);
    });
    const tool = new ReadTool(
      createFakeKaos({
        stat: vi.fn<Kaos['stat']>().mockResolvedValue(REGULAR_FILE_STAT),
        readBytes,
        readLines,
        readText,
      }),
      PERMISSIVE_WORKSPACE,
    );

    const result = await executeTool(tool, context({ path: '/tmp/large.txt' }));
    const output = toolContentString(result);

    expect(result.isError).toBeFalsy();
    expect(output).toContain('1\tline 1');
    expect(output).toContain(`${String(MAX_LINES)}\tline ${String(MAX_LINES)}`);
    expect(output).toContain(`Total lines in file: ${String(MAX_LINES + 5)}.`);
    expect(output).toContain(`Max ${String(MAX_LINES)} lines reached.`);
    expect(consumed).toBe(MAX_LINES + 5);
    expect(readBytes).toHaveBeenCalledWith('/tmp/large.txt', MEDIA_SNIFF_BYTES);
    expect(readText).not.toHaveBeenCalled();
  });

  it('caps default reads at MAX_LINES', async () => {
    const content = Array.from({ length: MAX_LINES + 1 }, (_, i) => `line ${String(i + 1)}`).join(
      '\n',
    );
    const tool = toolWithContent(content);

    const result = await executeTool(tool, context({ path: '/tmp/big.txt' }));

    expect(result.output).toContain(`Max ${String(MAX_LINES)} lines reached.`);
    expect(result.output).toContain(`${String(MAX_LINES)}\tline ${String(MAX_LINES)}`);
    expect(result.output).not.toContain(`${String(MAX_LINES + 1)}\tline ${String(MAX_LINES + 1)}`);
  });

  it('tail byte truncation keeps the newest lines closest to EOF', async () => {
    const numLines = Math.floor(MAX_BYTES / 1001) + 20;
    const content = Array.from({ length: numLines }, (_, i) => {
      return `${String(i + 1).padStart(4, '0')}${'B'.repeat(996)}`;
    }).join('\n');
    const tool = toolWithContent(content);

    const result = await executeTool(tool, context({ path: '/tmp/tail-bytes.txt', line_offset: -1000 }));
    const output = toolContentString(result);
    const outputLines = output
      .split('\n')
      .filter((line) => line.includes('\t') && !line.startsWith('<system>'));

    expect(output).toContain(`Max ${String(MAX_BYTES)} bytes reached.`);
    expect(outputLines.at(-1)).toContain(String(numLines).padStart(4, '0'));
    expect(outputLines[0]).not.toContain('0001');
  });

  it('tail n_lines is applied before byte truncation', async () => {
    const numLines = 500;
    const content = Array.from({ length: numLines }, (_, i) => {
      return `${String(i + 1).padStart(4, '0')}${'X'.repeat(1996)}`;
    }).join('\n');
    const tool = toolWithContent(content);

    const result = await executeTool(tool,
      context({ path: '/tmp/tail-small-window.txt', line_offset: -200, n_lines: 1 }),
    );
    const output = toolContentString(result);

    expect(output).toMatch(/^301\t0301/);
    expect(output).not.toContain('Max');
  });

  it('description pins line/byte caps, tail mode, and the Grep-over-Read preference', () => {
    const tool = toolWithContent('');
    // Numeric caps are part of the stable contract.
    expect(tool.description).toContain(String(MAX_LINES));
    expect(tool.description).toContain(String(MAX_LINE_LENGTH));
    // Tail mode (negative line_offset) is documented.
    expect(tool.description).toMatch(/negative line_offset|reads from the end/i);
    // Recommend Grep when searching for unknown content.
    expect(tool.description).toContain('Grep');
  });

  it('reads files inside additional_dirs via absolute path', async () => {
    const content = 'extra-dir note';
    const bytes = Buffer.from(content, 'utf8');
    const tool = new ReadTool(
      createFakeKaos({
        stat: vi.fn<Kaos['stat']>().mockResolvedValue(REGULAR_FILE_STAT),
        readBytes: vi.fn<Kaos['readBytes']>().mockImplementation(async (_path, n) => {
          return n === undefined ? bytes : bytes.subarray(0, n);
        }),
        readLines: vi.fn<Kaos['readLines']>().mockImplementation(readLinesFromContent(content)),
      }),
      { workspaceDir: '/workspace', additionalDirs: ['/extra'] },
    );

    const result = await executeTool(tool,context({ path: '/extra/notes.txt' }));

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('1\textra-dir note');
  });

  it('reports nonexistent files with the expected does-not-exist phrasing', async () => {
    const statError = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const tool = new ReadTool(
      createFakeKaos({
        stat: vi.fn<Kaos['stat']>().mockRejectedValue(statError),
      }),
      { workspaceDir: '/workspace', additionalDirs: [] },
    );

    const result = await executeTool(tool,context({ path: '/workspace/ghost.txt' }));

    expect(result.isError).toBe(true);
    expect(result.output).toContain('does not exist');
    // py also surfaces a separate `brief` channel with "File not found";
    // TS only has the `output` string, so we check for the equivalent
    // human phrasing in the message itself.
    expect(result.output).toMatch(/not found|does not exist/i);
  });

  it('returns empty output and Total lines: 0 for an empty file', async () => {
    const tool = toolWithContent('');

    const result = await executeTool(tool,context({ path: '/tmp/empty.txt' }));

    expect(result.isError).toBeFalsy();
    expect(result.output).toBe(
      withReadStatus('', 'No lines read from file. Total lines in file: 0. End of file reached.'),
    );
  });

  it('reads unicode (CJK + emoji + accented Latin) without loss', async () => {
    const tool = toolWithContent('Hello 世界 🌍\nUnicode test: café, naïve, résumé');

    const result = await executeTool(tool,context({ path: '/tmp/unicode.txt' }));

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

    const result = await executeTool(tool,context({ path: '/workspace/.gitignore' }));

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('node_modules/');
  });

  it('negative line_offset exceeding total lines returns the entire file', async () => {
    const tool = toolWithContent('a\nb\nc\nd\ne');

    const result = await executeTool(tool,context({ path: '/tmp/short.txt', line_offset: -100 }));

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('1\ta');
    expect(result.output).toContain('5\te');
    expect(result.output).toContain('Total lines in file: 5.');
  });

  it('tail mode on an empty file returns empty output without erroring', async () => {
    const tool = toolWithContent('');

    const result = await executeTool(tool,context({ path: '/tmp/empty-tail.txt', line_offset: -10 }));

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('Total lines in file: 0.');
  });

  it('line_offset=-1 returns only the last line with its absolute line number', async () => {
    const tool = toolWithContent('a\nb\nc\nd\ne');

    const result = await executeTool(tool,context({ path: '/tmp/last.txt', line_offset: -1 }));

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('5\te');
    expect(result.output).toContain('1 line read from file starting from line 5.');
  });

  it('tail mode reports absolute line numbers when long lines are truncated', async () => {
    const shortLine = 'short';
    const longLine = 'X'.repeat(MAX_LINE_LENGTH + 500);
    const content = [shortLine, longLine, shortLine, longLine, shortLine].join('\n');
    const tool = toolWithContent(content);

    const result = await executeTool(tool,context({ path: '/tmp/tail-trunc.txt', line_offset: -3 }));

    expect(result.isError).toBeFalsy();
    // Last 3 lines = 3, 4, 5; line 4 is the long one.
    expect(result.output).toContain('Total lines in file: 5.');
    expect(result.output).toContain('Lines [4] were truncated.');
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
    // The TS implementation appends the status block after the content.
    expect(tool.description).toMatch(/after the file content/i);
  });

  it('describes the path parameter with accurate working-directory semantics', () => {
    const tool = toolWithContent('');
    const pathProperty = (
      tool.parameters as { properties: { path: { description: string } } }
    ).properties.path;

    expect(pathProperty.description).toContain('working directory');
    expect(pathProperty.description).not.toMatch(/^Absolute path/);
  });

  it('documents the default for n_lines when omitted', () => {
    const tool = toolWithContent('');
    const nLinesProperty = (
      tool.parameters as { properties: { n_lines: { description: string } } }
    ).properties.n_lines;

    // Omitting n_lines reads up to MAX_LINES; the schema description must say so.
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
