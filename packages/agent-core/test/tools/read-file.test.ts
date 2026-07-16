import type { Kaos } from '@moonshot-ai/kaos';
import { describe, expect, it, vi } from 'vitest';

import { ReadTool } from '../../src/tools/builtin/file/read';
import { createFakeKaos, PERMISSIVE_WORKSPACE } from './fixtures/fake-kaos';
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

function toolWithContent(content: string): ReadTool {
  const bytes = Buffer.from(content, 'utf8');
  return new ReadTool(
    createFakeKaos({
      stat: vi.fn<Kaos['stat']>().mockResolvedValue(REGULAR_FILE_STAT),
      readBytes: vi.fn<Kaos['readBytes']>().mockImplementation(async (_path, n) => {
        return n === undefined ? bytes : bytes.subarray(0, n);
      }),
      readLines: vi.fn<Kaos['readLines']>().mockImplementation(readLinesFromContent(content)),
    }),
    PERMISSIVE_WORKSPACE,
  );
}

describe('ReadTool — total-lines message channel', () => {
  it('reports the file total in the status message even with a positive line_offset window', async () => {
    // Five-line file, request just line 3 with n_lines=1. The status
    // line must still surface the file's full length so the model can plan
    // a follow-up read of the rest of the file.
    const tool = toolWithContent('a\nb\nc\nd\ne');

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c1',
      args: { path: '/tmp/sample.txt', line_offset: 3, n_lines: 1 },
      signal,
    });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('3\tc');
    expect(result.note).toContain('Total lines in file: 5.');
  });

  it('reports Total lines: 0 for an empty file with a negative offset', async () => {
    const tool = toolWithContent('');

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c_empty_tail',
      args: { path: '/tmp/empty.txt', line_offset: -10 },
      signal,
    });

    expect(result.isError).toBeFalsy();
    expect(result.note).toContain('Total lines in file: 0.');
  });

  it('reports the correct total for a single-line file without trailing newline', async () => {
    const tool = toolWithContent('just one line');

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c_single',
      args: { path: '/tmp/one-line.txt' },
      signal,
    });

    expect(result.isError).toBeFalsy();
    expect(result.note).toContain('Total lines in file: 1.');
    expect(result.note).toContain('End of file reached');
  });

  it('reports the correct total when n_lines reads exactly the last line', async () => {
    const tool = toolWithContent('alpha\nbeta\ncharlie\n');

    const result = await executeTool(tool, {
      turnId: 't1',
      toolCallId: 'c_last',
      args: { path: '/tmp/last.txt', line_offset: 3, n_lines: 1 },
      signal,
    });

    expect(result.isError).toBeFalsy();
    expect(result.output).toBe('3\tcharlie');
    expect(result.note).toContain('1 line read from file starting from line 3. Total lines in file: 3.');
    expect(result.note).toContain('End of file reached');
  });
});
