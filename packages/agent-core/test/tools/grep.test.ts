import { Readable, type Writable } from 'node:stream';

import type { KaosProcess, StatResult } from '@moonshot-ai/kaos';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type GrepInput, GrepInputSchema, GrepTool } from '../../src/tools/builtin/file/grep';
import { SENSITIVE_DOT_VARIANT_SUFFIXES } from '../../src/tools/policies/sensitive';
import { ensureRgPath } from '../../src/tools/support/rg-locator';
import type { WorkspaceConfig } from '../../src/tools/support/workspace';
import { createFakeKaos, toolContentString } from './fixtures/fake-kaos';
import { executeTool } from './fixtures/execute-tool';
import { recordingTelemetry, type TelemetryRecord } from '../fixtures/telemetry';

vi.mock('../../src/tools/support/rg-locator', () => ({
  ensureRgPath: vi.fn(async () => ({ path: '/mock/rg', source: 'system-path' })),
  rgUnavailableMessage: (cause: unknown) =>
    `rg unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
}));

const signal = new AbortController().signal;
const workspace: WorkspaceConfig = { workspaceDir: '/workspace', additionalDirs: ['/extra'] };
// `--max-columns` is applied only outside `content` output mode, so it is kept
// as a separate segment: non-content modes use `DEFAULT_RG_ARGS`, while
// `content` mode uses `CONTENT_RG_ARGS` without the column cap.
const MAX_COLUMNS_RG_ARGS = ['--max-columns', '500'] as const;
const COMMON_RG_ARGS = [
  '--null',
  '--glob',
  '!.git',
  '--glob',
  '!.svn',
  '--glob',
  '!.hg',
  '--glob',
  '!.bzr',
  '--glob',
  '!.jj',
  '--glob',
  '!.sl',
] as const;
const DEFAULT_RG_ARGS = ['--hidden', ...MAX_COLUMNS_RG_ARGS, ...COMMON_RG_ARGS] as const;
const CONTENT_RG_ARGS = ['--hidden', ...COMMON_RG_ARGS] as const;
const SENSITIVE_KEY_BASENAMES = ['id_rsa', 'id_ed25519', 'id_ecdsa'] as const;
const SENSITIVE_KEY_RG_ARGS = SENSITIVE_KEY_BASENAMES.flatMap((basename) => [
  '--glob',
  `!**/${basename}`,
  '--glob',
  `!**/${basename}[-_]*`,
  ...SENSITIVE_DOT_VARIANT_SUFFIXES.flatMap((suffix) => [
    '--glob',
    `!**/${basename}${suffix}`,
  ]),
]);
const SENSITIVE_RG_ARGS = [
  '--glob',
  '!**/.env',
  ...SENSITIVE_KEY_RG_ARGS,
  '--glob',
  '!**/.aws/credentials',
  '--glob',
  '!**/.aws/credentials/**',
  '--glob',
  '!**/.gcp/credentials',
  '--glob',
  '!**/.gcp/credentials/**',
] as const;

function processWithOutput(stdout: string, stderr = '', exitCode = 0): KaosProcess {
  const stdoutStream = Readable.from([stdout]);
  const stderrStream = Readable.from([stderr]);
  return {
    stdin: { end: vi.fn(), write: vi.fn() } as unknown as Writable,
    stdout: stdoutStream,
    stderr: stderrStream,
    pid: 123,
    exitCode,
    wait: vi.fn().mockResolvedValue(exitCode),
    kill: vi.fn(async () => {}),
    dispose: vi.fn(async () => {
      stdoutStream.destroy();
      stderrStream.destroy();
    }),
  };
}

function statResult(mtime: number): StatResult {
  return {
    stMode: 0o100000,
    stIno: 1,
    stDev: 1,
    stNlink: 1,
    stUid: 0,
    stGid: 0,
    stSize: 0,
    stAtime: mtime,
    stMtime: mtime,
    stCtime: mtime,
  };
}

function processThatExitsOnKill(stdout: string, stderr = '', exitCode = 143): KaosProcess {
  let currentExitCode: number | null = null;
  let resolveWait: (code: number) => void;
  const waitPromise = new Promise<number>((resolve) => {
    resolveWait = resolve;
  });
  const stdoutStream = Readable.from(stdout === '' ? [] : [stdout]);
  const stderrStream = Readable.from(stderr === '' ? [] : [stderr]);

  return {
    stdin: { end: vi.fn(), write: vi.fn() } as unknown as Writable,
    stdout: stdoutStream,
    stderr: stderrStream,
    pid: 123,
    get exitCode() {
      return currentExitCode;
    },
    wait: vi.fn(() => waitPromise),
    kill: vi.fn(async () => {
      currentExitCode = exitCode;
      resolveWait(exitCode);
    }),
    dispose: vi.fn(async () => {
      stdoutStream.destroy();
      stderrStream.destroy();
    }),
  };
}

function context(args: GrepInput, abortSignal = signal) {
  return { turnId: '0', toolCallId: 'call_grep', args, signal: abortSignal };
}

function nullRecord(filePath: string, payload = ''): string {
  return `${filePath}\0${payload}`;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('GrepTool', () => {
  it('exposes current metadata and schema', () => {
    const tool = new GrepTool(createFakeKaos(), workspace);

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
  });

  describe('output_mode enum value', () => {
    it('accepts count_matches as the third output mode', () => {
      expect(
        GrepInputSchema.safeParse({ pattern: 'needle', output_mode: 'count_matches' }).success,
      ).toBe(true);
    });

    it('rejects the legacy count value', () => {
      expect(
        GrepInputSchema.safeParse({ pattern: 'needle', output_mode: 'count' }).success,
      ).toBe(false);
    });

    it('exposes count_matches and not count in the JSON Schema enum', () => {
      const tool = new GrepTool(createFakeKaos(), workspace);
      const params = tool.parameters as {
        properties: { output_mode: { enum?: string[] } };
      };
      const enumValues = params.properties.output_mode.enum ?? [];
      expect(enumValues).toContain('count_matches');
      expect(enumValues).not.toContain('count');
    });
  });

  describe('parameter descriptions', () => {
    it('gives every documented parameter a non-empty description', () => {
      const tool = new GrepTool(createFakeKaos(), workspace);
      const params = tool.parameters as {
        properties: Record<string, { description?: string }>;
      };
      const documented = [
        'output_mode',
        '-i',
        '-n',
        '-A',
        '-B',
        '-C',
        'offset',
        'multiline',
        'include_ignored',
      ];
      for (const name of documented) {
        const description = params.properties[name]?.description;
        expect(description, `${name} should have a description`).toBeTruthy();
        expect(
          (description ?? '').trim().length,
          `${name} description should be non-empty`,
        ).toBeGreaterThan(0);
      }
    });

    it('notes that context flags require content output mode', () => {
      const tool = new GrepTool(createFakeKaos(), workspace);
      const params = tool.parameters as {
        properties: Record<string, { description?: string }>;
      };
      for (const name of ['-A', '-B', '-C', '-n']) {
        expect(params.properties[name]?.description).toContain('content');
      }
    });

    it('mentions count_matches in the output_mode description', () => {
      const tool = new GrepTool(createFakeKaos(), workspace);
      const params = tool.parameters as {
        properties: Record<string, { description?: string }>;
      };
      expect(params.properties['output_mode']?.description).toContain('count_matches');
      // count_matches emits per-file `path:count`, not a single total (grep.ts).
      expect(params.properties['output_mode']?.description).toContain('per-file');
    });

    it('documents that files_with_matches is ordered most-recently-modified first', () => {
      const tool = new GrepTool(createFakeKaos(), workspace);
      const params = tool.parameters as {
        properties: Record<string, { description?: string }>;
      };
      // grep.ts sorts files_with_matches by mtime descending (b.mtime - a.mtime).
      expect(params.properties['output_mode']?.description).toContain('most-recently-modified');
    });

    it('does not present an absolute path as a hard requirement for path', () => {
      const tool = new GrepTool(createFakeKaos(), workspace);
      const params = tool.parameters as {
        properties: Record<string, { description?: string }>;
      };
      const description = params.properties['path']?.description ?? '';
      expect(description).not.toMatch(/^Absolute path/);
      expect(description.toLowerCase()).toContain('relative');
    });

    it('guides type as the more efficient filter over glob', () => {
      const tool = new GrepTool(createFakeKaos(), workspace);
      const params = tool.parameters as {
        properties: Record<string, { description?: string }>;
      };
      const description = params.properties['type']?.description ?? '';
      expect(description).toContain('glob');
      expect(description).toContain('efficient');
    });

    it('describes include_ignored as covering all ignore files, not just .gitignore', () => {
      const tool = new GrepTool(createFakeKaos(), workspace);
      const params = tool.parameters as {
        properties: Record<string, { description?: string }>;
      };
      const description = params.properties['include_ignored']?.description ?? '';
      expect(description).toContain('.gitignore');
      expect(description).toContain('.ignore');
      expect(description).toContain('.rgignore');
    });
  });

  describe('prompt content', () => {
    it('explains ripgrep regex syntax and brace escaping', () => {
      const tool = new GrepTool(createFakeKaos(), workspace);
      expect(tool.description).toContain('ripgrep');
      expect(tool.description).toContain('\\{');
    });

    it('explains hidden files, include_ignored, and sensitive-file behavior', () => {
      const tool = new GrepTool(createFakeKaos(), workspace);
      expect(tool.description).toContain('include_ignored');
      expect(tool.description.toLowerCase()).toContain('hidden file');
      expect(tool.description).toContain('.env');
    });
  });

  it('searches only the current workspace when path is omitted', async () => {
    const exec = vi.fn().mockResolvedValue(processWithOutput('/workspace/src/a.ts\n'));
    const tool = new GrepTool(createFakeKaos({ exec }), workspace);

    const result = await executeTool(tool, context({ pattern: 'hit' }));

    expect(exec).toHaveBeenCalledWith(
      '/mock/rg',
      ...DEFAULT_RG_ARGS,
      '-l',
      ...SENSITIVE_RG_ARGS,
      '--',
      'hit',
      '/workspace',
    );
    expect(result.output).toBe('src/a.ts');
  });

  it('can search an additional directory when path is explicit', async () => {
    const exec = vi.fn().mockResolvedValue(processWithOutput('/extra/pkg/b.ts\n'));
    const tool = new GrepTool(createFakeKaos({ exec }), workspace);

    const result = await executeTool(tool, context({ pattern: 'hit', path: '/extra' }));

    expect(exec).toHaveBeenCalledWith(
      '/mock/rg',
      ...DEFAULT_RG_ARGS,
      '-l',
      ...SENSITIVE_RG_ARGS,
      '--',
      'hit',
      '/extra',
    );
    expect(result.output).toBe('/extra/pkg/b.ts');
  });

  it('keeps non-workspace grep result paths absolute in content and count modes', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce(processWithOutput('/extra/pkg/b.ts:10:hit\n'))
      .mockResolvedValueOnce(processWithOutput('/extra/pkg/b.ts:2\n'));
    const tool = new GrepTool(createFakeKaos({ exec }), workspace);

    const contentResult = await executeTool(tool,
      context({ pattern: 'hit', path: '/extra', output_mode: 'content' }),
    );
    const countResult = await executeTool(tool,
      context({ pattern: 'hit', path: '/extra', output_mode: 'count_matches' }),
    );

    expect(toolContentString(contentResult)).toBe('/extra/pkg/b.ts:10:hit');
    expect(toolContentString(countResult)).toBe(
      ['Found 2 total occurrences across 1 file.', '/extra/pkg/b.ts:2'].join('\n'),
    );
  });

  it('returns an explicit non-sensitive message when ripgrep finds no matches', async () => {
    const exec = vi.fn().mockResolvedValue(processWithOutput('', '', 1));
    const tool = new GrepTool(createFakeKaos({ exec }), workspace);

    const result = await executeTool(tool, context({ pattern: 'missing' }));

    expect(result.output).toBe('No non-sensitive matches found');
  });

  it('sorts files_with_matches by mtime before pagination after sensitive filtering', async () => {
    const stdout = ['/workspace/src/old.ts', '/workspace/.env', '/workspace/src/new.ts', ''].join(
      '\n',
    );
    const stat = vi.fn(async (path: string) => {
      if (path === '/workspace/src/new.ts') return statResult(10);
      if (path === '/workspace/src/old.ts') return statResult(1);
      throw new Error(`unexpected stat: ${path}`);
    });
    const tool = new GrepTool(
      createFakeKaos({ exec: vi.fn().mockResolvedValue(processWithOutput(stdout)), stat }),
      { workspaceDir: '/workspace', additionalDirs: [] },
    );

    const result = await executeTool(tool, context({ pattern: 'hit', head_limit: 1 }));

    expect(toolContentString(result)).toBe(
      [
        'src/new.ts',
        'Filtered 1 sensitive file(s): .env',
        'Results truncated to 1 lines (total: 2). Use offset=1 to see more.',
      ].join('\n'),
    );
    expect(stat).toHaveBeenCalledTimes(2);
    expect(stat).toHaveBeenCalledWith('/workspace/src/old.ts');
    expect(stat).toHaveBeenCalledWith('/workspace/src/new.ts');
  });

  it('limits concurrent mtime stats while sorting files_with_matches', async () => {
    const filePaths = Array.from(
      { length: 40 },
      (_, index) => `/workspace/src/file-${String(index).padStart(2, '0')}.ts`,
    );
    let activeStats = 0;
    let maxActiveStats = 0;
    const stat = vi.fn(async (path: string) => {
      activeStats += 1;
      maxActiveStats = Math.max(maxActiveStats, activeStats);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      activeStats -= 1;
      const mtime = Number(path.match(/file-(\d+)\.ts$/)?.[1] ?? 0);
      return statResult(mtime);
    });
    const tool = new GrepTool(
      createFakeKaos({
        exec: vi.fn().mockResolvedValue(processWithOutput(`${filePaths.join('\n')}\n`)),
        stat,
      }),
      { workspaceDir: '/workspace', additionalDirs: [] },
    );

    const result = await executeTool(tool, context({ pattern: 'hit', head_limit: 0 }));
    const lines = toolContentString(result).split('\n');

    expect(stat).toHaveBeenCalledTimes(filePaths.length);
    expect(maxActiveStats).toBeLessThanOrEqual(32);
    expect(lines.at(0)).toBe('src/file-39.ts');
    expect(lines.at(-1)).toBe('src/file-00.ts');
  });

  it('stops scheduling mtime stats when aborted during files_with_matches sorting', async () => {
    const filePaths = Array.from(
      { length: 40 },
      (_, index) => `/workspace/src/file-${String(index).padStart(2, '0')}.ts`,
    );
    const abortController = new AbortController();
    const stat = vi.fn(async () => {
      abortController.abort();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      return statResult(1);
    });
    const tool = new GrepTool(
      createFakeKaos({
        exec: vi.fn().mockResolvedValue(processWithOutput(`${filePaths.join('\n')}\n`)),
        stat,
      }),
      { workspaceDir: '/workspace', additionalDirs: [] },
    );

    const result = await executeTool(tool,
      context({ pattern: 'hit', head_limit: 0 }, abortController.signal),
    );

    expect(result).toMatchObject({ isError: true, output: 'Grep aborted' });
    expect(stat.mock.calls.length).toBeLessThan(filePaths.length);
  });

  it('keeps files_with_matches entries when mtime stat fails', async () => {
    const stdout = [
      '/workspace/src/old.ts',
      '/workspace/src/missing.ts',
      '/workspace/src/new.ts',
      '',
    ].join('\n');
    const stat = vi.fn(async (path: string) => {
      if (path === '/workspace/src/new.ts') return statResult(10);
      if (path === '/workspace/src/old.ts') return statResult(1);
      throw new Error('stat failed');
    });
    const tool = new GrepTool(
      createFakeKaos({ exec: vi.fn().mockResolvedValue(processWithOutput(stdout)), stat }),
      { workspaceDir: '/workspace', additionalDirs: [] },
    );

    const result = await executeTool(tool, context({ pattern: 'hit', head_limit: 0 }));

    expect(toolContentString(result)).toBe(
      ['src/new.ts', 'src/old.ts', 'src/missing.ts'].join('\n'),
    );
  });

  it('uses count-matches and ignores context flags outside content output mode', async () => {
    const exec = vi.fn().mockResolvedValue(processWithOutput('/workspace/src/a.ts:2\n'));
    const tool = new GrepTool(createFakeKaos({ exec }), workspace);

    await executeTool(tool,
      context({ pattern: 'hit', output_mode: 'count_matches', '-A': 2, '-B': 3, '-C': 4 }),
    );

    expect(exec).toHaveBeenCalledWith(
      '/mock/rg',
      ...DEFAULT_RG_ARGS,
      '--count-matches',
      '--with-filename',
      ...SENSITIVE_RG_ARGS,
      '--',
      'hit',
      '/workspace',
    );
  });

  it('retries EAGAIN ripgrep failures with a single-threaded search', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce(
        processWithOutput('', 'rg: failed to spawn worker: Resource temporarily unavailable\n', 2),
      )
      .mockResolvedValueOnce(processWithOutput('/workspace/src/a.ts\n'));
    const tool = new GrepTool(createFakeKaos({ exec }), workspace);

    const result = await executeTool(tool, context({ pattern: 'hit' }));

    expect(toolContentString(result)).toBe('src/a.ts');
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls[0]).not.toContain('-j');
    expect(exec).toHaveBeenNthCalledWith(
      2,
      '/mock/rg',
      '-j',
      '1',
      ...DEFAULT_RG_ARGS,
      '-l',
      ...SENSITIVE_RG_ARGS,
      '--',
      'hit',
      '/workspace',
    );
  });

  it('passes public ripgrep flags through argv', async () => {
    const exec = vi.fn().mockResolvedValue(processWithOutput('/workspace/src/a.ts\n'));
    const tool = new GrepTool(createFakeKaos({ exec }), workspace);

    await executeTool(tool,
      context({
        pattern: 'hit',
        '-i': true,
        type: 'ts',
        multiline: true,
        include_ignored: true,
      }),
    );

    expect(exec).toHaveBeenCalledWith(
      '/mock/rg',
      ...DEFAULT_RG_ARGS,
      '-l',
      '-i',
      '--type',
      'ts',
      '-U',
      '--multiline-dotall',
      '--no-ignore',
      ...SENSITIVE_RG_ARGS,
      '--',
      'hit',
      '/workspace',
    );
  });

  it('gives -C precedence over before and after context in content mode', async () => {
    const exec = vi.fn().mockResolvedValue(processWithOutput('/workspace/src/a.ts:2:hit\n'));
    const tool = new GrepTool(createFakeKaos({ exec }), workspace);

    await executeTool(tool,
      context({ pattern: 'hit', output_mode: 'content', '-A': 2, '-B': 3, '-C': 4 }),
    );

    expect(exec).toHaveBeenCalledWith(
      '/mock/rg',
      ...CONTENT_RG_ARGS,
      '--with-filename',
      '-n',
      '-C',
      '4',
      ...SENSITIVE_RG_ARGS,
      '--',
      'hit',
      '/workspace',
    );
  });

  describe('column cap by output mode', () => {
    it('does not cap columns in content output mode so long matching lines are returned in full', async () => {
      const exec = vi.fn().mockResolvedValue(processWithOutput('/workspace/src/a.ts:1:hit\n'));
      const tool = new GrepTool(createFakeKaos({ exec }), workspace);

      await executeTool(tool, context({ pattern: 'hit', output_mode: 'content' }));

      const [, ...args] = exec.mock.calls[0] ?? [];
      expect(args).not.toContain('--max-columns');
    });

    it('caps columns in files_with_matches output mode', async () => {
      const exec = vi.fn().mockResolvedValue(processWithOutput('/workspace/src/a.ts\n'));
      const tool = new GrepTool(createFakeKaos({ exec }), workspace);

      await executeTool(tool, context({ pattern: 'hit' }));

      const [, ...args] = exec.mock.calls[0] ?? [];
      expect(args).toContain('--max-columns');
    });

    it('caps columns in count_matches output mode', async () => {
      const exec = vi.fn().mockResolvedValue(processWithOutput('/workspace/src/a.ts:2\n'));
      const tool = new GrepTool(createFakeKaos({ exec }), workspace);

      await executeTool(tool, context({ pattern: 'hit', output_mode: 'count_matches' }));

      const [, ...args] = exec.mock.calls[0] ?? [];
      expect(args).toContain('--max-columns');
    });
  });

  it('rejects relative path escapes before spawning ripgrep', async () => {
    const exec = vi.fn();
    const tool = new GrepTool(createFakeKaos({ exec }), {
      workspaceDir: '/workspace/project',
      additionalDirs: [],
    });

    const result = await executeTool(tool, context({ pattern: 'hit', path: '../outside' }));

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('absolute path');
    expect(exec).not.toHaveBeenCalled();
  });

  it('appends sensitive prefilter globs after user glob filters', async () => {
    const exec = vi.fn().mockResolvedValue(processWithOutput(nullRecord('/workspace/src/main.ts')));
    const tool = new GrepTool(createFakeKaos({ exec }), workspace);

    const result = await executeTool(tool, context({ pattern: 'hit', glob: '**/.env' }));

    expect(exec).toHaveBeenCalledWith(
      '/mock/rg',
      ...DEFAULT_RG_ARGS,
      '-l',
      '--glob',
      '**/.env',
      ...SENSITIVE_RG_ARGS,
      '--',
      'hit',
      '/workspace',
    );
    expect(toolContentString(result)).toBe('src/main.ts');
  });

  it('does not prefilter public key files that the sensitive policy allows', async () => {
    const stdout = [
      '/workspace/id_rsa.pub:1:ssh-rsa hit',
      '/workspace/id_ed25519.pub:1:ssh-ed25519 hit',
      '/workspace/id_ecdsa.pub:1:ecdsa-sha2 hit',
      '',
    ].join('\n');
    const exec = vi.fn().mockResolvedValue(processWithOutput(stdout));
    const tool = new GrepTool(createFakeKaos({ exec }), workspace);

    const result = await executeTool(tool, context({ pattern: 'hit', output_mode: 'content' }));

    const [, ...args] = exec.mock.calls[0] ?? [];
    expect(args).not.toContain('--glob !**/id_rsa[-_.]*');
    expect(args).not.toContain('!**/id_rsa[-_.]*');
    expect(args).not.toContain('!**/id_ed25519[-_.]*');
    expect(args).not.toContain('!**/id_ecdsa[-_.]*');
    expect(args).not.toContain('!**/id_rsa.pub');
    expect(args).not.toContain('!**/id_ed25519.pub');
    expect(args).not.toContain('!**/id_ecdsa.pub');
    expect(toolContentString(result)).toContain('id_rsa.pub:1:ssh-rsa hit');
    expect(toolContentString(result)).toContain('id_ed25519.pub:1:ssh-ed25519 hit');
    expect(toolContentString(result)).toContain('id_ecdsa.pub:1:ecdsa-sha2 hit');
    expect(toolContentString(result)).not.toContain('Filtered ');
  });

  it('filters sensitive files from content output and appends a warning', async () => {
    const stdout = ['/workspace/src/main.ts:10:hit', '/workspace/.env:1:SECRET=hit', ''].join('\n');
    const exec = vi.fn().mockResolvedValue(processWithOutput(stdout));
    const tool = new GrepTool(createFakeKaos({ exec }), workspace);

    const result = await executeTool(tool, context({ pattern: 'hit', output_mode: 'content' }));

    expect(exec).toHaveBeenCalledWith(
      '/mock/rg',
      ...CONTENT_RG_ARGS,
      '--with-filename',
      '-n',
      ...SENSITIVE_RG_ARGS,
      '--',
      'hit',
      '/workspace',
    );
    expect(result.output).toContain('src/main.ts:10:hit');
    expect(result.output).not.toContain('SECRET=hit');
    expect(result.output).toContain('Filtered 1 sensitive file(s): .env');
  });

  it('uses null-delimited content paths for sensitive filtering', async () => {
    const stdout =
      [
        nullRecord('/workspace/foo-10-/.aws/credentials', '1:SECRET=hit'),
        nullRecord('/workspace/foo:10:/.aws/credentials', '1:SECRET=hit'),
        nullRecord('/workspace/src/main.ts', '1:hit'),
      ].join('\n') + '\n';
    const exec = vi.fn().mockResolvedValue(processWithOutput(stdout));
    const tool = new GrepTool(createFakeKaos({ exec }), workspace);

    const result = await executeTool(tool, context({ pattern: 'hit', output_mode: 'content' }));

    expect(toolContentString(result)).toBe(
      [
        'src/main.ts:1:hit',
        'Filtered 2 sensitive file(s): foo-10-/.aws/credentials, foo:10:/.aws/credentials',
      ].join('\n'),
    );
  });

  it('reconstructs null-delimited content context separators for display', async () => {
    const stdout =
      [
        nullRecord('/workspace/src/main.ts', '1-before'),
        nullRecord('/workspace/src/main.ts', '2:hit'),
        nullRecord('/workspace/src/main.ts', '3-after'),
      ].join('\n') + '\n';
    const exec = vi.fn().mockResolvedValue(processWithOutput(stdout));
    const tool = new GrepTool(createFakeKaos({ exec }), workspace);

    const result = await executeTool(tool, context({ pattern: 'hit', output_mode: 'content', '-C': 1 }));

    expect(toolContentString(result)).toBe(
      ['src/main.ts-1-before', 'src/main.ts:2:hit', 'src/main.ts-3-after'].join('\n'),
    );
  });

  it('uses a colon for null-delimited content display when line numbers are disabled', async () => {
    const stdout = `${nullRecord('/workspace/src/main.ts', '123-hello')}\n`;
    const exec = vi.fn().mockResolvedValue(processWithOutput(stdout));
    const tool = new GrepTool(createFakeKaos({ exec }), workspace);

    const result = await executeTool(tool,
      context({ pattern: '123', output_mode: 'content', '-n': false }),
    );

    expect(toolContentString(result)).toBe('src/main.ts:123-hello');
  });

  it('passes through bracketed payload text in content and context lines unchanged', async () => {
    const stdout = [
      '/workspace/src/main.ts:1:[a bracketed payload]',
      '/workspace/src/main.ts-2-[a bracketed context payload]',
      '',
    ].join('\n');
    const exec = vi.fn().mockResolvedValue(processWithOutput(stdout));
    const tool = new GrepTool(createFakeKaos({ exec }), workspace);

    const result = await executeTool(tool, context({ pattern: 'hit', output_mode: 'content', '-C': 1 }));

    expect(exec).toHaveBeenCalledWith(
      '/mock/rg',
      ...CONTENT_RG_ARGS,
      '--with-filename',
      '-n',
      '-C',
      '1',
      ...SENSITIVE_RG_ARGS,
      '--',
      'hit',
      '/workspace',
    );
    expect(toolContentString(result)).toBe(
      [
        'src/main.ts:1:[a bracketed payload]',
        'src/main.ts-2-[a bracketed context payload]',
      ].join('\n'),
    );
  });

  it('filters sensitive files even when content payloads contain bracketed text', async () => {
    const stdout = [
      '/workspace/.env:1:[a bracketed payload]',
      '/workspace/.env-2-[a bracketed context payload]',
      '--',
      '/workspace/src/main.ts:1:hit',
      '',
    ].join('\n');
    const exec = vi.fn().mockResolvedValue(processWithOutput(stdout));
    const tool = new GrepTool(createFakeKaos({ exec }), workspace);

    const result = await executeTool(tool, context({ pattern: 'hit', output_mode: 'content', '-C': 1 }));

    expect(toolContentString(result)).toBe(
      ['src/main.ts:1:hit', 'Filtered 1 sensitive file(s): .env'].join('\n'),
    );
  });

  it('preserves content lines that look like workspace paths when no grep path prefix is present', async () => {
    const exec = vi.fn().mockResolvedValue(processWithOutput('/workspace/not-a-path\n'));
    const tool = new GrepTool(createFakeKaos({ exec }), workspace);

    const result = await executeTool(tool, context({ pattern: 'workspace', output_mode: 'content' }));

    expect(exec).toHaveBeenCalledWith(
      '/mock/rg',
      ...CONTENT_RG_ARGS,
      '--with-filename',
      '-n',
      ...SENSITIVE_RG_ARGS,
      '--',
      'workspace',
      '/workspace',
    );
    expect(result.output).toBe('/workspace/not-a-path');
  });

  it('uses the backend path class when filtering sensitive grep results', async () => {
    const stdout = [
      'C:\\workspace\\src\\main.ts:10:hit',
      'C:\\workspace\\.env:1:SECRET=hit',
      '',
    ].join('\n');
    const exec = vi.fn().mockResolvedValue(processWithOutput(stdout));
    const tool = new GrepTool(createFakeKaos({ exec, pathClass: () => 'win32' }), {
      workspaceDir: 'C:\\workspace',
      additionalDirs: [],
    });

    const result = await executeTool(tool, context({ pattern: 'hit', output_mode: 'content' }));

    expect(result.output).toContain('src/main.ts:10:hit');
    expect(result.output).not.toContain('SECRET=hit');
    expect(result.output).toContain('Filtered 1 sensitive file(s): .env');
  });

  it('uses the backend path class for Windows content output without line numbers', async () => {
    const stdout = [
      'C:\\workspace\\src\\main.ts:hit',
      'C:\\workspace\\.aws\\credentials:SECRET=hit',
      '',
    ].join('\n');
    const exec = vi.fn().mockResolvedValue(processWithOutput(stdout));
    const tool = new GrepTool(createFakeKaos({ exec, pathClass: () => 'win32' }), {
      workspaceDir: 'C:\\workspace',
      additionalDirs: [],
    });

    const result = await executeTool(tool,
      context({ pattern: 'hit', output_mode: 'content', '-n': false }),
    );

    expect(exec).toHaveBeenCalledWith(
      '/mock/rg',
      ...CONTENT_RG_ARGS,
      '--with-filename',
      '--field-context-separator',
      ':',
      ...SENSITIVE_RG_ARGS,
      '--',
      'hit',
      'C:\\workspace',
    );
    expect(toolContentString(result)).toBe(
      ['src/main.ts:hit', 'Filtered 1 sensitive file(s): .aws/credentials'].join('\n'),
    );
  });

  it('uses null-delimited Windows content paths for sensitive filtering', async () => {
    const stdout =
      [
        nullRecord('C:\\workspace\\foo-10-\\.aws\\credentials', '1:SECRET=hit'),
        nullRecord('C:\\workspace\\src\\main.ts', '1:hit'),
      ].join('\n') + '\n';
    const exec = vi.fn().mockResolvedValue(processWithOutput(stdout));
    const tool = new GrepTool(createFakeKaos({ exec, pathClass: () => 'win32' }), {
      workspaceDir: 'C:\\workspace',
      additionalDirs: [],
    });

    const result = await executeTool(tool, context({ pattern: 'hit', output_mode: 'content' }));

    expect(toolContentString(result)).toBe(
      ['src/main.ts:1:hit', 'Filtered 1 sensitive file(s): foo-10-/.aws/credentials'].join('\n'),
    );
  });

  it('filters sensitive context lines when content output omits line numbers', async () => {
    const stdout = [
      '/workspace/.env:SECRET before',
      '/workspace/.env:SECRET=hit',
      '/workspace/.env:SECRET after',
      '--',
      '/workspace/src/main.ts:before',
      '/workspace/src/main.ts:hit',
      '/workspace/src/main.ts:after',
      '',
    ].join('\n');
    const exec = vi.fn().mockResolvedValue(processWithOutput(stdout));
    const tool = new GrepTool(createFakeKaos({ exec }), workspace);

    const result = await executeTool(tool,
      context({ pattern: 'hit', output_mode: 'content', '-n': false, '-C': 1 }),
    );

    expect(exec).toHaveBeenCalledWith(
      '/mock/rg',
      ...CONTENT_RG_ARGS,
      '--with-filename',
      '--field-context-separator',
      ':',
      '-C',
      '1',
      ...SENSITIVE_RG_ARGS,
      '--',
      'hit',
      '/workspace',
    );
    expect(toolContentString(result)).toBe(
      [
        'src/main.ts:before',
        'src/main.ts:hit',
        'src/main.ts:after',
        'Filtered 1 sensitive file(s): .env',
      ].join('\n'),
    );
  });

  it('filters Windows sensitive context lines when content output omits line numbers', async () => {
    const stdout = [
      'C:\\workspace\\.aws\\credentials:SECRET before',
      'C:\\workspace\\.aws\\credentials:SECRET=hit',
      'C:\\workspace\\.aws\\credentials:SECRET after',
      '--',
      'C:\\workspace\\src\\main.ts:before',
      'C:\\workspace\\src\\main.ts:hit',
      'C:\\workspace\\src\\main.ts:after',
      '',
    ].join('\n');
    const exec = vi.fn().mockResolvedValue(processWithOutput(stdout));
    const tool = new GrepTool(createFakeKaos({ exec, pathClass: () => 'win32' }), {
      workspaceDir: 'C:\\workspace',
      additionalDirs: [],
    });

    const result = await executeTool(tool,
      context({ pattern: 'hit', output_mode: 'content', '-n': false, '-C': 1 }),
    );

    expect(exec).toHaveBeenCalledWith(
      '/mock/rg',
      ...CONTENT_RG_ARGS,
      '--with-filename',
      '--field-context-separator',
      ':',
      '-C',
      '1',
      ...SENSITIVE_RG_ARGS,
      '--',
      'hit',
      'C:\\workspace',
    );
    expect(toolContentString(result)).toBe(
      [
        'src/main.ts:before',
        'src/main.ts:hit',
        'src/main.ts:after',
        'Filtered 1 sensitive file(s): .aws/credentials',
      ].join('\n'),
    );
  });

  it('explains when every grep result is filtered as sensitive', async () => {
    const stdout = ['/workspace/.env:1:SECRET=hit', '/workspace/.aws/credentials:2:hit', ''].join(
      '\n',
    );
    const exec = vi.fn().mockResolvedValue(processWithOutput(stdout));
    const tool = new GrepTool(createFakeKaos({ exec }), {
      workspaceDir: '/workspace',
      additionalDirs: [],
    });

    const result = await executeTool(tool, context({ pattern: 'hit', output_mode: 'content' }));

    expect(toolContentString(result)).toBe(
      [
        'No non-sensitive matches found',
        'Filtered 2 sensitive file(s): .env, .aws/credentials',
      ].join('\n'),
    );
  });

  it('normalizes content separators after filtering sensitive grep results', async () => {
    const stdout = [
      '/workspace/.env:1:SECRET=hit',
      '--',
      '/workspace/src/main.ts:10:hit',
      '--',
      '/workspace/.aws/credentials:1:hit',
      '--',
      '/workspace/src/other.ts:7:hit',
      '--',
      '/workspace/credentials:1:hit',
      '',
    ].join('\n');
    const exec = vi.fn().mockResolvedValue(processWithOutput(stdout));
    const tool = new GrepTool(createFakeKaos({ exec }), {
      workspaceDir: '/workspace',
      additionalDirs: [],
    });

    const result = await executeTool(tool, context({ pattern: 'hit', output_mode: 'content' }));

    const output = toolContentString(result);
    const content = output.split('\nFiltered ')[0] ?? output;
    expect(content).toBe(['src/main.ts:10:hit', '--', 'src/other.ts:7:hit'].join('\n'));
    expect(output).not.toContain('SECRET=hit');
    expect(output).toContain('Filtered 3 sensitive file(s): .env, .aws/credentials, credentials');
  });

  it('applies offset and head_limit after rg output is collected', async () => {
    const stdout = ['a.ts:1:hit', 'b.ts:2:hit', 'c.ts:3:hit', 'd.ts:4:hit', ''].join('\n');
    const tool = new GrepTool(
      createFakeKaos({ exec: vi.fn().mockResolvedValue(processWithOutput(stdout)) }),
      { workspaceDir: '/workspace', additionalDirs: [] },
    );

    const result = await executeTool(tool,
      context({ pattern: 'hit', output_mode: 'content', offset: 1, head_limit: 2 }),
    );

    expect(result.output).toContain('b.ts:2:hit');
    expect(result.output).toContain('c.ts:3:hit');
    expect(result.output).not.toContain('a.ts:1:hit');
    expect(result.output).toContain('Use offset=3 to see more');
  });

  it('limits grep output to 250 lines by default', async () => {
    const paths = Array.from({ length: 251 }, (_, index) => `/workspace/src/${String(index)}.ts`);
    const displayPaths = Array.from({ length: 251 }, (_, index) => `src/${String(index)}.ts`);
    const stdout = [...paths, ''].join('\n');
    const tool = new GrepTool(
      createFakeKaos({ exec: vi.fn().mockResolvedValue(processWithOutput(stdout)) }),
      { workspaceDir: '/workspace', additionalDirs: [] },
    );

    const result = await executeTool(tool, context({ pattern: 'hit' }));
    const output = toolContentString(result);
    const lines = output.split('\n');

    expect(lines.slice(0, 250)).toEqual(displayPaths.slice(0, 250));
    expect(output).not.toContain(displayPaths[250]);
    expect(output).toContain(
      'Results truncated to 250 lines (total: 251). Use offset=250 to see more.',
    );
  });

  it('treats head_limit zero as unlimited', async () => {
    const paths = Array.from({ length: 251 }, (_, index) => `/workspace/src/${String(index)}.ts`);
    const displayPaths = Array.from({ length: 251 }, (_, index) => `src/${String(index)}.ts`);
    const stdout = [...paths, ''].join('\n');
    const tool = new GrepTool(
      createFakeKaos({ exec: vi.fn().mockResolvedValue(processWithOutput(stdout)) }),
      { workspaceDir: '/workspace', additionalDirs: [] },
    );

    const result = await executeTool(tool, context({ pattern: 'hit', head_limit: 0 }));
    const output = toolContentString(result);

    expect(output.split('\n')).toEqual(displayPaths);
    expect(output).not.toContain('Results truncated');
  });

  it('parses null-delimited files_with_matches output', async () => {
    const stdout = nullRecord('/workspace/src/main.ts') + nullRecord('/workspace/.env');
    const tool = new GrepTool(
      createFakeKaos({ exec: vi.fn().mockResolvedValue(processWithOutput(stdout)) }),
      { workspaceDir: '/workspace', additionalDirs: [] },
    );

    const result = await executeTool(tool, context({ pattern: 'hit' }));

    expect(toolContentString(result)).toBe(
      ['src/main.ts', 'Filtered 1 sensitive file(s): .env'].join('\n'),
    );
  });

  it('returns an error when grep times out without partial output', async () => {
    vi.useFakeTimers();
    const proc = processThatExitsOnKill('');
    const exec = vi.fn().mockResolvedValue(proc);
    const tool = new GrepTool(createFakeKaos({ exec }), workspace);

    const resultPromise = executeTool(tool, context({ pattern: 'slow' }));
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await resultPromise;

    expect(result).toEqual({
      isError: true,
      output: 'Grep timed out after 20s. Try a more specific path or pattern.',
    });
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('returns partial grep output when timeout produced usable stdout', async () => {
    vi.useFakeTimers();
    const proc = processThatExitsOnKill('/workspace/src/a.ts\n');
    const exec = vi.fn().mockResolvedValue(proc);
    const tool = new GrepTool(createFakeKaos({ exec }), workspace);

    const resultPromise = executeTool(tool, context({ pattern: 'slow' }));
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await resultPromise;

    expect(toolContentString(result)).toBe(
      ['src/a.ts', 'Grep timed out after 20s; partial results returned'].join('\n'),
    );
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('drops incomplete trailing stdout records after timeout', async () => {
    vi.useFakeTimers();
    const proc = processThatExitsOnKill('/workspace/src/a.ts\n/workspace/src/partial.ts');
    const exec = vi.fn().mockResolvedValue(proc);
    const tool = new GrepTool(createFakeKaos({ exec }), workspace);

    const resultPromise = executeTool(tool, context({ pattern: 'slow' }));
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await resultPromise;

    expect(toolContentString(result)).toBe(
      ['src/a.ts', 'Grep timed out after 20s; partial results returned'].join('\n'),
    );
  });

  it('drops incomplete trailing null-delimited files_with_matches records after timeout', async () => {
    vi.useFakeTimers();
    const stdout = `${nullRecord('/workspace/src/a.ts')}/workspace/src/partial.ts`;
    const proc = processThatExitsOnKill(stdout);
    const exec = vi.fn().mockResolvedValue(proc);
    const tool = new GrepTool(createFakeKaos({ exec }), workspace);

    const resultPromise = executeTool(tool, context({ pattern: 'slow' }));
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await resultPromise;

    expect(toolContentString(result)).toBe(
      ['src/a.ts', 'Grep timed out after 20s; partial results returned'].join('\n'),
    );
  });

  it('drops incomplete trailing null-delimited content records after timeout', async () => {
    vi.useFakeTimers();
    const stdout = `${nullRecord('/workspace/src/a.ts', '1:hit')}\n${nullRecord(
      '/workspace/src/partial.ts',
      '2:hit',
    )}`;
    const proc = processThatExitsOnKill(stdout);
    const exec = vi.fn().mockResolvedValue(proc);
    const tool = new GrepTool(createFakeKaos({ exec }), workspace);

    const resultPromise = executeTool(tool, context({ pattern: 'slow', output_mode: 'content' }));
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await resultPromise;

    expect(toolContentString(result)).toBe(
      ['src/a.ts:1:hit', 'Grep timed out after 20s; partial results returned'].join('\n'),
    );
  });

  it('keeps complete null-delimited context separators when timeout drops a trailing record', async () => {
    vi.useFakeTimers();
    const stdout = [
      nullRecord('/workspace/src/a.ts', '1:hit'),
      '--\r',
      nullRecord('/workspace/src/b.ts', '2:hit'),
      '--',
      nullRecord('/workspace/src/c.ts', '3:hit'),
    ].join('\n');
    const proc = processThatExitsOnKill(
      `${stdout}\n${nullRecord('/workspace/src/partial.ts', '4:hit')}`,
    );
    const exec = vi.fn().mockResolvedValue(proc);
    const tool = new GrepTool(createFakeKaos({ exec }), workspace);

    const resultPromise = executeTool(tool, context({ pattern: 'slow', output_mode: 'content' }));
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await resultPromise;

    expect(toolContentString(result)).toBe(
      [
        'src/a.ts:1:hit',
        '--',
        'src/b.ts:2:hit',
        '--',
        'src/c.ts:3:hit',
        'Grep timed out after 20s; partial results returned',
      ].join('\n'),
    );
  });

  it('drops incomplete trailing stdout lines after buffer truncation', async () => {
    const maxOutputBytes = 10 * 1024 * 1024;
    const completeLine = '/workspace/src/a.ts:1:hit';
    const displayedCompleteLine = 'src/a.ts:1:hit';
    const partialLine = '/workspace/src/partial.ts:2:hit';
    const stdout = `${completeLine}\n${partialLine}${'x'.repeat(maxOutputBytes)}`;
    const tool = new GrepTool(
      createFakeKaos({ exec: vi.fn().mockResolvedValue(processWithOutput(stdout)) }),
      { workspaceDir: '/workspace', additionalDirs: [] },
    );

    const result = await executeTool(tool, context({ pattern: 'hit', output_mode: 'content' }));

    expect(toolContentString(result)).toBe(
      [
        displayedCompleteLine,
        '[stdout truncated at 10485760 bytes; incomplete trailing line omitted]',
      ].join('\n'),
    );
  });

  it('summarizes count output across all non-sensitive results', async () => {
    const stdout = ['/workspace/src/a.ts:3', '/workspace/src/b.ts:7', ''].join('\n');
    const tool = new GrepTool(
      createFakeKaos({ exec: vi.fn().mockResolvedValue(processWithOutput(stdout)) }),
      { workspaceDir: '/workspace', additionalDirs: [] },
    );

    const result = await executeTool(tool, context({ pattern: 'hit', output_mode: 'count_matches' }));

    expect(toolContentString(result)).toBe(
      ['Found 10 total occurrences across 2 files.', 'src/a.ts:3', 'src/b.ts:7'].join('\n'),
    );
  });

  it('parses null-delimited count output before sensitive filtering and summary', async () => {
    const stdout =
      [nullRecord('/workspace/src/a.ts', '3'), nullRecord('/workspace/.env', '99')].join('\n') +
      '\n';
    const tool = new GrepTool(
      createFakeKaos({ exec: vi.fn().mockResolvedValue(processWithOutput(stdout)) }),
      { workspaceDir: '/workspace', additionalDirs: [] },
    );

    const result = await executeTool(tool, context({ pattern: 'hit', output_mode: 'count_matches' }));

    expect(toolContentString(result)).toBe(
      [
        'Found 3 total non-sensitive occurrences across 1 file.',
        'src/a.ts:3',
        'Filtered 1 sensitive file(s): .env',
      ].join('\n'),
    );
  });

  it('summarizes count output before pagination and after sensitive filtering', async () => {
    const stdout = [
      '/workspace/src/a.ts:3',
      '/workspace/.env:99',
      '/workspace/src/b.ts:7',
      '/workspace/src/c.ts:1',
      '',
    ].join('\n');
    const tool = new GrepTool(
      createFakeKaos({ exec: vi.fn().mockResolvedValue(processWithOutput(stdout)) }),
      { workspaceDir: '/workspace', additionalDirs: [] },
    );

    const result = await executeTool(tool,
      context({ pattern: 'hit', output_mode: 'count_matches', head_limit: 2 }),
    );

    expect(toolContentString(result)).toBe(
      [
        'Found 11 total non-sensitive occurrences across 3 files.',
        'Results truncated to 2 lines (total: 3). Use offset=2 to see more.',
        'src/a.ts:3',
        'src/b.ts:7',
        'Filtered 1 sensitive file(s): .env',
      ].join('\n'),
    );
  });

  it('keeps the count summary ahead of the body so the char cap cannot drop it', async () => {
    // With head_limit: 0 the count rows are unbounded and can exceed ToolResultBuilder's
    // char cap. The aggregate total must still reach the model, so it leads the output
    // (a header before the rows) — truncation can only eat the rows, never the total.
    const fileCount = 5000;
    const stdout =
      Array.from({ length: fileCount }, (_, i) => `/workspace/f${String(i)}.txt:3`).join('\n') + '\n';
    const tool = new GrepTool(
      createFakeKaos({ exec: vi.fn().mockResolvedValue(processWithOutput(stdout)) }),
      { workspaceDir: '/workspace', additionalDirs: [] },
    );

    const result = await executeTool(tool,
      context({ pattern: 'hit', output_mode: 'count_matches', head_limit: 0 }),
    );

    const output = toolContentString(result);
    const summary = `Found ${String(fileCount * 3)} total occurrences across ${String(fileCount)} files.`;
    expect(output).toContain(summary);
    // The body was large enough to truncate; the summary survives because it leads it.
    expect(output).toContain('[...truncated]');
    expect(output.indexOf(summary)).toBeLessThan(output.indexOf('[...truncated]'));
  });

  it('does not add a zero count summary when every count result is sensitive', async () => {
    const stdout = ['/workspace/.env:3', '/workspace/.aws/credentials:7', ''].join('\n');
    const tool = new GrepTool(
      createFakeKaos({ exec: vi.fn().mockResolvedValue(processWithOutput(stdout)) }),
      { workspaceDir: '/workspace', additionalDirs: [] },
    );

    const result = await executeTool(tool, context({ pattern: 'hit', output_mode: 'count_matches' }));

    expect(toolContentString(result)).toBe(
      [
        'No non-sensitive matches found',
        'Filtered 2 sensitive file(s): .env, .aws/credentials',
      ].join('\n'),
    );
  });

  it('forces filename in count_matches argv so single-file searches stay consistent', async () => {
    // ripgrep omits the filename in --count-matches output when only one file
    // is searched, so the tool must pass --with-filename. Otherwise the
    // per-file display line and the summary disagree (e.g. `25850` followed by
    // `Found 0 total occurrences across 0 files.`).
    const stdout = `${nullRecord('/workspace/src/only.ts', '25850')}\n`;
    const exec = vi.fn().mockResolvedValue(processWithOutput(stdout));
    const tool = new GrepTool(createFakeKaos({ exec }), workspace);

    const result = await executeTool(tool,
      context({
        pattern: 'yyyy',
        path: '/workspace/src/only.ts',
        output_mode: 'count_matches',
      }),
    );

    expect(exec).toHaveBeenCalledWith(
      '/mock/rg',
      ...DEFAULT_RG_ARGS,
      '--count-matches',
      '--with-filename',
      ...SENSITIVE_RG_ARGS,
      '--',
      'yyyy',
      '/workspace/src/only.ts',
    );
    expect(toolContentString(result)).toBe(
      ['Found 25850 total occurrences across 1 file.', 'src/only.ts:25850'].join('\n'),
    );
  });

  it('surfaces ripgrep parse errors with stderr detail', async () => {
    const stderr = 'rg: regex parse error:\nerror: unclosed character class\n';
    const exec = vi.fn().mockResolvedValue(processWithOutput('', stderr, 2));
    const tool = new GrepTool(createFakeKaos({ exec }), workspace);

    const result = await executeTool(tool, context({ pattern: '[' }));

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('Failed to grep: error: unclosed character class');
    expect(result.output).toContain('ripgrep stderr:');
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('surfaces ripgrep failures even when stderr is empty', async () => {
    const exec = vi.fn().mockResolvedValue(processWithOutput('', '', 2));
    const tool = new GrepTool(createFakeKaos({ exec }), workspace);

    const result = await executeTool(tool, context({ pattern: 'hit' }));

    expect(result).toEqual({ isError: true, output: 'Failed to grep: ripgrep exited with code 2' });
  });

  it('marks ripgrep stderr as truncated when error output exceeds the cap', async () => {
    const maxOutputBytes = 10 * 1024 * 1024;
    const stderr = `error: very large failure\n${'x'.repeat(maxOutputBytes)}`;
    const exec = vi.fn().mockResolvedValue(processWithOutput('', stderr, 2));
    const tool = new GrepTool(createFakeKaos({ exec }), workspace);

    const result = await executeTool(tool, context({ pattern: 'hit' }));

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('Failed to grep: error: very large failure');
    expect(result.output).toContain('[stderr truncated at 10485760 bytes]');
  });

  it('returns a locator error when ripgrep cannot be resolved', async () => {
    vi.mocked(ensureRgPath).mockRejectedValueOnce(new Error('download failed'));
    const exec = vi.fn();
    const tool = new GrepTool(createFakeKaos({ exec }), workspace);

    const result = await executeTool(tool, context({ pattern: 'hit' }));

    expect(result).toEqual({ isError: true, output: 'rg unavailable: download failed' });
    expect(exec).not.toHaveBeenCalled();
  });

  it('tracks when grep uses a non-system ripgrep fallback', async () => {
    vi.mocked(ensureRgPath).mockResolvedValueOnce({
      path: '/mock/rg',
      source: 'share-bin-downloaded',
    });
    const records: TelemetryRecord[] = [];
    const exec = vi.fn().mockResolvedValue(processWithOutput('/workspace/src/a.ts\n'));
    const tool = new GrepTool(createFakeKaos({ exec }), workspace, recordingTelemetry(records));

    const result = await executeTool(tool, context({ pattern: 'hit' }));

    expect(result.isError).not.toBe(true);
    expect(records).toEqual([
      {
        event: 'grep_tool_rg_fallback',
        properties: { source: 'share-bin-downloaded', outcome: 'resolved' },
      },
    ]);
  });

  it('returns an install hint when spawning the resolved ripgrep path hits ENOENT', async () => {
    const error = Object.assign(new Error('spawn /mock/rg ENOENT'), { code: 'ENOENT' });
    const exec = vi.fn().mockRejectedValue(error);
    const tool = new GrepTool(createFakeKaos({ exec }), workspace);

    const result = await executeTool(tool, context({ pattern: 'hit' }));

    expect(result).toEqual({
      isError: true,
      output: 'rg unavailable: spawn /mock/rg ENOENT',
    });
  });

  it('returns generic spawn errors from kaos.exec', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('permission denied'));
    const tool = new GrepTool(createFakeKaos({ exec }), workspace);

    const result = await executeTool(tool, context({ pattern: 'hit' }));

    expect(result).toEqual({ isError: true, output: 'permission denied' });
  });

  it('aborts while resolving the ripgrep path without spawning', async () => {
    const controller = new AbortController();
    const exec = vi.fn();
    vi.mocked(ensureRgPath).mockImplementationOnce(({ signal: locatorSignal } = {}) => {
      expect(locatorSignal).toBe(controller.signal);
      return new Promise((_resolve, reject) => {
        const rejectAbort = (): void => {
          const error = new Error('Aborted');
          error.name = 'AbortError';
          reject(error);
        };
        if (locatorSignal?.aborted === true) {
          rejectAbort();
          return;
        }
        locatorSignal?.addEventListener('abort', rejectAbort, { once: true });
      });
    });
    const tool = new GrepTool(createFakeKaos({ exec }), workspace);

    const resultPromise = executeTool(tool, context({ pattern: 'hit' }, controller.signal));
    controller.abort();
    const result = await Promise.race([
      resultPromise,
      new Promise<'timed out'>((resolve) => {
        setTimeout(() => {
          resolve('timed out');
        }, 50);
      }),
    ]);

    expect(result).toEqual({ isError: true, output: 'Grep aborted' });
    expect(exec).not.toHaveBeenCalled();
  });

  it('includes lines before the match for -B without -C', async () => {
    const stdout = [
      '/workspace/src/a.ts-1-pre1',
      '/workspace/src/a.ts-2-pre2',
      '/workspace/src/a.ts:3:TestClass match',
      '',
    ].join('\n');
    const exec = vi.fn().mockResolvedValue(processWithOutput(stdout));
    const tool = new GrepTool(createFakeKaos({ exec }), workspace);

    const result = await executeTool(tool,
      context({ pattern: 'TestClass', output_mode: 'content', '-B': 2 }),
    );

    expect(exec).toHaveBeenCalledWith(
      '/mock/rg',
      ...CONTENT_RG_ARGS,
      '--with-filename',
      '-n',
      '-B',
      '2',
      ...SENSITIVE_RG_ARGS,
      '--',
      'TestClass',
      '/workspace',
    );
    expect(toolContentString(result)).toContain('TestClass');
    expect(toolContentString(result)).toContain('pre1');
    expect(toolContentString(result)).toContain('pre2');
  });

  it('includes lines after the match for -A without -C', async () => {
    const stdout = [
      '/workspace/src/a.ts:3:TestClass match',
      '/workspace/src/a.ts-4-post1',
      '/workspace/src/a.ts-5-post2',
      '',
    ].join('\n');
    const exec = vi.fn().mockResolvedValue(processWithOutput(stdout));
    const tool = new GrepTool(createFakeKaos({ exec }), workspace);

    const result = await executeTool(tool,
      context({ pattern: 'TestClass', output_mode: 'content', '-A': 2 }),
    );

    expect(exec).toHaveBeenCalledWith(
      '/mock/rg',
      ...CONTENT_RG_ARGS,
      '--with-filename',
      '-n',
      '-A',
      '2',
      ...SENSITIVE_RG_ARGS,
      '--',
      'TestClass',
      '/workspace',
    );
    expect(toolContentString(result)).toContain('post1');
    expect(toolContentString(result)).toContain('post2');
  });

  it('appends the count-mode summary and pagination to the model-visible output', async () => {
    // The "Found N occurrences" summary and the pagination notice must ride in `output`:
    // `result.message` is dropped before the result reaches the model, so a side channel
    // would hide the total and the "use offset=N to see more" cue.
    const counts = Array.from(
      { length: 10 },
      (_, i) => `/workspace/f${String(i)}.txt:3`,
    );
    const stdout = `${counts.join('\n')}\n`;
    const exec = vi.fn().mockResolvedValue(processWithOutput(stdout));
    const tool = new GrepTool(createFakeKaos({ exec }), {
      workspaceDir: '/workspace',
      additionalDirs: [],
    });

    const result = await executeTool(tool,
      context({ pattern: 'word', output_mode: 'count_matches', head_limit: 3 }),
    );

    const output = toolContentString(result);
    const dataLines = output.split('\n').filter((line) => /^f\d+\.txt:3$/.test(line));
    expect(dataLines).toHaveLength(3); // head_limit=3 path:count lines
    expect(output).toContain('Found 30 total occurrences across 10 files.');
    expect(output).toContain('Results truncated to 3 lines (total: 10). Use offset=3 to see more.');
    // ...and nothing model-relevant is hidden in the dropped message channel.
    expect((result as { message?: string }).message ?? '').not.toContain('Found');
  });

  it('truncates extremely long rg output with a byte-level safety cap message', async () => {
    // py applies a DEFAULT_MAX_CHARS truncation in addition to head_limit;
    // checks the message contains "Output is truncated".
    const longLine = '/workspace/big.txt:1:' + 'x'.repeat(100);
    const stdout = `${Array.from({ length: 5000 }, () => longLine).join('\n')}\n`;
    const exec = vi.fn().mockResolvedValue(processWithOutput(stdout));
    const tool = new GrepTool(createFakeKaos({ exec }), workspace);

    const result = await executeTool(tool,
      context({ pattern: 'match', output_mode: 'content', head_limit: 0 }),
    );

    const message = (result as { message?: unknown }).message;
    expect(typeof message).toBe('string');
    expect(message).toContain('Output is truncated');
  });

  it('matches a pattern spanning a newline when multiline is set', async () => {
    const stdout = [
      "/workspace/multiline.py:2:    '''This is a",
      "/workspace/multiline.py:3:    multiline docstring'''",
      '',
    ].join('\n');
    const exec = vi.fn().mockResolvedValue(processWithOutput(stdout));
    const tool = new GrepTool(createFakeKaos({ exec }), workspace);

    const result = await executeTool(tool,
      context({
        pattern: String.raw`This is a\n    multiline`,
        output_mode: 'content',
        multiline: true,
      }),
    );

    expect(exec).toHaveBeenCalledWith(
      '/mock/rg',
      ...CONTENT_RG_ARGS,
      '--with-filename',
      '-n',
      '-U',
      '--multiline-dotall',
      ...SENSITIVE_RG_ARGS,
      '--',
      String.raw`This is a\n    multiline`,
      '/workspace',
    );
    expect(toolContentString(result)).toContain('This is a');
    expect(toolContentString(result)).toContain('multiline');
  });

  it('reports a descriptive failure when the regex is unparseable', async () => {
    const stderr =
      'rg: regex parse error:\n    "[invalid"\n     ^\nerror: unclosed character class\n';
    const exec = vi.fn().mockResolvedValue(processWithOutput('', stderr, 2));
    const tool = new GrepTool(createFakeKaos({ exec }), workspace);

    const result = await executeTool(tool,
      context({ pattern: '[invalid', output_mode: 'files_with_matches' }),
    );

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('Failed to grep');
  });

  it('returns content when searching a single file path', async () => {
    const exec = vi
      .fn()
      .mockResolvedValue(processWithOutput('/workspace/target.py:1:hello world\n'));
    const tool = new GrepTool(createFakeKaos({ exec }), workspace);

    const result = await executeTool(tool,
      context({ pattern: 'hello', path: '/workspace/target.py', output_mode: 'content' }),
    );

    expect(exec).toHaveBeenCalledWith(
      '/mock/rg',
      ...CONTENT_RG_ARGS,
      '--with-filename',
      '-n',
      ...SENSITIVE_RG_ARGS,
      '--',
      'hello',
      '/workspace/target.py',
    );
    expect(toolContentString(result)).toContain('hello');
    expect(toolContentString(result).trim().length).toBeGreaterThan(0);
  });

  it('returns a clean no-match result when offset exceeds total entries', async () => {
    const exec = vi.fn().mockResolvedValue(processWithOutput('/workspace/only.txt\n'));
    const tool = new GrepTool(createFakeKaos({ exec }), workspace);

    const result = await executeTool(tool,
      context({ pattern: 'data', output_mode: 'files_with_matches', offset: 100 }),
    );

    expect(result.isError).toBeFalsy();
    expect(toolContentString(result)).toContain('No');
    expect(toolContentString(result)).toContain('matches found');
  });

  it('emits line numbers by default in content mode', async () => {
    const exec = vi.fn().mockResolvedValue(processWithOutput('/workspace/a.txt:1:hello\n'));
    const tool = new GrepTool(createFakeKaos({ exec }), workspace);

    await executeTool(tool, context({ pattern: 'hello', output_mode: 'content' }));

    const flags = exec.mock.calls[0] as string[];
    expect(flags).toContain('-n');
  });

  it('drops the line-number column when "-n" is explicitly false', async () => {
    const exec = vi.fn().mockResolvedValue(processWithOutput('/workspace/a.txt:hello\n'));
    const tool = new GrepTool(createFakeKaos({ exec }), workspace);

    const result = await executeTool(tool,
      context({ pattern: 'hello', output_mode: 'content', '-n': false }),
    );

    const flags = exec.mock.calls[0] as string[];
    expect(flags).not.toContain('-n');
    const output = toolContentString(result);
    for (const line of output.split('\n')) {
      if (line.trim() === '' || line.startsWith('--')) continue;
      expect(line.split(':')).toHaveLength(2);
    }
  });

  it('maps schema flags onto ripgrep equivalents and tilde-expands ~ in path', async () => {
    const exec = vi.fn().mockResolvedValue(processWithOutput('/workspace/a.ts:1:hello\n'));
    const tool = new GrepTool(createFakeKaos({ exec }), workspace);

    await executeTool(tool,
      context({
        pattern: 'test',
        path: '/workspace',
        output_mode: 'content',
        '-i': true,
        multiline: true,
        '-B': 2,
        '-A': 3,
        '-C': 1,
        '-n': true,
        glob: '*.py',
        type: 'py',
      }),
    );

    const flags = exec.mock.calls[0] as string[];
    // -C takes precedence over -A/-B in content mode (matches existing TS lockdown)
    expect(flags).toContain('-i');
    expect(flags).toContain('-U');
    expect(flags).toContain('--multiline-dotall');
    expect(flags).toContain('-C');
    expect(flags).toContain('-n');
    expect(flags).toContain('--glob');
    expect(flags).toContain('*.py');
    expect(flags).toContain('--type');
    expect(flags).toContain('py');
    const ddIdx = flags.indexOf('--');
    expect(flags[ddIdx + 1]).toBe('test');
    expect(flags[ddIdx + 2]).toBe('/workspace');

    // expanduser on ~ in path: assert the exact post-expansion path so
    // the test fails if Grep silently treats `~` as a literal directory
    // (canonicalizes to "/home/test/~/foo") instead of expanding it.
    const homeTool = new GrepTool(
      createFakeKaos({ exec, gethome: () => '/home/test' }),
      { workspaceDir: '/home/test', additionalDirs: [] },
    );
    exec.mockClear();
    await executeTool(homeTool, context({ pattern: 'x', path: '~/foo' }));
    const expanded = exec.mock.calls[0] as string[];
    expect(expanded.at(-1)).toBe('/home/test/foo');
  });

  it('preserves the sensitive-filter warning when every match is sensitive', async () => {
    const exec = vi
      .fn()
      .mockResolvedValue(processWithOutput('/workspace/.env\n'));
    const tool = new GrepTool(createFakeKaos({ exec }), {
      workspaceDir: '/workspace',
      additionalDirs: [],
    });

    const result = await executeTool(tool,
      context({ pattern: 'ONLY_IN_ENV', output_mode: 'files_with_matches' }),
    );

    const output = toolContentString(result);
    expect(output).toContain('No non-sensitive matches found');
    expect(output).toContain('Filtered 1 sensitive file(s): .env');
  });

  it('does not flag .env.example as sensitive', async () => {
    const exec = vi
      .fn()
      .mockResolvedValue(processWithOutput('/workspace/.env.example\n'));
    const tool = new GrepTool(createFakeKaos({ exec }), {
      workspaceDir: '/workspace',
      additionalDirs: [],
    });

    const result = await executeTool(tool,
      context({ pattern: 'API_KEY', output_mode: 'files_with_matches' }),
    );

    const output = toolContentString(result);
    expect(output).toContain('.env.example');
    expect(output).not.toContain('Filtered');
  });

  it('strips workspace prefix from rg output across record kinds (posix)', async () => {
    const stdout = [
      '/workspace/src/a.py:42:code',
      '/workspace/src/b.py-41-context',
      '--',
      '',
    ].join('\n');
    const exec = vi.fn().mockResolvedValue(processWithOutput(stdout));
    const tool = new GrepTool(createFakeKaos({ exec }), {
      workspaceDir: '/workspace',
      additionalDirs: [],
    });

    const result = await executeTool(tool, context({ pattern: 'code', output_mode: 'content' }));

    const lines = toolContentString(result).split('\n');
    expect(lines[0]).toBe('src/a.py:42:code');
    expect(lines[1]).toBe('src/b.py-41-context');
  });

  it('strips workspace prefix from rg output across record kinds (win32)', async () => {
    const stdout = [
      'C:\\repo\\src\\a.py:42:code',
      'C:\\repo\\src\\b.py-41-context',
      '--',
      '',
    ].join('\n');
    const exec = vi.fn().mockResolvedValue(processWithOutput(stdout));
    const tool = new GrepTool(
      createFakeKaos({ exec, pathClass: () => 'win32' }),
      { workspaceDir: 'C:\\repo', additionalDirs: [] },
    );

    const result = await executeTool(tool, context({ pattern: 'code', output_mode: 'content' }));

    const lines = toolContentString(result).split('\n');
    expect(lines[0]).toBe('src/a.py:42:code');
    expect(lines[1]).toBe('src/b.py-41-context');
  });

  it('passes lines through unchanged when path is not under the workspace', async () => {
    const stdout = '/other/path/file.py:1:hit\n--\n';
    const exec = vi.fn().mockResolvedValue(processWithOutput(stdout));
    const tool = new GrepTool(createFakeKaos({ exec }), {
      workspaceDir: '/home/user/project',
      additionalDirs: [],
    });

    const result = await executeTool(tool, context({ pattern: 'hit', output_mode: 'content' }));

    const lines = toolContentString(result).split('\n');
    expect(lines[0]).toBe('/other/path/file.py:1:hit');
  });

  it('treats a trailing-slash workspace dir the same as one without', async () => {
    const withSep = new GrepTool(
      createFakeKaos({ exec: vi.fn().mockResolvedValue(processWithOutput('/tmp/dir/file.py\n')) }),
      { workspaceDir: '/tmp/dir/', additionalDirs: [] },
    );
    const noSep = new GrepTool(
      createFakeKaos({ exec: vi.fn().mockResolvedValue(processWithOutput('/tmp/dir/file.py\n')) }),
      { workspaceDir: '/tmp/dir', additionalDirs: [] },
    );

    const withSepResult = await executeTool(withSep,
      context({ pattern: 'x', output_mode: 'files_with_matches' }),
    );
    const noSepResult = await executeTool(noSep,
      context({ pattern: 'x', output_mode: 'files_with_matches' }),
    );

    expect(toolContentString(withSepResult)).toContain('file.py');
    expect(toolContentString(noSepResult)).toContain('file.py');
    expect(toolContentString(withSepResult)).not.toContain('/tmp/dir/file.py');
    expect(toolContentString(noSepResult)).not.toContain('/tmp/dir/file.py');
  });

  it('does not strip a workspace dir prefix when it would match a sibling name', async () => {
    const stdout = ['/tmp/abc/file.py', '/tmp/a/file.py', ''].join('\n');
    const exec = vi.fn().mockResolvedValue(processWithOutput(stdout));
    const tool = new GrepTool(createFakeKaos({ exec }), {
      workspaceDir: '/tmp/a',
      additionalDirs: [],
    });

    const result = await executeTool(tool,
      context({ pattern: 'x', output_mode: 'files_with_matches' }),
    );
    const output = toolContentString(result);
    expect(output).toContain('/tmp/abc/file.py');
    expect(output).toContain('file.py');
    // The /tmp/a entry should be relativized to "file.py"; the /tmp/abc
    // entry must stay absolute so it does not collide with the relative form.
    expect(output.split('\n')).toEqual(expect.arrayContaining(['file.py', '/tmp/abc/file.py']));
  });

  it('relativizes a single-file absolute path against the workspace dir', async () => {
    const exec = vi
      .fn()
      .mockResolvedValue(processWithOutput('/workspace/target.py:1:foo\n'));
    const tool = new GrepTool(createFakeKaos({ exec }), {
      workspaceDir: '/workspace',
      additionalDirs: [],
    });

    const result = await executeTool(tool,
      context({ pattern: 'foo', path: '/workspace/target.py', output_mode: 'content' }),
    );

    const output = toolContentString(result);
    for (const line of output.split('\n')) {
      if (line.trim() === '' || line.startsWith('--')) continue;
      expect(line.startsWith('/')).toBe(false);
    }
    expect(output).toContain('target.py');
  });

  it('filters sensitive .env inside a hyphenated subdirectory in content mode', async () => {
    const stdout = [
      '/workspace/my-project/.env:1:SECRET=leaked',
      '/workspace/my-project/.env-2-context',
      '--',
      '/workspace/safe.txt:1:SECRET=ok',
      '',
    ].join('\n');
    const exec = vi.fn().mockResolvedValue(processWithOutput(stdout));
    const tool = new GrepTool(createFakeKaos({ exec }), {
      workspaceDir: '/workspace',
      additionalDirs: [],
    });

    const result = await executeTool(tool,
      context({ pattern: 'SECRET', output_mode: 'content', '-C': 1 }),
    );

    const output = toolContentString(result);
    expect(output).toContain('safe.txt');
    expect(output).not.toContain('leaked');
    expect(output).toContain('Filtered');
    expect(output).toContain('my-project/.env');
  });

  it('locks the grep description to ripgrep-tip phrasing about hidden files and include_ignored', () => {
    const tool = new GrepTool(createFakeKaos(), workspace);

    expect(tool.description).toContain('ripgrep');
    expect(tool.description).toContain('Hidden files');
    expect(tool.description).toContain('include_ignored');
    expect(tool.description).toMatch(/sensitive/i);
    expect(tool.description).toMatch(/ALWAYS use Grep tool instead of running `grep` or `rg`/);
  });

  it('aborts and kills ripgrep after the process has spawned', async () => {
    const controller = new AbortController();
    const proc = processThatExitsOnKill('/workspace/src/a.ts\n');
    const exec = vi.fn(async () => {
      controller.abort();
      return proc;
    });
    const tool = new GrepTool(createFakeKaos({ exec }), workspace);

    const result = await executeTool(tool, context({ pattern: 'hit' }, controller.signal));

    expect(result).toEqual({ isError: true, output: 'Grep aborted' });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('returns an abort error without spawning when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const exec = vi.fn();
    const tool = new GrepTool(createFakeKaos({ exec }), workspace);

    const result = await executeTool(tool, context({ pattern: 'hit' }, controller.signal));

    expect(result).toEqual({ isError: true, output: 'Aborted before search started' });
    expect(exec).not.toHaveBeenCalled();
  });
});
