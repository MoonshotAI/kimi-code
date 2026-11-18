import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectFilePathAliases,
  findFilePathLinks,
  parseFilePathLinkCandidate,
} from '@moonshot-ai/app-markdown/lib/filePathLinks';
import { parseDiff } from '@moonshot-ai/app-core/client';
import { buildDiffLines, buildWholeFileDiffLines, buildVerbatimDiffLines, splitLines } from '@moonshot-ai/app-core/client';
import { buildEditDiffLines, buildWriteContent, toolFilePath } from '@moonshot-ai/app-core/client';
import { parseReadOutput } from '@moonshot-ai/app-core/lib';
import { codeLanguageFromPath } from '@moonshot-ai/app-core/lib';
import { createCoalescedAsyncRunner } from '@moonshot-ai/app-core/lib';
import { normalizeToolName, toolSummary } from '@moonshot-ai/app-components';
import { collapsePrompt } from '@moonshot-ai/app-core/lib';
import {
  currentValidatedWorkspacePath,
  isWorkspacePathInput,
  joinWorkspacePathCandidate,
  parseWorkspacePathInput,
} from '@moonshot-ai/app-core/lib';
import { normalizeRelativePath, pathRelativeTo } from '@moonshot-ai/app-core/lib';
import {
  commitLevel,
  defaultThinkingLevelFor,
  effortLabel,
  levelDeclaredBy,
  modelThinkingAvailability,
  segmentsFor,
  thinkingLevelFromConfig,
  thinkingLevelToConfig,
} from '@moonshot-ai/app-core/lib';
import type { AppModel } from '../../src/renderer/api/types';
import { resolveToolRenderer } from '@moonshot-ai/app-components';
import { AgentTool } from '@moonshot-ai/app-components';
import { BashTool } from '@moonshot-ai/app-components';
import { CronTool } from '@moonshot-ai/app-components';
import { EditTool } from '@moonshot-ai/app-components';
import { GenericTool } from '@moonshot-ai/app-components';
import { ReadTool } from '@moonshot-ai/app-components';
import { SelectToolsTool } from '@moonshot-ai/app-components';
import type { ToolCall } from '../../src/renderer/types';
import {
  clearTrace,
  installClientErrorCapture,
  sanitizeForTrace,
  sessionExportTraceToJsonl,
  setTraceEnabled,
  traceEntries,
  traceKeyEvent,
  tracePaused,
  traceRestRequest,
  traceToJsonl,
  traceWsIn,
} from '@moonshot-ai/app-client/trace';

describe('bounded Web trace', () => {
  beforeEach(() => {
    tracePaused.value = false;
    clearTrace();
  });

  afterEach(() => {
    setTraceEnabled(false);
    clearTrace();
    vi.unstubAllGlobals();
  });

  it('copies only allowlisted key-path metadata into the independent export ring', () => {
    const secret = 'PROMPT_TEXT_MUST_NOT_BE_EXPORTED';
    const metadata = {
      sessionId: 'sess_1',
      contentCount: 2,
      mediaCount: 1,
      text: secret,
      apiKey: secret,
    };
    traceKeyEvent('prompt:start', metadata);

    metadata.sessionId = 'changed_after_recording';

    expect(traceEntries()).toHaveLength(1);
    expect(JSON.parse(sessionExportTraceToJsonl())).toEqual({
      ts: expect.any(Number),
      event: 'prompt:start',
      sessionId: 'sess_1',
      contentCount: 2,
      mediaCount: 1,
    });
    expect(sessionExportTraceToJsonl()).not.toContain(secret);
  });

  it('records export metadata even while the full debug panel is paused', () => {
    tracePaused.value = true;

    traceKeyEvent('ws:connection', { status: 'connected' });

    expect(traceEntries()).toHaveLength(0);
    expect(JSON.parse(sessionExportTraceToJsonl())).toMatchObject({
      event: 'ws:connection',
      status: 'connected',
    });
  });

  it('caps object keys and reports how many were omitted', () => {
    const input = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`key${index}`, index]));

    const result = sanitizeForTrace(input) as Record<string, unknown>;

    expect(result['_truncatedKeys']).toBe(10);
    expect(Object.keys(result)).toHaveLength(51);
  });

  it('redacts sensitive keys including profile PII', () => {
    const result = sanitizeForTrace({
      email: 'user@example.com',
      phone: '+8613800000000',
      nickname: 'alice',
      avatar: 'https://example.com/a.png',
      sessionId: 'sess_1',
    });

    expect(result).toEqual({
      email: '[redacted]',
      phone: '[redacted]',
      nickname: '[redacted]',
      avatar: '[redacted]',
      sessionId: 'sess_1',
    });
  });

  it('keeps at most 500 of the newest export entries', () => {
    for (let index = 0; index < 501; index++) {
      traceKeyEvent('ws:connection', { status: String(index) });
    }

    const exported = sessionExportTraceToJsonl().split('\n').map((line) => JSON.parse(line));
    expect(exported).toHaveLength(500);
    expect(exported[0]).toMatchObject({ status: '1' });
    expect(exported.at(-1)).toMatchObject({ status: '500' });
  });

  it('keeps export JSONL within the 256 KiB UTF-8 budget including newlines', () => {
    for (let index = 0; index < 500; index++) {
      traceKeyEvent('export:failed', {
        sessionId: `sess-${index}-${'😀'.repeat(200)}`,
        status: '😀'.repeat(200),
        promptId: '😀'.repeat(200),
        errorName: '😀'.repeat(200),
        requestId: '😀'.repeat(200),
        phase: '😀'.repeat(200),
      });
    }

    const jsonl = sessionExportTraceToJsonl();
    expect(new TextEncoder().encode(jsonl).byteLength).toBeLessThanOrEqual(256 * 1024);
    expect(JSON.parse(jsonl.split('\n').at(-1)!)).toMatchObject({
      sessionId: expect.stringMatching(/^sess-499-/),
    });
  });

  it('never copies prompt, WebSocket, or console content from the full debug trace', () => {
    setTraceEnabled(true);
    const promptSecret = 'PROMPT_SECRET_9fdb1a';
    const wsSecret = 'WS_PAYLOAD_SECRET_b84c7e';
    const consoleSecret = 'CONSOLE_SECRET_a2d693';

    traceRestRequest({
      method: 'POST',
      path: '/sessions/sess_1/prompts',
      url: 'http://daemon.test/api/v1/sessions/sess_1/prompts',
      requestId: 'req_1',
      body: { prompt: promptSecret },
    });
    traceWsIn({
      type: 'event',
      session_id: 'sess_1',
      seq: 4,
      payload: { text: wsSecret },
    });

    const originalLog = console.log;
    console.log = vi.fn();
    const dispose = installClientErrorCapture();
    try {
      console.log(consoleSecret, { value: consoleSecret });
    } finally {
      dispose();
      console.log = originalLog;
    }

    const promptPayload = {
      sessionId: 'sess_1',
      contentCount: 1,
      mediaCount: 0,
      text: promptSecret,
    };
    traceKeyEvent('prompt:start', promptPayload);

    const fullDebugTrace = traceToJsonl();
    expect(fullDebugTrace).toContain(promptSecret);
    expect(fullDebugTrace).toContain(wsSecret);
    expect(fullDebugTrace).toContain(consoleSecret);

    const sessionExportTrace = sessionExportTraceToJsonl();
    expect(sessionExportTrace).not.toContain(promptSecret);
    expect(sessionExportTrace).not.toContain(wsSecret);
    expect(sessionExportTrace).not.toContain(consoleSecret);
    expect(JSON.parse(sessionExportTrace)).toEqual({
      ts: expect.any(Number),
      event: 'prompt:start',
      sessionId: 'sess_1',
      contentCount: 1,
      mediaCount: 0,
    });
  });
});

describe('workspace path input', () => {
  it('recognizes the supported absolute path forms', () => {
    expect(isWorkspacePathInput('/tmp/project')).toBe(true);
    expect(isWorkspacePathInput('~/project')).toBe(true);
    expect(isWorkspacePathInput('C:\\project')).toBe(true);
    expect(isWorkspacePathInput('C:/project')).toBe(true);
    expect(isWorkspacePathInput('\\\\server\\share')).toBe(true);
    expect(isWorkspacePathInput('project')).toBe(false);
  });

  it('normalizes separators without changing UNC roots or POSIX backslashes', () => {
    expect(parseWorkspacePathInput('/tmp//project/', '').target).toBe('/tmp/project');
    expect(parseWorkspacePathInput('//server//share/project/', '').target).toBe('//server/share/project');
    expect(parseWorkspacePathInput('///tmp//project/', '').target).toBe('/tmp/project');
    expect(parseWorkspacePathInput('/tmp/project\\', '').target).toBe('/tmp/project\\');
    expect(parseWorkspacePathInput('~/project', '/home/alice').target).toBe('/home/alice/project');
  });

  it('preserves Windows root separators in parent paths', () => {
    expect(parseWorkspacePathInput('C:\\Use', '')).toMatchObject({
      parent: 'C:\\',
      base: 'Use',
      separator: '\\',
    });
    expect(parseWorkspacePathInput('C:/Use', '')).toMatchObject({
      parent: 'C:/',
      base: 'Use',
      separator: '/',
    });
    expect(parseWorkspacePathInput('\\\\server\\share\\pro', '')).toMatchObject({
      parent: '\\\\server\\share',
      base: 'pro',
      separator: '\\',
    });
    expect(parseWorkspacePathInput('//server/share/pro', '')).toMatchObject({
      parent: '//server/share',
      base: 'pro',
      separator: '/',
    });
  });

  it('treats backslashes as literal characters in POSIX paths', () => {
    expect(parseWorkspacePathInput('/tmp/foo\\bar', '')).toMatchObject({
      parent: '/tmp',
      base: 'foo\\bar',
      separator: '/',
    });
  });

  it('builds completion paths from the lexical parent', () => {
    const parsed = parseWorkspacePathInput('/tmp/link/proje', '');
    expect(joinWorkspacePathCandidate(parsed.parent, 'project', parsed.separator)).toBe('/tmp/link/project');
  });

  it('only returns a validated path while it still matches the current input', () => {
    expect(currentValidatedWorkspacePath('/var', '', '/tmp')).toBeNull();
    expect(currentValidatedWorkspacePath('/tmp/', '', '/tmp')).toBe('/tmp');
  });
});

describe('pathRelativeTo', () => {
  it('relativizes an in-root path and rejects an outside one', () => {
    expect(pathRelativeTo('/repo/src/a.ts', '/repo')).toBe('src/a.ts');
    expect(pathRelativeTo('/other/a.ts', '/repo')).toBeNull();
    expect(pathRelativeTo('/repo', '/repo')).toBeNull();
  });

  it('rejects an escaped path that prefixes the root then climbs out', () => {
    expect(pathRelativeTo('/repo/../other/file.ts', '/repo')).toBeNull();
  });

  it('compares case-sensitively on POSIX but insensitively for a Windows root', () => {
    expect(pathRelativeTo('/Repo/a.ts', '/repo')).toBeNull();
    expect(pathRelativeTo('C:\\repo\\a.ts', 'C:\\repo')).toBe('a.ts');
    expect(pathRelativeTo('c:/Repo/A.ts', 'C:/repo')).toBe('A.ts');
  });

  it('handles a filesystem-root root', () => {
    expect(pathRelativeTo('/a/b.ts', '/')).toBe('a/b.ts');
    expect(pathRelativeTo('C:/a/b.ts', 'C:/')).toBe('a/b.ts');
  });

  it('normalizes separators for the comparison but keeps the input casing', () => {
    expect(pathRelativeTo('C:\\repo\\src\\a.ts', 'C:/repo')).toBe('src/a.ts');
  });
});

describe('normalizeRelativePath', () => {
  it('unifies separators and collapses dot segments', () => {
    expect(normalizeRelativePath('src\\./a.ts')).toBe('src/a.ts');
    expect(normalizeRelativePath('src/../a.ts')).toBe('a.ts');
    expect(normalizeRelativePath('C:\\repo\\src\\a.ts')).toBe('C:/repo/src/a.ts');
  });

  it('preserves leading parent segments that escape the base', () => {
    expect(normalizeRelativePath('../a.ts')).toBe('../a.ts');
    expect(normalizeRelativePath('a/../../b.ts')).toBe('../b.ts');
  });
});

describe('parseDiff', () => {
  it('parses multiple files and keeps hunk line numbers', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,3 @@',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 3;',
      '+const c = 4;',
      'diff --git a/src/comment.sql b/src/comment.sql',
      '@@ -5,1 +5,1 @@',
      '--- old comment',
      '+++ new comment',
    ].join('\n');

    expect(parseDiff(diff)).toEqual([
      { type: 'hunk', text: '@@ -1,2 +1,3 @@' },
      { type: 'context', text: 'const a = 1;', oldNo: 1, newNo: 1 },
      { type: 'del', text: 'const b = 2;', oldNo: 2 },
      { type: 'add', text: 'const b = 3;', newNo: 2 },
      { type: 'add', text: 'const c = 4;', newNo: 3 },
      { type: 'hunk', text: '@@ -5,1 +5,1 @@' },
      { type: 'del', text: '-- old comment', oldNo: 5 },
      { type: 'add', text: '++ new comment', newNo: 5 },
    ]);
  });
});

describe('buildDiffLines', () => {
  it('counts a trailing-newline-only change for whole-file diffs but not fragments', () => {
    expect(buildWholeFileDiffLines('a\n', 'a')).toEqual([
      { type: 'del', text: 'a', oldNo: 1 },
      { type: 'add', text: 'a', newNo: 1 },
    ]);
    expect(buildWholeFileDiffLines('a\n', 'a\n')).toEqual([{ type: 'context', text: 'a', oldNo: 1, newNo: 1 }]);
    expect(buildDiffLines('a\n', 'a')).toEqual([{ type: 'context', text: 'a', oldNo: 1, newNo: 1 }]);
  });

  it('shows four additions spread across a 2830-line file with correct line numbers', () => {
    const oldLines = Array.from({ length: 2830 }, (_, i) => `line ${i + 1}`);
    const newLines = [
      'added at start',
      ...oldLines.slice(0, 950),
      'added near first third',
      ...oldLines.slice(950, 1900),
      'added near second third',
      ...oldLines.slice(1900),
      'added at end',
    ];
    const rows = buildWholeFileDiffLines(`${oldLines.join('\n')}\n`, `${newLines.join('\n')}\n`);

    expect(rows).not.toBeNull();
    expect(rows?.filter((row) => row.type === 'add')).toEqual([
      { type: 'add', text: 'added at start', newNo: 1 },
      { type: 'add', text: 'added near first third', newNo: 952 },
      { type: 'add', text: 'added near second third', newNo: 1903 },
      { type: 'add', text: 'added at end', newNo: 2834 },
    ]);
    expect(rows?.filter((row) => row.type === 'del')).toEqual([]);
    expect(rows?.filter((row) => row.oldNo !== undefined).map((row) => row.text)).toEqual(oldLines);
    expect(rows?.filter((row) => row.newNo !== undefined).map((row) => row.text)).toEqual(newLines);
  });

  it.each([
    { before: 'a\nb\nc\n', after: 'a\nc\n', added: 0, removed: 1 },
    { before: 'a\nrepeat\nb\nrepeat\nc\n', after: 'a\nrepeat\nB\nrepeat\nc\n', added: 1, removed: 1 },
    { before: '', after: 'new\nline\n', added: 2, removed: 0 },
  ])('preserves the full old and new texts for $before → $after', ({ before, after, added, removed }) => {
    const rows = buildWholeFileDiffLines(before, after);

    expect(rows?.filter((row) => row.type === 'add')).toHaveLength(added);
    expect(rows?.filter((row) => row.type === 'del')).toHaveLength(removed);
    expect(rows?.filter((row) => row.oldNo !== undefined).map((row) => row.text)).toEqual(splitLines(before));
    expect(rows?.filter((row) => row.newNo !== undefined).map((row) => row.text)).toEqual(splitLines(after));
  });

  it('lines up context, deletions and additions with old/new line numbers', () => {
    const before = 'a\nb\nc';
    const after = 'a\nB\nc\nd';
    expect(buildDiffLines(before, after)).toEqual([
      { type: 'context', text: 'a', oldNo: 1, newNo: 1 },
      { type: 'del', text: 'b', oldNo: 2 },
      { type: 'add', text: 'B', newNo: 2 },
      { type: 'context', text: 'c', oldNo: 3, newNo: 3 },
      { type: 'add', text: 'd', newNo: 4 },
    ]);
  });

  it('treats an empty before as an all-addition write', () => {
    expect(buildDiffLines('', 'x\ny')).toEqual([
      { type: 'add', text: 'x', newNo: 1 },
      { type: 'add', text: 'y', newNo: 2 },
    ]);
  });

  it('returns all context for identical texts and empty for two empties', () => {
    expect(buildDiffLines('a\nb', 'a\nb')).toEqual([
      { type: 'context', text: 'a', oldNo: 1, newNo: 1 },
      { type: 'context', text: 'b', oldNo: 2, newNo: 2 },
    ]);
    expect(buildDiffLines('', '')).toEqual([]);
  });

  it('returns null when the LCS matrix would be too large', () => {
    const big = Array.from({ length: 2000 }, (_, i) => `line${i}`).join('\n');
    expect(buildDiffLines(big, `${big}\nextra`)).toBeNull();
  });

  it('returns null when one side is huge even though the matrix is small', () => {
    const huge = Array.from({ length: 6000 }, (_, i) => `line${i}`).join('\n');
    expect(buildDiffLines('one line', huge)).toBeNull();
  });
});

describe('buildVerbatimDiffLines', () => {
  it('lists every old line as a deletion and every new line as an addition', () => {
    expect(buildVerbatimDiffLines('a\nb', 'B\nc\nd')).toEqual([
      { type: 'del', text: 'a', oldNo: 1 },
      { type: 'del', text: 'b', oldNo: 2 },
      { type: 'add', text: 'B', newNo: 1 },
      { type: 'add', text: 'c', newNo: 2 },
      { type: 'add', text: 'd', newNo: 3 },
    ]);
  });

  it('caps oversized sides with an omission marker row', () => {
    const huge = Array.from({ length: 6000 }, (_, i) => `line${i}`).join('\n');
    expect(buildDiffLines('one line', huge)).toBeNull();
    const rows = buildVerbatimDiffLines('one line', huge);
    expect(rows).toHaveLength(502);
    expect(rows[0]).toEqual({ type: 'del', text: 'one line', oldNo: 1 });
    expect(rows[1]).toEqual({ type: 'add', text: 'line0', newNo: 1 });
    expect(rows[500]).toEqual({ type: 'add', text: 'line499', newNo: 500 });
    expect(rows[501]).toEqual({ type: 'context', text: '… 5500 more lines …' });
  });

  it('truncates both sides when each exceeds the cap', () => {
    const big = (prefix: string) => Array.from({ length: 6000 }, (_, i) => `${prefix}${i}`).join('\n');
    const rows = buildVerbatimDiffLines(big('old'), big('new'));
    expect(rows).toHaveLength(1002);
    expect(rows[499]).toEqual({ type: 'del', text: 'old499', oldNo: 500 });
    expect(rows[500]).toEqual({ type: 'context', text: '… 5500 more lines …' });
    expect(rows[501]).toEqual({ type: 'add', text: 'new0', newNo: 1 });
    expect(rows[1001]).toEqual({ type: 'context', text: '… 5500 more lines …' });
  });

  it('returns empty for two empties', () => {
    expect(buildVerbatimDiffLines('', '')).toEqual([]);
  });
});

describe('buildEditDiffLines', () => {
  it('builds a diff for a single Edit', () => {
    const arg = JSON.stringify({ path: 'a.ts', old_string: 'a\nb', new_string: 'a\nB' });
    expect(buildEditDiffLines({ name: 'Edit', arg })).toEqual([
      { type: 'context', text: 'a', oldNo: 1, newNo: 1 },
      { type: 'del', text: 'b', oldNo: 2 },
      { type: 'add', text: 'B', newNo: 2 },
    ]);
  });

  it('falls back to output for replace_all edits', () => {
    const arg = JSON.stringify({ path: 'a.ts', old_string: 'a', new_string: 'b', replace_all: true });
    expect(buildEditDiffLines({ name: 'Edit', arg })).toBeNull();
  });

  it('falls back to output for oversized single-line edits (minified, base64)', () => {
    const huge = 'x'.repeat(100 * 1024 + 1);
    expect(buildEditDiffLines({ name: 'Edit', arg: JSON.stringify({ path: 'a.js', old_string: 'a', new_string: huge }) })).toBeNull();
    expect(buildEditDiffLines({ name: 'Edit', arg: JSON.stringify({ path: 'a.js', old_string: huge, new_string: 'b' }) })).toBeNull();
  });

  it('never builds a diff for Write (new file or overwrite)', () => {
    expect(buildEditDiffLines({ name: 'Write', arg: JSON.stringify({ path: 'a.ts', content: 'x' }) })).toBeNull();
    expect(
      buildEditDiffLines({ name: 'Write', arg: JSON.stringify({ path: 'a.ts', content: 'x', mode: 'append' }) }),
    ).toBeNull();
  });

  it('builds a concatenated diff for MultiEdit with hunk separators and continuous line numbers', () => {
    const arg = JSON.stringify({
      path: 'a.ts',
      edits: [
        { old_string: 'a\nb', new_string: 'a\nB' },
        { old_string: 'x', new_string: 'y' },
      ],
    });
    expect(buildEditDiffLines({ name: 'MultiEdit', arg })).toEqual([
      { type: 'context', text: 'a', oldNo: 1, newNo: 1 },
      { type: 'del', text: 'b', oldNo: 2 },
      { type: 'add', text: 'B', newNo: 2 },
      { type: 'hunk', text: '···' },
      { type: 'del', text: 'x', oldNo: 3 },
      { type: 'add', text: 'y', newNo: 3 },
    ]);
  });

  it('keeps continuous line numbers when a segment ends with a trailing newline', () => {
    const arg = JSON.stringify({
      path: 'a.ts',
      edits: [
        { old_string: 'a\n', new_string: 'A\n' },
        { old_string: 'x', new_string: 'y' },
      ],
    });
    expect(buildEditDiffLines({ name: 'MultiEdit', arg })).toEqual([
      { type: 'del', text: 'a', oldNo: 1 },
      { type: 'add', text: 'A', newNo: 1 },
      { type: 'hunk', text: '···' },
      { type: 'del', text: 'x', oldNo: 2 },
      { type: 'add', text: 'y', newNo: 2 },
    ]);
  });

  it('falls back to output for MultiEdit with replace_all segments', () => {
    const arg = JSON.stringify({
      path: 'a.ts',
      edits: [{ old_string: 'a', new_string: 'b', replace_all: true }],
    });
    expect(buildEditDiffLines({ name: 'MultiEdit', arg })).toBeNull();
  });

  it('returns null for non-edit/write tools', () => {
    expect(buildEditDiffLines({ name: 'Bash', arg: JSON.stringify({ command: 'ls' }) })).toBeNull();
  });
});

describe('toolFilePath', () => {
  it('reads the path from the usual keys', () => {
    expect(toolFilePath({ arg: JSON.stringify({ path: 'a.ts', content: 'x' }) })).toBe('a.ts');
    expect(toolFilePath({ arg: JSON.stringify({ file_path: 'b.ts', old_string: 'a', new_string: 'b' }) })).toBe(
      'b.ts',
    );
  });

  it('returns undefined when missing, empty, or unparseable', () => {
    expect(toolFilePath({ arg: JSON.stringify({ content: 'x' }) })).toBeUndefined();
    expect(toolFilePath({ arg: JSON.stringify({ path: '' }) })).toBeUndefined();
    expect(toolFilePath({ arg: 'not json' })).toBeUndefined();
  });
});

describe('parseReadOutput', () => {
  it('strips <number>\\t prefixes and keeps the real line numbers', () => {
    expect(parseReadOutput(['1\tconst a = 1', '2\t', '3\texport default a'])).toEqual({
      contents: ['const a = 1', '', 'export default a'],
      lineNumbers: [1, 2, 3],
    });
  });

  it('keeps tabs inside the content and honours the read offset', () => {
    expect(parseReadOutput(['10\tif (a) {\t', '11\t  b()\t}'])).toEqual({
      contents: ['if (a) {\t', '  b()\t}'],
      lineNumbers: [10, 11],
    });
  });

  it('returns null when any line misses the pattern, or the output is empty', () => {
    expect(parseReadOutput(['1\tok', 'not numbered'])).toBeNull();
    expect(parseReadOutput(['"a.bin" is not a text file.'])).toBeNull();
    expect(parseReadOutput([])).toBeNull();
    expect(parseReadOutput([''])).toBeNull();
  });

  it('drops one phantom trailing empty line from the result-string split', () => {
    expect(parseReadOutput(['1\tconst a = 1', '2\t', ''])).toEqual({
      contents: ['const a = 1', ''],
      lineNumbers: [1, 2],
    });
  });
});

describe('buildWriteContent', () => {
  it('extracts the Write content and path verbatim', () => {
    const arg = JSON.stringify({ path: 'a.ts', content: 'a\n\nb\n' });
    expect(buildWriteContent({ name: 'Write', arg })).toEqual({ content: 'a\n\nb\n', path: 'a.ts' });
  });

  it('reads the path from alias keys for language inference', () => {
    expect(buildWriteContent({ name: 'Write', arg: JSON.stringify({ file_path: 'b.ts', content: 'x' }) })).toEqual(
      { content: 'x', path: 'b.ts' },
    );
  });

  it('keeps the appended chunk for append mode and tolerates a missing path', () => {
    expect(
      buildWriteContent({ name: 'Write', arg: JSON.stringify({ content: 'x', mode: 'append' }) }),
    ).toEqual({ content: 'x', path: undefined });
    expect(buildWriteContent({ name: 'Write', arg: JSON.stringify({ path: 'a.ts', content: '' }) })).toEqual({
      content: '',
      path: 'a.ts',
    });
  });

  it('returns null for other tools or a missing/non-string content', () => {
    expect(buildWriteContent({ name: 'Edit', arg: JSON.stringify({ old_string: 'a', new_string: 'b' }) })).toBeNull();
    expect(buildWriteContent({ name: 'Write', arg: JSON.stringify({ path: 'a.ts' }) })).toBeNull();
    expect(buildWriteContent({ name: 'Write', arg: 'not json' })).toBeNull();
  });

  it('returns null when the content is too large to render inline', () => {
    const huge = Array.from({ length: 5001 }, (_, i) => `line${i}`).join('\n');
    expect(buildWriteContent({ name: 'Write', arg: JSON.stringify({ path: 'a.ts', content: huge }) })).toBeNull();
  });

  it('returns null for an oversized single line (minified bundle, base64)', () => {
    const oneHugeLine = 'x'.repeat(100 * 1024 + 1);
    expect(
      buildWriteContent({ name: 'Write', arg: JSON.stringify({ path: 'a.js', content: oneHugeLine }) }),
    ).toBeNull();
  });
});

describe('codeLanguageFromPath', () => {
  it('maps extensions and shiki aliases to languages', () => {
    expect(codeLanguageFromPath('src/a.ts')).toBe('ts');
    expect(codeLanguageFromPath('src/a.vue')).toBe('vue');
    expect(codeLanguageFromPath('ci/build.yml')).toBe('yml');
    expect(codeLanguageFromPath('C:\\repo\\main.py')).toBe('py');
  });

  it('maps well-known extensionless filenames', () => {
    expect(codeLanguageFromPath('Dockerfile')).toBe('dockerfile');
    expect(codeLanguageFromPath('apps/web/Makefile')).toBe('makefile');
  });

  it('returns undefined for unknown, extensionless, or dotfile paths', () => {
    expect(codeLanguageFromPath('.gitignore')).toBeUndefined();
    expect(codeLanguageFromPath('LICENSE')).toBeUndefined();
    expect(codeLanguageFromPath('notes.unknownext')).toBeUndefined();
    expect(codeLanguageFromPath(undefined)).toBeUndefined();
  });
});

describe('filePathLinks', () => {
  it('rejects URLs and bare unknown filenames', () => {
    expect(parseFilePathLinkCandidate('https://example.com/a.ts')).toBeNull();
    expect(parseFilePathLinkCandidate('e2e-success.png')).toBeNull();
  });

  it('finds path links with line numbers and resolves aliases', () => {
    const aliases = collectFilePathAliases('<img src="/assets/demo.png">');
    expect(aliases.get('demo.png')).toBe('/assets/demo.png');

    expect(
      findFilePathLinks('Open src/a.ts#L12 and demo.png.', { aliases }),
    ).toMatchObject([
      { path: 'src/a.ts', line: 12, text: 'src/a.ts#L12' },
      { path: '/assets/demo.png', text: 'demo.png' },
    ]);
  });
});

describe('toolMeta', () => {
  it('normalizes common tool aliases', () => {
    expect(normalizeToolName('WebFetch')).toBe('web_fetch');
    expect(normalizeToolName('MultiEdit')).toBe('multi_edit');
    expect(normalizeToolName('TodoWrite')).toBe('todo');
    expect(normalizeToolName('rg')).toBe('grep');
  });

  it('summarizes tool arguments for card headers', () => {
    expect(
      toolSummary('Read', JSON.stringify({ path: 'src/a.ts', offset: 10, limit: 5 })),
    ).toBe('src/a.ts:10-15');
    expect(toolSummary('Read', '{}')).toBe('');
    expect(toolSummary('Bash', JSON.stringify({ command: 'pnpm test' }))).toBe('pnpm test');
    expect(
      toolSummary('WebFetch', JSON.stringify({ url: 'https://example.com/path/to' })),
    ).toBe('example.com/path');
  });
});

describe('resolveToolRenderer', () => {
  const tool = (name: string, status: ToolCall['status'] = 'running'): ToolCall => ({
    id: 't1',
    name,
    arg: '',
    status,
  });

  it('routes Agent / subagent calls to the Agent renderer', () => {
    expect(resolveToolRenderer(tool('agent'))).toBe(AgentTool);
    expect(resolveToolRenderer(tool('Agent'))).toBe(AgentTool);
    expect(resolveToolRenderer(tool('subagent'))).toBe(AgentTool);
    expect(resolveToolRenderer(tool('task'))).toBe(AgentTool);
  });

  it('routes edit-like calls to the Edit renderer', () => {
    expect(resolveToolRenderer(tool('edit'))).toBe(EditTool);
    expect(resolveToolRenderer(tool('write'))).toBe(EditTool);
    expect(resolveToolRenderer(tool('multi_edit'))).toBe(EditTool);
  });

  it('routes bash / read calls to their bespoke renderers', () => {
    expect(resolveToolRenderer(tool('bash'))).toBe(BashTool);
    expect(resolveToolRenderer(tool('Bash'))).toBe(BashTool);
    expect(resolveToolRenderer(tool('shell'))).toBe(BashTool);
    expect(resolveToolRenderer(tool('read'))).toBe(ReadTool);
    expect(resolveToolRenderer(tool('Read'))).toBe(ReadTool);
  });

  it('routes cron calls to the Cron renderer', () => {
    expect(resolveToolRenderer(tool('CronCreate'))).toBe(CronTool);
    expect(resolveToolRenderer(tool('CronList'))).toBe(CronTool);
    expect(resolveToolRenderer(tool('CronDelete'))).toBe(CronTool);
  });

  it('routes select_tools to its specialized renderer in the shared registry', () => {
    expect(resolveToolRenderer(tool('select_tools'))).toBe(SelectToolsTool);
    expect(resolveToolRenderer(tool('select-tools'))).toBe(SelectToolsTool);
  });

  it('falls back to the Generic renderer for unknown tools', () => {
    expect(resolveToolRenderer(tool('some_future_tool'))).toBe(GenericTool);
  });
});

describe('createCoalescedAsyncRunner', () => {
  it('reuses the in-flight promise for the same key', async () => {
    let runs = 0;
    let resolveRun!: () => void;
    const runner = createCoalescedAsyncRunner(async (_key: string) => {
      runs += 1;
      await new Promise<void>((resolve) => {
        resolveRun = resolve;
      });
      return runs;
    });

    const first = runner.run('session-a');
    const second = runner.run('session-a');

    expect(runs).toBe(1);
    resolveRun();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 1]);
    expect(runs).toBe(1);
  });

  it('queues at most one rerun requested while a run is in flight', async () => {
    let runs = 0;
    const resolvers: Array<() => void> = [];
    const runner = createCoalescedAsyncRunner(async (_key: string) => {
      runs += 1;
      await new Promise<void>((resolve) => {
        resolvers.push(resolve);
      });
      return runs;
    });

    const first = runner.run('session-a');
    runner.request('session-a');
    runner.request('session-a');
    expect(runs).toBe(1);

    resolvers[0]!();
    await first;
    await Promise.resolve();

    expect(runs).toBe(2);
    resolvers[1]!();
    await Promise.resolve();
    expect(runs).toBe(2);
  });
});

describe('modelThinking', () => {
  const effortModel = (over: Partial<AppModel> = {}): AppModel => ({
    id: 'k',
    provider: 'p',
    model: 'k',
    maxContextSize: 1,
    capabilities: ['thinking'],
    supportEfforts: ['low', 'high', 'max'],
    defaultEffort: 'high',
    ...over,
  });
  const booleanModel = (capabilities: string[] = ['thinking']): AppModel => ({
    id: 'b',
    provider: 'p',
    model: 'b',
    maxContextSize: 1,
    capabilities,
  });
  const unsupportedModel = (): AppModel => ({
    id: 'u',
    provider: 'p',
    model: 'u',
    maxContextSize: 1,
    capabilities: [],
  });

  describe('modelThinkingAvailability', () => {
    it('toggle when model has thinking capability', () => {
      expect(modelThinkingAvailability(booleanModel())).toBe('toggle');
    });
    it('always-on when model has always_thinking', () => {
      expect(modelThinkingAvailability(booleanModel(['always_thinking']))).toBe('always-on');
    });
    it('unsupported when model lacks thinking capability', () => {
      expect(modelThinkingAvailability(unsupportedModel())).toBe('unsupported');
    });
    it('toggle when adaptiveThinking is set', () => {
      expect(modelThinkingAvailability({ ...unsupportedModel(), adaptiveThinking: true })).toBe('toggle');
    });
  });

  describe('defaultThinkingLevelFor', () => {
    it('effort model returns defaultEffort', () => {
      expect(defaultThinkingLevelFor(effortModel())).toBe('high');
    });
    it('effort model without defaultEffort returns middle effort', () => {
      expect(defaultThinkingLevelFor(effortModel({ defaultEffort: undefined }))).toBe('high');
    });
    it('boolean model returns on', () => {
      expect(defaultThinkingLevelFor(booleanModel())).toBe('on');
    });
    it('unsupported model returns off', () => {
      expect(defaultThinkingLevelFor(unsupportedModel())).toBe('off');
    });
  });

  describe('segmentsFor', () => {
    it('effort toggle → off + efforts (off left)', () => {
      expect(segmentsFor(effortModel())).toEqual(['off', 'low', 'high', 'max']);
    });
    it('effort always-on → efforts only (no off)', () => {
      expect(segmentsFor(effortModel({ capabilities: ['thinking', 'always_thinking'] }))).toEqual([
        'low',
        'high',
        'max',
      ]);
    });
    it('boolean toggle → on/off (on left)', () => {
      expect(segmentsFor(booleanModel())).toEqual(['on', 'off']);
    });
    it('boolean always-on → on', () => {
      expect(segmentsFor(booleanModel(['always_thinking']))).toEqual(['on']);
    });
    it('unsupported → off', () => {
      expect(segmentsFor(unsupportedModel())).toEqual(['off']);
    });
  });

  describe('commitLevel', () => {
    it('on normalizes to the model default', () => {
      expect(commitLevel(effortModel(), 'on')).toBe('high');
      expect(commitLevel(booleanModel(), 'on')).toBe('on');
    });
    it('off stays off', () => {
      expect(commitLevel(effortModel(), 'off')).toBe('off');
    });
    it('concrete effort passes through', () => {
      expect(commitLevel(effortModel(), 'max')).toBe('max');
    });
  });

  describe('effortLabel', () => {
    it('capitalizes the first letter', () => {
      expect(effortLabel('max')).toBe('Max');
      expect(effortLabel('off')).toBe('Off');
      expect(effortLabel('xhigh')).toBe('Xhigh');
    });
  });

  describe('levelDeclaredBy', () => {
    it('accepts levels selectable for the model', () => {
      expect(levelDeclaredBy(effortModel(), 'low')).toBe(true);
      expect(levelDeclaredBy(effortModel(), 'off')).toBe(true);
      expect(levelDeclaredBy(booleanModel(), 'on')).toBe(true);
      expect(levelDeclaredBy(booleanModel(['always_thinking']), 'on')).toBe(true);
    });
    it('rejects levels the model does not declare', () => {
      expect(levelDeclaredBy(booleanModel(), 'low')).toBe(false);
      expect(levelDeclaredBy(booleanModel(['always_thinking']), 'off')).toBe(false);
      expect(levelDeclaredBy(unsupportedModel(), 'max')).toBe(false);
    });
  });

  describe('thinkingLevelToConfig', () => {
    it('maps off/on to enabled only', () => {
      expect(thinkingLevelToConfig('off')).toEqual({ enabled: false });
      expect(thinkingLevelToConfig('on')).toEqual({ enabled: true });
    });
  });

  describe('thinkingLevelFromConfig', () => {
    it('returns undefined for a missing or malformed section', () => {
      expect(thinkingLevelFromConfig(undefined, effortModel())).toBeUndefined();
      expect(thinkingLevelFromConfig(null, effortModel())).toBeUndefined();
      expect(thinkingLevelFromConfig('nonsense', effortModel())).toBeUndefined();
    });
    it('resolves off only when the model can actually be turned off', () => {
      expect(thinkingLevelFromConfig({ enabled: false }, effortModel())).toBe('off');
      expect(
        thinkingLevelFromConfig({ enabled: false }, effortModel({ capabilities: ['thinking', 'always_thinking'] })),
      ).toBeUndefined();
    });
    it('resolves a stored effort only when the model still declares it', () => {
      expect(thinkingLevelFromConfig({ enabled: true, effort: 'low' }, effortModel())).toBe('low');
      expect(thinkingLevelFromConfig({ enabled: true, effort: 'ultra' }, effortModel())).toBeUndefined();
      expect(thinkingLevelFromConfig({ effort: 'low' }, booleanModel())).toBeUndefined();
    });
    it('returns undefined when enabled is true with no effort', () => {
      expect(thinkingLevelFromConfig({ enabled: true }, effortModel())).toBeUndefined();
    });
  });
});

describe('collapsePrompt', () => {
  it('keeps a short single-line prompt intact with no expand toggle', () => {
    expect(collapsePrompt('Check the deploy status')).toEqual({
      text: 'Check the deploy status',
      hasMore: false,
    });
  });

  it('truncates a long one-line prompt with an ellipsis and reports hasMore', () => {
    const long = 'a'.repeat(150);
    const result = collapsePrompt(long, 120);
    expect(result.hasMore).toBe(true);
    expect(result.text.length).toBeLessThan(long.length);
    expect(result.text.endsWith('…')).toBe(true);
  });

  it('shows only the first line for a multi-line prompt', () => {
    expect(collapsePrompt('first line\nsecond line\nthird line')).toEqual({
      text: 'first line',
      hasMore: true,
    });
  });
});
