import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, type Writable } from 'node:stream';

import { LocalKaos } from '@moonshot-ai/kaos';
import type { Kaos, KaosProcess, StatResult } from '@moonshot-ai/kaos';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type GlobInput,
  GlobInputSchema,
  GlobTool,
  MAX_MATCHES,
  splitCompletePaths,
} from '../../src/tools/builtin/file/glob';
import { ensureRgPath } from '../../src/tools/support/rg-locator';
import type { WorkspaceConfig } from '../../src/tools/support/workspace';
import { createFakeKaos } from './fixtures/fake-kaos';
import { executeTool } from './fixtures/execute-tool';
import { recordingTelemetry, type TelemetryRecord } from '../fixtures/telemetry';

vi.mock('../../src/tools/support/rg-locator', () => ({
  ensureRgPath: vi.fn(async () => ({ path: '/mock/rg', source: 'system-path' })),
  rgUnavailableMessage: (cause: unknown) =>
    `rg unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
}));

const signal = new AbortController().signal;
const workspace: WorkspaceConfig = { workspaceDir: '/workspace', additionalDirs: ['/extra'] };

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

function dirStat(): StatResult {
  return {
    stMode: 0o040000,
    stIno: 1,
    stDev: 1,
    stNlink: 1,
    stUid: 0,
    stGid: 0,
    stSize: 0,
    stAtime: 0,
    stMtime: 0,
    stCtime: 0,
  };
}

function fileStat(): StatResult {
  return { ...dirStat(), stMode: 0o100000 };
}

function context(args: GlobInput) {
  return { turnId: '0', toolCallId: 'call_glob', args, signal };
}

function execReturning(stdout: string, stderr = '', exitCode = 0) {
  return vi.fn().mockResolvedValue(processWithOutput(stdout, stderr, exitCode));
}

// Kaos with `exec` scripted and `stat` reporting a directory — the baseline
// for tests that run the GlobTool to completion.
function kaosWithExec(exec: Kaos['exec'], overrides: Partial<Kaos> = {}) {
  return createFakeKaos({ exec, stat: vi.fn().mockResolvedValue(dirStat()), ...overrides });
}

function execArgs(exec: ReturnType<typeof vi.fn>): string[] {
  return exec.mock.calls[0] as string[];
}

describe('GlobTool', () => {
  it('exposes current metadata and schema', () => {
    const tool = new GlobTool(createFakeKaos(), workspace);

    expect(tool.name).toBe('Glob');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { pattern: { type: 'string' } },
    });
    expect(GlobInputSchema.safeParse({ pattern: 'src/**/*.ts' }).success).toBe(true);
    expect(GlobInputSchema.safeParse({ pattern: '*.js', path: '/src' }).success).toBe(true);
  });

  it('is files-only and exposes include_ignored; include_dirs is deprecated and ignored', () => {
    const tool = new GlobTool(createFakeKaos(), workspace);
    const schema = tool.parameters as { properties: Record<string, { description?: string }> };

    expect(schema.properties).toHaveProperty('include_ignored');
    // include_dirs is kept only so older calls that still pass it are not
    // rejected by parameter validation. It is deprecated and ignored — results
    // are always files-only regardless of its value.
    expect(schema.properties).toHaveProperty('include_dirs');
    expect(schema.properties['include_dirs']?.description?.toLowerCase()).toContain('deprecated');
  });

  it('tracks when glob uses a non-system ripgrep fallback', async () => {
    vi.mocked(ensureRgPath).mockResolvedValueOnce({
      path: '/mock/rg',
      source: 'share-bin-downloaded',
    });
    const records: TelemetryRecord[] = [];
    const exec = execReturning('/workspace/src/a.ts\n');
    const tool = new GlobTool(kaosWithExec(exec), workspace, recordingTelemetry(records));

    const result = await executeTool(tool, context({ pattern: 'src/**/*.ts', path: '/workspace' }));

    expect(result.output).toBe('src/a.ts');
    expect(records).toEqual([
      {
        event: 'glob_tool_rg_fallback',
        properties: { source: 'share-bin-downloaded', outcome: 'resolved' },
      },
    ]);
  });

  it('injects the Windows path hint into the description on a win32 backend', () => {
    const tool = new GlobTool(createFakeKaos({ pathClass: () => 'win32' }), workspace);

    expect(tool.description).toContain('Windows');
    expect(tool.description).toContain('forward slashes');
    expect(tool.description).toContain('Bash');
  });

  it('omits the Windows path hint from the description on a non-Windows backend', () => {
    const tool = new GlobTool(createFakeKaos({ pathClass: () => 'posix' }), workspace);

    expect(tool.description).not.toContain('forward slashes');
  });

  it('requests reverse modified sort and preserves the rg output order', async () => {
    const exec = execReturning('/workspace/src/new.ts\n/workspace/src/old.ts\n');
    const tool = new GlobTool(kaosWithExec(exec), workspace);

    const result = await executeTool(tool, context({ pattern: 'src/**/*.ts', path: '/workspace' }));
    const args = execArgs(exec);

    expect(args).toContain('--sortr=modified');
    expect(args).not.toContain('--sort=modified');
    expect(result.output).toBe('src/new.ts\nsrc/old.ts');
  });

  it('uses the backend path class when displaying paths relative to a windows root', async () => {
    const exec = execReturning('C:\\workspace\\src\\old.ts\n');
    const tool = new GlobTool(kaosWithExec(exec, { pathClass: () => 'win32' }), {
      workspaceDir: 'C:\\workspace',
      additionalDirs: [],
    });

    const result = await executeTool(tool, context({ pattern: 'src/**/*.ts', path: 'C:\\WORKSPACE' }));

    // pathe.normalize renders Windows paths with forward slashes, so the
    // relativized result keeps `/` regardless of the backend path class.
    expect(result.output).toBe('src/old.ts');
  });

  it('walks pure-wildcard patterns, capping at MAX_MATCHES', async () => {
    const stdout =
      Array.from({ length: MAX_MATCHES + 5 }, (_, i) => `/workspace/${String(i)}.ts`).join('\n') +
      '\n';
    const exec = execReturning(stdout);
    const tool = new GlobTool(kaosWithExec(exec), workspace);

    const result = await executeTool(tool, context({ pattern: '**' }));

    expect(result.isError).toBeFalsy();
    expect(execArgs(exec).at(-1)).toBe('.');
    expect(result.output).toContain(`[Truncated at ${String(MAX_MATCHES)} matches`);
  });

  it('passes a brace pattern through to a single rg --glob', async () => {
    const exec = execReturning('/workspace/a.ts\n/workspace/shared.ts\n/workspace/shared.tsx\n');
    const tool = new GlobTool(kaosWithExec(exec), workspace);

    const result = await executeTool(tool, context({ pattern: '*.{ts,tsx}' }));

    expect(result.isError).toBeFalsy();
    expect(execArgs(exec)).toContain('*.{ts,tsx}');
    expect(result.output).toContain('a.ts');
    expect(result.output).toContain('shared.ts');
    expect(result.output).toContain('shared.tsx');
  });

  it('passes an escaped-brace pattern through unchanged so literal-brace files stay matchable', async () => {
    // `\{a,b\}.ts` opts out of brace expansion — the user wants a file
    // literally named `{a,b}.ts`. The pattern must reach rg with the escapes
    // intact (the tool must not strip or reinterpret the backslashes).
    const exec = execReturning('/workspace/{a,b}.ts\n');
    const tool = new GlobTool(kaosWithExec(exec), workspace);

    const result = await executeTool(tool, context({ pattern: '\\{a,b\\}.ts' }));

    expect(result.isError).toBeFalsy();
    expect(execArgs(exec)).toContain('\\{a,b\\}.ts');
    expect(result.output).toContain('{a,b}.ts');
  });

  it('searches only the current workspace when path is omitted', async () => {
    const exec = execReturning('/workspace/a.ts\n/workspace/shared.ts\n');
    const tool = new GlobTool(kaosWithExec(exec), workspace);

    const result = await executeTool(tool, context({ pattern: '*.ts' }));

    expect(exec).toHaveBeenCalledTimes(1);
    expect(execArgs(exec).at(-1)).toBe('.');
    expect(result.output).toBe('a.ts\nshared.ts');
  });

  it('keeps results absolute when searching an additional directory', async () => {
    // additionalDir is outside workspaceDir, so matches stay absolute.
    const exec = execReturning('/extra/pkg/a.ts\n');
    const tool = new GlobTool(kaosWithExec(exec), workspace);

    const result = await executeTool(tool, context({ pattern: 'pkg/**/*.ts', path: '/extra' }));

    expect(result.output).toBe('/extra/pkg/a.ts');
    expect(execArgs(exec).at(-1)).toBe('.');
  });

  it('adds --no-ignore when include_ignored is true', async () => {
    const exec = execReturning('/workspace/dist/bundle.js\n');
    const tool = new GlobTool(kaosWithExec(exec), workspace);

    await executeTool(tool, context({ pattern: '*.js', include_ignored: true }));

    expect(execArgs(exec)).toContain('--no-ignore');
  });

  it('does not pass --no-ignore by default', async () => {
    const exec = execReturning('/workspace/a.ts\n');
    const tool = new GlobTool(kaosWithExec(exec), workspace);

    await executeTool(tool, context({ pattern: '*.ts' }));

    expect(execArgs(exec)).not.toContain('--no-ignore');
  });

  it('caps returned matches and surfaces the truncation header', async () => {
    const stdout =
      Array.from({ length: MAX_MATCHES + 1 }, (_, i) => `/workspace/${String(i)}.ts`).join('\n') +
      '\n';
    const exec = execReturning(stdout);
    const tool = new GlobTool(kaosWithExec(exec), { workspaceDir: '/workspace', additionalDirs: [] });

    const result = await executeTool(tool, context({ pattern: '*.ts' }));

    expect(result.output).toContain(`[Truncated at ${String(MAX_MATCHES)} matches`);
    expect(result.output).toContain('0.ts');
    expect(result.output).not.toContain(`${String(MAX_MATCHES)}.ts`);
  });

  it('surfaces a "first N matches" header when matches exceed MAX_MATCHES', async () => {
    const stdout =
      Array.from({ length: MAX_MATCHES + 50 }, (_, i) => `/workspace/file_${String(i)}.txt`).join(
        '\n',
      ) + '\n';
    const exec = execReturning(stdout);
    const tool = new GlobTool(kaosWithExec(exec), { workspaceDir: '/workspace', additionalDirs: [] });

    const result = await executeTool(tool, context({ pattern: '*.txt' }));

    expect(result.output).toContain(`Only the first ${String(MAX_MATCHES)} matches are returned`);
  });

  it('returns a "Found N matches" footer at exactly MAX_MATCHES without truncation', async () => {
    const stdout =
      Array.from({ length: MAX_MATCHES }, (_, i) => `/workspace/test_${String(i)}.py`).join('\n') +
      '\n';
    const exec = execReturning(stdout);
    const tool = new GlobTool(kaosWithExec(exec), { workspaceDir: '/workspace', additionalDirs: [] });

    const result = await executeTool(tool, context({ pattern: '*.py' }));

    expect(result.output).not.toContain('Only the first');
    expect(result.output).toContain(`Found ${String(MAX_MATCHES)} matches`);
  });

  it('filters sensitive files from results', async () => {
    const exec = execReturning('/workspace/.env\n/workspace/src/a.ts\n');
    const tool = new GlobTool(kaosWithExec(exec), workspace);

    const result = await executeTool(tool, context({ pattern: 'src/**' }));

    expect(result.output).toContain('src/a.ts');
    expect(result.output).not.toContain('.env');
    expect(result.output).toContain('Filtered 1 sensitive file');
  });

  describe('skills / additional dirs', () => {
    const skillsWorkspace: WorkspaceConfig = {
      workspaceDir: '/workspace',
      additionalDirs: ['/skills'],
    };

    it('searches inside a registered additionalDir entry', async () => {
      const exec = execReturning('/skills/read_content.py\n/skills/utils.py\n');
      const tool = new GlobTool(kaosWithExec(exec), skillsWorkspace);

      const result = await executeTool(tool, context({ pattern: '*.py', path: '/skills' }));

      expect(result.output).toContain('/skills/read_content.py');
      expect(result.output).toContain('/skills/utils.py');
      expect(execArgs(exec).at(-1)).toBe('.');
    });

    it('searches inside a subdirectory of an additionalDir entry', async () => {
      const exec = execReturning('/skills/feishu/scripts/read_content.py\n');
      const tool = new GlobTool(kaosWithExec(exec), skillsWorkspace);

      const result = await executeTool(
        tool,
        context({ pattern: '*.py', path: '/skills/feishu/scripts' }),
      );

      expect(result.output).toContain('/skills/feishu/scripts/read_content.py');
    });

    it('rejects a relative path that escapes both workspace and additionalDirs', async () => {
      const exec = vi.fn();
      const tool = new GlobTool(createFakeKaos({ exec }), {
        workspaceDir: '/workspace/project',
        additionalDirs: ['/skills'],
      });

      const result = await executeTool(tool, context({ pattern: '*.py', path: '../../tmp/evil' }));

      expect(result).toMatchObject({ isError: true });
      expect(result.output).toContain('absolute path');
      expect(exec).not.toHaveBeenCalled();
    });

    it('accepts a path inside a deeply nested additionalDir entry', async () => {
      const exec = execReturning('/skills/my-skill/scripts/helper.py\n');
      const tool = new GlobTool(kaosWithExec(exec), skillsWorkspace);

      const result = await executeTool(
        tool,
        context({ pattern: '*.py', path: '/skills/my-skill/scripts' }),
      );

      expect(result.output).toContain('/skills/my-skill/scripts/helper.py');
    });
  });

  it('walks "**/" prefix patterns with a literal anchor', async () => {
    const exec = execReturning('/workspace/a.py\n/workspace/sub/b.py\n');
    const tool = new GlobTool(kaosWithExec(exec), workspace);

    const result = await executeTool(tool, context({ pattern: '**/*.py' }));

    expect(result.isError).toBeFalsy();
    expect(execArgs(exec)).toContain('**/*.py');
    expect(result.output).toContain('a.py');
    expect(result.output).toContain('sub/b.py');
  });

  it('walks safe recursive patterns with a literal subdirectory anchor', async () => {
    const exec = execReturning(
      [
        '/workspace/src/main.py',
        '/workspace/src/utils.py',
        '/workspace/src/main/app.py',
        '/workspace/src/main/config.py',
        '/workspace/src/test/test_app.py',
        '/workspace/src/test/test_config.py',
      ].join('\n') + '\n',
    );
    const tool = new GlobTool(kaosWithExec(exec), workspace);

    const result = await executeTool(tool, context({ pattern: 'src/**/*.py', path: '/workspace' }));

    expect(result.output).toContain('src/main.py');
    expect(result.output).toContain('src/utils.py');
    expect(result.output).toContain('src/main/app.py');
    expect(result.output).toContain('src/main/config.py');
    expect(result.output).toContain('src/test/test_app.py');
    expect(result.output).toContain('src/test/test_config.py');
  });

  it('surfaces an explicit no-match message when rg exits 1', async () => {
    const exec = execReturning('', '', 1);
    const tool = new GlobTool(kaosWithExec(exec), workspace);

    const result = await executeTool(tool, context({ pattern: '*.xyz', path: '/workspace' }));

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('No matches found');
  });

  it('keeps complete paths and surfaces a warning when rg exits 2 after traversal errors', async () => {
    const exec = execReturning(
      '/workspace/a.ts\n/workspace/src/b.ts\n',
      'rg: ./locked: Permission denied (os error 13)',
      2,
    );
    const tool = new GlobTool(kaosWithExec(exec), workspace);

    const result = await executeTool(tool, context({ pattern: '*.ts', path: '/workspace' }));

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('a.ts');
    expect(result.output).toContain('src/b.ts');
    expect(result.output).toContain('Glob completed with warnings');
    expect(result.output).toContain('Permission denied');
  });

  it('keeps ripgrep errors hard failures when no complete path is produced', async () => {
    const exec = execReturning('', 'error: invalid glob', 2);
    const tool = new GlobTool(kaosWithExec(exec), workspace);

    const result = await executeTool(tool, context({ pattern: '[', path: '/workspace' }));

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('Glob failed: error: invalid glob');
  });

  it('reports "does not exist" when the search directory is missing', async () => {
    const exec = vi.fn();
    const stat = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }));
    const tool = new GlobTool(createFakeKaos({ exec, stat }), workspace);

    const result = await executeTool(tool, context({ pattern: '*.py', path: '/workspace/nonexistent' }));

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('does not exist');
    expect(exec).not.toHaveBeenCalled();
  });

  it('reports "is not a directory" when the search target is a file', async () => {
    const exec = vi.fn();
    const stat = vi.fn().mockResolvedValue(fileStat());
    const tool = new GlobTool(createFakeKaos({ exec, stat }), workspace);

    const result = await executeTool(tool, context({ pattern: '*.py', path: '/workspace/file.txt' }));

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('is not a directory');
    expect(exec).not.toHaveBeenCalled();
  });

  it('walks "**/" patterns with literal subdirectory anchors after the prefix', async () => {
    const exec = execReturning('/workspace/src/main/app.py\n');
    const tool = new GlobTool(kaosWithExec(exec), workspace);

    const result = await executeTool(tool, context({ pattern: '**/main/*.py' }));

    expect(result.isError).toBeFalsy();
    expect(execArgs(exec)).toContain('**/main/*.py');
    expect(result.output).toContain('src/main/app.py');
  });

  it('matches dotfiles like .gitlab-ci.yml under a simple "*.yml" pattern', async () => {
    const exec = execReturning('/workspace/.gitlab-ci.yml\n/workspace/config.yml\n');
    const tool = new GlobTool(kaosWithExec(exec), workspace);

    const result = await executeTool(tool, context({ pattern: '*.yml' }));

    expect(result.output).toContain('.gitlab-ci.yml');
    expect(result.output).toContain('config.yml');
  });

  it('descends into hidden directories under a recursive pattern', async () => {
    const exec = execReturning('/workspace/src/.config/settings.yml\n');
    const tool = new GlobTool(kaosWithExec(exec), workspace);

    const result = await executeTool(tool, context({ pattern: 'src/**/*.yml' }));

    expect(result.output).toContain('src/.config/settings.yml');
  });

  it('matches files inside an explicitly addressed hidden directory', async () => {
    const exec = execReturning('/workspace/.github/workflows/ci.yml\n');
    const tool = new GlobTool(kaosWithExec(exec), workspace);

    const result = await executeTool(tool, context({ pattern: '.github/**/*.yml' }));

    expect(result.output).toContain('.github/workflows/ci.yml');
  });

  it('shows absolute paths when explicit search root is outside all workspace roots', async () => {
    const exec = execReturning('/extra/test.py\n');
    const tool = new GlobTool(kaosWithExec(exec), { workspaceDir: '/workspace', additionalDirs: [] });

    const result = await executeTool(tool, context({ pattern: '*.py', path: '/extra' }));

    expect(result.isError).toBeFalsy();
    expect(result.output).toBe('/extra/test.py');
  });

  it('keeps absolute paths when explicit search root is an additionalDir', async () => {
    const registered: WorkspaceConfig = { workspaceDir: '/workspace', additionalDirs: ['/extra'] };
    const exec = execReturning('/extra/test.py\n');
    const tool = new GlobTool(kaosWithExec(exec), registered);

    const result = await executeTool(tool, context({ pattern: '*.py', path: '/extra' }));

    expect(result.isError).toBeFalsy();
    expect(result.output).toBe('/extra/test.py');
  });

  it('allows a relative path argument that resolves inside the workspace', async () => {
    const exec = execReturning('/workspace/relative/path/test.py\n');
    const tool = new GlobTool(kaosWithExec(exec), workspace);

    const result = await executeTool(tool, context({ pattern: '*.py', path: 'relative/path' }));

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('test.py');
    expect(execArgs(exec).at(-1)).toBe('.');
  });

  it('expands a leading "~/" path before searching outside the workspace', async () => {
    const exec = execReturning('');
    const tool = new GlobTool(kaosWithExec(exec, { gethome: () => '/home/test' }), {
      workspaceDir: '/workspace',
      additionalDirs: [],
    });

    const result = await executeTool(tool, context({ pattern: '*.py', path: '~/' }));

    expect(result.isError).toBeFalsy();
    expect(result.output).toBe('No matches found');
    expect(execArgs(exec).at(-1)).toBe('.');
  });

  it('allows a path sharing the workspace prefix when it is absolute', async () => {
    const exec = execReturning('');
    const tool = new GlobTool(kaosWithExec(exec), {
      workspaceDir: '/parent/workdir',
      additionalDirs: [],
    });

    const result = await executeTool(
      tool,
      context({ pattern: '*.py', path: '/parent/workdir-sneaky' }),
    );

    expect(result.isError).toBeFalsy();
    expect(result.output).toBe('No matches found');
    expect(execArgs(exec).at(-1)).toBe('.');
  });

  it('locks down brace-expansion mention and large-directory caveats in the description', () => {
    const tool = new GlobTool(createFakeKaos(), workspace);

    expect(tool.description).toContain('**');
    expect(tool.description).toMatch(/\*\*\/\*\.py/);
    expect(tool.description).toContain('brace expansion');
    expect(tool.description).toContain('node_modules');
    expect(tool.description).not.toContain('On Windows');
  });

  it('mentions Windows path forms in the description on win32 backends', () => {
    const tool = new GlobTool(createFakeKaos({ pathClass: () => 'win32' }), {
      workspaceDir: 'C:\\workspace',
      additionalDirs: [],
    });

    expect(tool.description).toContain('C:\\Users\\foo');
    expect(tool.description).toContain('/c/Users/foo');
  });
});

describe('splitCompletePaths', () => {
  it('keeps every line when output is complete (trailing newline)', () => {
    expect(splitCompletePaths('/a/b.ts\n/c/d.ts\n', false)).toEqual(['/a/b.ts', '/c/d.ts']);
  });

  it('keeps every line when output is complete even if flagged truncated', () => {
    // A trailing newline means the last path is intact; nothing to drop.
    expect(splitCompletePaths('/a/b.ts\n/c/d.ts\n', true)).toEqual(['/a/b.ts', '/c/d.ts']);
  });

  it('drops a half-written trailing path when output is truncated', () => {
    expect(splitCompletePaths('/a/b.ts\n/c/d.t', true)).toEqual(['/a/b.ts']);
  });

  it('keeps the trailing path when output is not flagged truncated', () => {
    // Without the truncation flag the final segment is trusted as-is.
    expect(splitCompletePaths('/a/b.ts\n/c/d.ts', false)).toEqual(['/a/b.ts', '/c/d.ts']);
  });

  it('returns an empty list when truncated output has no complete line', () => {
    expect(splitCompletePaths('/partial-no-newline', true)).toEqual([]);
  });
});

describe('GlobTool integration (real ripgrep)', () => {
  // Spawns the actual rg binary through a real LocalKaos so the ripgrep
  // semantics the tool relies on (sort direction, recursion, brace handling)
  // are exercised end-to-end — not just the argument plumbing.

  let tmpDir: string | undefined;
  let kaos: LocalKaos;
  let runRealRg = false;

  beforeAll(async () => {
    try {
      const actual = await vi.importActual<typeof import('../../src/tools/support/rg-locator')>(
        '../../src/tools/support/rg-locator',
      );
      const resolution = await actual.ensureRgPath();
      vi.mocked(ensureRgPath).mockResolvedValue(resolution);
      runRealRg = true;
    } catch {
      // rg unavailable in this environment; beforeEach skips the suite.
    }
  });

  beforeEach(async (testCtx) => {
    if (!runRealRg) testCtx.skip();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'glob-rg-'));
    kaos = await LocalKaos.create();
  });

  afterEach(async () => {
    if (tmpDir !== undefined) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  async function touch(rel: string, mtime: Date): Promise<void> {
    const full = path.join(tmpDir!, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, '');
    await fs.utimes(full, mtime, mtime);
  }

  const ws = (): WorkspaceConfig => ({ workspaceDir: tmpDir!, additionalDirs: [] });

  it('returns files newest-first by modification time (--sortr=modified)', async () => {
    await touch('old.ts', new Date('2020-01-01T00:00:00Z'));
    await touch('mid.ts', new Date('2022-01-01T00:00:00Z'));
    await touch('new.ts', new Date('2024-01-01T00:00:00Z'));
    const tool = new GlobTool(kaos, ws());

    const result = await executeTool(tool, context({ pattern: '*.ts', path: tmpDir! }));

    expect(result.output).toBe('new.ts\nmid.ts\nold.ts');
  });

  it('treats a bare pattern (no slash) as recursive across subdirectories', async () => {
    await touch('root.ts', new Date('2024-01-01T00:00:00Z'));
    await touch('src/a.ts', new Date('2023-01-01T00:00:00Z'));
    await touch('src/sub/b.ts', new Date('2022-01-01T00:00:00Z'));
    const tool = new GlobTool(kaos, ws());

    const result = await executeTool(tool, context({ pattern: '*.ts', path: tmpDir! }));

    expect(result.output).toContain('root.ts');
    expect(result.output).toContain('src/a.ts');
    expect(result.output).toContain('src/sub/b.ts');
  });

  it('matches brace alternatives across directories', async () => {
    await touch('src/a.ts', new Date('2024-01-01T00:00:00Z'));
    await touch('test/a.ts', new Date('2023-01-01T00:00:00Z'));
    await touch('other/a.ts', new Date('2022-01-01T00:00:00Z'));
    const tool = new GlobTool(kaos, ws());

    const result = await executeTool(tool, context({ pattern: '{src,test}/*.ts', path: tmpDir! }));

    expect(result.output).toContain('src/a.ts');
    expect(result.output).toContain('test/a.ts');
    expect(result.output).not.toContain('other/a.ts');
  });

  it('matches a recursive anchored pattern (src/**/*.ts) under an absolute search root', async () => {
    // Regression guard for F11: with an absolute search root, ripgrep matches
    // a `--glob` pattern containing a `/` against the absolute path, so
    // `src/**/*.ts` returns nothing unless the tool runs rg from the search
    // root (cwd) with `.` as the search path.
    await touch('src/a.ts', new Date('2024-01-01T00:00:00Z'));
    await touch('src/sub/b.ts', new Date('2023-01-01T00:00:00Z'));
    await touch('other/c.ts', new Date('2022-01-01T00:00:00Z'));
    const tool = new GlobTool(kaos, ws());

    const result = await executeTool(tool, context({ pattern: 'src/**/*.ts', path: tmpDir! }));

    expect(result.output).toContain('src/a.ts');
    expect(result.output).toContain('src/sub/b.ts');
    expect(result.output).not.toContain('other/c.ts');
  });

  it('treats an escaped brace as a literal filename', async () => {
    await touch('{a,b}.ts', new Date('2024-01-01T00:00:00Z'));
    const tool = new GlobTool(kaos, ws());

    const result = await executeTool(tool, context({ pattern: '\\{a,b\\}.ts', path: tmpDir! }));

    expect(result.output).toContain('{a,b}.ts');
  });

  it('returns absolute paths when the search root is outside the workspace', async () => {
    // Exercises the cwd-based fix (F11) end-to-end on an external root: rg
    // emits paths relative to the external root, the tool resolves them back
    // to absolute, and since the root is outside the workspace they stay
    // absolute in the output.
    const externalDir = await fs.mkdtemp(path.join(os.tmpdir(), 'glob-ext-'));
    try {
      const extFile = path.join(externalDir, 'pkg.ts');
      await fs.writeFile(extFile, '');
      const tool = new GlobTool(kaos, ws());

      const result = await executeTool(tool, context({ pattern: '*.ts', path: externalDir }));

      expect(result.output).toBe(extFile);
    } finally {
      await fs.rm(externalDir, { recursive: true, force: true });
    }
  });
});
