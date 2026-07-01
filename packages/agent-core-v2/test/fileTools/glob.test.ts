/**
 * GlobTool tests for the v2 fileTools domain.
 *
 * Ported from v1 (`packages/agent-core/test/tools/glob.test.ts`) and adapted
 * to the v2 constructor `(fs, kaos, workspace)` and the v2 execution
 * environment. The Glob search now runs `rg --files` through the `IKaos`
 * backend (`withCwd(root).backend.exec('rg', ...)`) instead of
 * `ISessionAgentFileSystem.glob`, so tests fake `kaos.backend.exec` to return
 * a scripted `KaosProcess` (stdout/stderr streams + exit code) rather than
 * stubbing `fs.glob`. `fs.readdir` is still faked for the directory
 * pre-check (missing / non-directory roots).
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, type Writable } from 'node:stream';

import { LocalKaos } from '@moonshot-ai/kaos';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureRgPath } from '#/agentFs/rgLocator';
import { PathSecurityError, type PathClass } from '../../src/_base/tools/policies/path-access';
import type { WorkspaceConfig } from '../../src/_base/tools/support/workspace';
import type { ISessionAgentFileSystem } from '../../src/agentFs';
import { SessionAgentFileSystem } from '../../src/agentFs/agentFsService';
import {
  type GlobInput,
  GlobInputSchema,
  GlobTool,
  MAX_MATCHES,
  splitCompletePaths,
} from '../../src/fileTools/tools/glob';
import type { IKaos, KaosProcess } from '../../src/kaos';
import { KaosService } from '../../src/kaos/kaosService';
import type { ITelemetryService } from '../../src/telemetry';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '../../src/tool';

// The ripgrep binary locator is mocked out for the unit tests so they assert
// on argument building and output parsing without probing a real `rg`. The
// real locator is exercised end-to-end by the integration suite below (rg is
// on PATH in that environment, so the resolved `rg` just runs).
vi.mock('#/agentFs/rgLocator', () => ({
  ensureRgPath: vi.fn(async (): Promise<{ path: string; source: string }> => ({
    path: 'rg',
    source: 'system-path',
  })),
  rgUnavailableMessage: (cause: unknown) =>
    `rg unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
}));

// Synchronous probe so the integration suite can be gated with `skipIf` at
// definition time. `rg` is on PATH in the standard dev environment.
const RG_AVAILABLE = spawnSync('rg', ['--version'], { stdio: 'ignore' }).status === 0;

const signal = new AbortController().signal;
const workspace: WorkspaceConfig = { workspaceDir: '/workspace', additionalDirs: ['/extra'] };

/** Fake fs with a spied `readdir` for the directory pre-check. */
function createTestFs(opts: { readdir?: ReturnType<typeof vi.fn> } = {}) {
  const readdir = opts.readdir ?? vi.fn(async (): Promise<readonly string[]> => []);
  const fs = { cwd: '/workspace', readdir } as unknown as ISessionAgentFileSystem;
  return { fs, readdir };
}

/** Build a fake `KaosProcess` that emits `stdout` / `stderr` then exits with `exitCode`. */
function fakeProcess(stdout: string, stderr = '', exitCode = 0): KaosProcess {
  const stdoutStream = Readable.from([Buffer.from(stdout)]);
  const stderrStream = Readable.from([Buffer.from(stderr)]);
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

function execReturning(stdout: string, stderr = '', exitCode = 0) {
  return vi.fn().mockResolvedValue(fakeProcess(stdout, stderr, exitCode));
}

/**
 * Fake `IKaos` whose `withCwd(cwd)` returns a derived environment that shares
 * the same `backend.exec` spy — mirroring the real `IKaos.withCwd` semantics
 * (the backend is shared across cwd derivations). The root environment's
 * `withCwd` is exposed so tests can assert the resolved search root.
 */
function createTestKaos(
  opts: {
    home?: string;
    pathClass?: PathClass;
    exec?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const exec = opts.exec ?? execReturning('');
  const backend = { exec } as unknown as IKaos['backend'];
  function build(cwd: string): IKaos {
    return {
      cwd,
      backend,
      pathClass: () => opts.pathClass ?? 'posix',
      gethome: () => opts.home ?? '/home/test',
      withCwd: vi.fn((next: string) => build(next)),
    } as unknown as IKaos;
  }
  const kaos = build('/workspace');
  return { kaos, exec, withCwd: kaos.withCwd as ReturnType<typeof vi.fn> };
}

function execArgs(exec: ReturnType<typeof vi.fn>): string[] {
  return exec.mock.calls[0] as string[];
}

function telemetryStub(
  events: Array<{ event: string; properties: Record<string, unknown> }>,
): ITelemetryService {
  return {
    _serviceBrand: undefined,
    track: (event: string, properties: Record<string, unknown>) => {
      events.push({ event, properties });
    },
    withContext: () => telemetryStub(events),
    setContext: () => {},
    addAppender: () => ({ dispose: () => {} }),
    removeAppender: () => {},
    setAppender: () => {},
    setEnabled: () => {},
    flush: async () => {},
    shutdown: async () => {},
  };
}

function isPromiseLike(value: ToolExecution | Promise<ToolExecution>): value is Promise<ToolExecution> {
  return typeof (value as Promise<ToolExecution>).then === 'function';
}

async function execute(tool: GlobTool, args: GlobInput): Promise<ExecutableToolResult> {
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
    turnId: '0',
    toolCallId: 'call_glob',
    signal,
  };
  return execution.execute(ctx);
}

function toolContentString(result: ExecutableToolResult): string {
  const c = result.output;
  if (typeof c !== 'string') {
    throw new TypeError(`expected string content, got ${typeof c}`);
  }
  return c;
}

describe('GlobTool', () => {
  it('exposes current metadata and schema', () => {
    const { fs } = createTestFs();
    const { kaos } = createTestKaos();
    const tool = new GlobTool(fs, kaos, workspace);

    expect(tool.name).toBe('Glob');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { pattern: { type: 'string' } },
    });
    expect(GlobInputSchema.safeParse({ pattern: 'src/**/*.ts' }).success).toBe(true);
    expect(GlobInputSchema.safeParse({ pattern: '*.js', path: '/src' }).success).toBe(true);
  });

  it('is files-only and exposes include_ignored; include_dirs is deprecated and ignored', () => {
    const { fs } = createTestFs();
    const { kaos } = createTestKaos();
    const tool = new GlobTool(fs, kaos, workspace);
    const schema = tool.parameters as {
      properties: Record<string, { description?: string; default?: unknown }>;
      required?: string[];
    };

    expect(schema.properties).toHaveProperty('include_ignored');
    // include_dirs is kept only so older calls that still pass it are not
    // rejected by parameter validation. It is deprecated and ignored — results
    // are always files-only regardless of its value, and it carries no default.
    expect(schema.properties).toHaveProperty('include_dirs');
    expect(schema.properties['include_dirs']?.description?.toLowerCase()).toContain('deprecated');
    expect(schema.properties['include_dirs']?.default).toBeUndefined();
    expect(schema.required ?? []).not.toContain('include_dirs');
  });

  it('injects the Windows path hint into the description on a win32 backend', () => {
    const { fs } = createTestFs();
    const { kaos } = createTestKaos({ pathClass: 'win32' });
    const tool = new GlobTool(fs, kaos, workspace);

    expect(tool.description).toContain('Windows');
    expect(tool.description).toContain('forward slashes');
    expect(tool.description).toContain('Bash');
  });

  it('omits the Windows path hint from the description on a non-Windows backend', () => {
    const { fs } = createTestFs();
    const { kaos } = createTestKaos({ pathClass: 'posix' });
    const tool = new GlobTool(fs, kaos, workspace);

    expect(tool.description).not.toContain('forward slashes');
  });

  it('requests reverse modified sort and preserves the rg output order', async () => {
    const exec = execReturning('/workspace/src/new.ts\n/workspace/src/old.ts\n');
    const { fs } = createTestFs();
    const { kaos, withCwd } = createTestKaos({ exec });
    const tool = new GlobTool(fs, kaos, workspace);

    const result = await execute(tool, { pattern: 'src/**/*.ts', path: '/workspace' });
    const args = execArgs(exec);

    expect(args).toContain('--sortr=modified');
    expect(args).not.toContain('--sort=modified');
    expect(result.output).toBe('src/new.ts\nsrc/old.ts');
    expect(withCwd).toHaveBeenCalledWith('/workspace');
  });

  it('uses the backend path class when displaying paths relative to a windows root', async () => {
    const exec = execReturning('C:\\workspace\\src\\old.ts\n');
    const { fs } = createTestFs();
    const { kaos, withCwd } = createTestKaos({ pathClass: 'win32', exec });
    const tool = new GlobTool(fs, kaos, {
      workspaceDir: 'C:\\workspace',
      additionalDirs: [],
    });

    const result = await execute(tool, { pattern: 'src/**/*.ts', path: 'C:\\WORKSPACE' });

    // pathe.normalize renders Windows paths with forward slashes, so the
    // relativized result keeps `/` regardless of the backend path class.
    expect(result.output).toBe('src/old.ts');
    expect(withCwd).toHaveBeenCalledWith('C:/WORKSPACE');
  });

  it('walks pure-wildcard patterns, capping at MAX_MATCHES', async () => {
    const stdout =
      Array.from({ length: MAX_MATCHES + 5 }, (_, i) => `/workspace/${String(i)}.ts`).join('\n') +
      '\n';
    const exec = execReturning(stdout);
    const { fs } = createTestFs();
    const { kaos, withCwd } = createTestKaos({ exec });
    const tool = new GlobTool(fs, kaos, workspace);

    const result = await execute(tool, { pattern: '**' });

    expect(result.isError).toBeFalsy();
    expect(withCwd).toHaveBeenCalledWith('/workspace');
    expect(execArgs(exec).at(-1)).toBe('.');
    expect(result.output).toContain(`[Truncated at ${String(MAX_MATCHES)} matches`);
  });

  it('passes a brace pattern through to a single rg --glob', async () => {
    const exec = execReturning('/workspace/a.ts\n/workspace/shared.ts\n/workspace/shared.tsx\n');
    const { fs } = createTestFs();
    const { kaos, withCwd } = createTestKaos({ exec });
    const tool = new GlobTool(fs, kaos, workspace);

    const result = await execute(tool, { pattern: '*.{ts,tsx}' });

    expect(result.isError).toBeFalsy();
    expect(withCwd).toHaveBeenCalledWith('/workspace');
    expect(execArgs(exec)).toContain('*.{ts,tsx}');
    const output = toolContentString(result);
    expect(output).toContain('a.ts');
    expect(output).toContain('shared.ts');
    expect(output).toContain('shared.tsx');
  });

  it('passes an escaped-brace pattern through unchanged so literal-brace files stay matchable', async () => {
    // `\{a,b\}.ts` opts out of brace expansion — the user wants a file
    // literally named `{a,b}.ts`. The pattern must reach rg with the escapes
    // intact (the tool must not strip or reinterpret the backslashes).
    const exec = execReturning('/workspace/{a,b}.ts\n');
    const { fs } = createTestFs();
    const { kaos, withCwd } = createTestKaos({ exec });
    const tool = new GlobTool(fs, kaos, workspace);

    const result = await execute(tool, { pattern: '\\{a,b\\}.ts' });

    expect(result.isError).toBeFalsy();
    expect(withCwd).toHaveBeenCalledWith('/workspace');
    expect(execArgs(exec)).toContain('\\{a,b\\}.ts');
    expect(result.output).toContain('{a,b}.ts');
  });

  it('searches only the current workspace when path is omitted', async () => {
    const exec = execReturning('/workspace/a.ts\n/workspace/shared.ts\n');
    const { fs } = createTestFs();
    const { kaos, withCwd } = createTestKaos({ exec });
    const tool = new GlobTool(fs, kaos, workspace);

    const result = await execute(tool, { pattern: '*.ts' });

    expect(exec).toHaveBeenCalledTimes(1);
    expect(withCwd).toHaveBeenCalledWith('/workspace');
    expect(execArgs(exec).at(-1)).toBe('.');
    expect(result.output).toBe('a.ts\nshared.ts');
  });

  it('keeps results absolute when searching an additional directory', async () => {
    // additionalDir is outside workspaceDir, so matches stay absolute.
    const exec = execReturning('/extra/pkg/a.ts\n');
    const { fs } = createTestFs();
    const { kaos, withCwd } = createTestKaos({ exec });
    const tool = new GlobTool(fs, kaos, workspace);

    const result = await execute(tool, { pattern: 'pkg/**/*.ts', path: '/extra' });

    expect(result.output).toBe('/extra/pkg/a.ts');
    expect(exec).toHaveBeenCalledTimes(1);
    expect(withCwd).toHaveBeenCalledWith('/extra');
    expect(execArgs(exec).at(-1)).toBe('.');
  });

  it('adds --no-ignore when include_ignored is true', async () => {
    const exec = execReturning('/workspace/dist/bundle.js\n');
    const { fs } = createTestFs();
    const { kaos } = createTestKaos({ exec });
    const tool = new GlobTool(fs, kaos, workspace);

    await execute(tool, { pattern: '*.js', include_ignored: true });

    expect(execArgs(exec)).toContain('--no-ignore');
  });

  it('does not pass --no-ignore by default', async () => {
    const exec = execReturning('/workspace/a.ts\n');
    const { fs } = createTestFs();
    const { kaos } = createTestKaos({ exec });
    const tool = new GlobTool(fs, kaos, workspace);

    await execute(tool, { pattern: '*.ts' });

    expect(execArgs(exec)).not.toContain('--no-ignore');
  });

  it('caps returned matches and surfaces the truncation header', async () => {
    const stdout =
      Array.from({ length: MAX_MATCHES + 1 }, (_, i) => `/workspace/${String(i)}.ts`).join('\n') +
      '\n';
    const exec = execReturning(stdout);
    const { fs } = createTestFs();
    const { kaos } = createTestKaos({ exec });
    const tool = new GlobTool(fs, kaos, {
      workspaceDir: '/workspace',
      additionalDirs: [],
    });

    const result = await execute(tool, { pattern: '*.ts' });

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
    const { fs } = createTestFs();
    const { kaos } = createTestKaos({ exec });
    const tool = new GlobTool(fs, kaos, {
      workspaceDir: '/workspace',
      additionalDirs: [],
    });

    const result = await execute(tool, { pattern: '*.txt' });

    expect(result.output).toContain(`Only the first ${String(MAX_MATCHES)} matches are returned`);
  });

  it('returns a "Found N matches" footer at exactly MAX_MATCHES without truncation', async () => {
    const stdout =
      Array.from({ length: MAX_MATCHES }, (_, i) => `/workspace/test_${String(i)}.py`).join('\n') +
      '\n';
    const exec = execReturning(stdout);
    const { fs } = createTestFs();
    const { kaos } = createTestKaos({ exec });
    const tool = new GlobTool(fs, kaos, {
      workspaceDir: '/workspace',
      additionalDirs: [],
    });

    const result = await execute(tool, { pattern: '*.py' });

    expect(result.output).not.toContain('Only the first');
    expect(result.output).toContain(`Found ${String(MAX_MATCHES)} matches`);
  });

  it('filters sensitive files from results', async () => {
    const exec = execReturning('/workspace/.env\n/workspace/src/a.ts\n');
    const { fs } = createTestFs();
    const { kaos } = createTestKaos({ exec });
    const tool = new GlobTool(fs, kaos, workspace);

    const result = await execute(tool, { pattern: 'src/**' });

    expect(result.output).toContain('src/a.ts');
    expect(result.output).not.toContain('.env');
    expect(result.output).toContain('Filtered 1 sensitive file');
  });

  it('surfaces a "Glob failed" error when rg cannot be spawned', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('spawn rg ENOENT'));
    const { fs } = createTestFs();
    const { kaos } = createTestKaos({ exec });
    const tool = new GlobTool(fs, kaos, workspace);

    const result = await execute(tool, { pattern: '*.ts' });

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('Glob failed: spawn rg ENOENT');
  });

  it('retries once single-threaded when rg fails with EAGAIN (os error 11)', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce(
        fakeProcess('', 'rg: thread pool: Resource temporarily unavailable (os error 11)', 2),
      )
      .mockResolvedValueOnce(fakeProcess('/workspace/a.ts\n', '', 0));
    const { fs } = createTestFs();
    const { kaos } = createTestKaos({ exec });
    const tool = new GlobTool(fs, kaos, workspace);

    const result = await execute(tool, { pattern: '*.ts', path: '/workspace' });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('a.ts');
    expect(exec).toHaveBeenCalledTimes(2);
    const retryArgs = exec.mock.calls[1] as string[];
    expect(retryArgs).toContain('-j');
    expect(retryArgs).toContain('1');
  });

  it('surfaces an actionable error and tracks telemetry when rg is unavailable', async () => {
    vi.mocked(ensureRgPath).mockRejectedValueOnce(
      new Error('ripgrep (rg) is not available on PATH'),
    );
    const events: Array<{ event: string; properties: Record<string, unknown> }> = [];
    const exec = vi.fn();
    const { fs } = createTestFs();
    const { kaos } = createTestKaos({ exec });
    const tool = new GlobTool(fs, kaos, workspace, telemetryStub(events));

    const result = await execute(tool, { pattern: '*.ts' });

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('rg unavailable: ripgrep (rg) is not available on PATH');
    expect(exec).not.toHaveBeenCalled();
    expect(events).toContainEqual({
      event: 'glob_tool_rg_fallback',
      properties: { outcome: 'failed' },
    });
  });

  it('tracks telemetry when rg resolves from a non-PATH fallback source', async () => {
    vi.mocked(ensureRgPath).mockResolvedValueOnce({
      path: '/mock/cached/rg',
      source: 'share-bin-cached',
    });
    const events: Array<{ event: string; properties: Record<string, unknown> }> = [];
    const exec = execReturning('/workspace/a.ts\n');
    const { fs } = createTestFs();
    const { kaos } = createTestKaos({ exec });
    const tool = new GlobTool(fs, kaos, workspace, telemetryStub(events));

    const result = await execute(tool, { pattern: '*.ts' });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('a.ts');
    expect((exec.mock.calls[0] as string[])[0]).toBe('/mock/cached/rg');
    expect(events).toContainEqual({
      event: 'glob_tool_rg_fallback',
      properties: { source: 'share-bin-cached', outcome: 'resolved' },
    });
  });

  describe('skills / additional dirs', () => {
    const skillsWorkspace: WorkspaceConfig = {
      workspaceDir: '/workspace',
      additionalDirs: ['/skills'],
    };

    it('searches inside a registered additionalDir entry', async () => {
      const exec = execReturning('/skills/read_content.py\n/skills/utils.py\n');
      const { fs } = createTestFs();
      const { kaos, withCwd } = createTestKaos({ exec });
      const tool = new GlobTool(fs, kaos, skillsWorkspace);

      const result = await execute(tool, { pattern: '*.py', path: '/skills' });

      expect(result.output).toContain('/skills/read_content.py');
      expect(result.output).toContain('/skills/utils.py');
      expect(withCwd).toHaveBeenCalledWith('/skills');
      expect(execArgs(exec).at(-1)).toBe('.');
    });

    it('searches inside a subdirectory of an additionalDir entry', async () => {
      const exec = execReturning('/skills/feishu/scripts/read_content.py\n');
      const { fs } = createTestFs();
      const { kaos, withCwd } = createTestKaos({ exec });
      const tool = new GlobTool(fs, kaos, skillsWorkspace);

      const result = await execute(tool, {
        pattern: '*.py',
        path: '/skills/feishu/scripts',
      });

      expect(result.output).toContain('/skills/feishu/scripts/read_content.py');
      expect(withCwd).toHaveBeenCalledWith('/skills/feishu/scripts');
    });

    it('rejects a relative path that escapes both workspace and additionalDirs', async () => {
      const exec = vi.fn();
      const { fs } = createTestFs();
      const { kaos, withCwd } = createTestKaos({ exec });
      const tool = new GlobTool(fs, kaos, {
        workspaceDir: '/workspace/project',
        additionalDirs: ['/skills'],
      });

      const result = await execute(tool, { pattern: '*.py', path: '../../tmp/evil' });

      expect(result).toMatchObject({ isError: true });
      expect(result.output).toContain('absolute path');
      expect(exec).not.toHaveBeenCalled();
      expect(withCwd).not.toHaveBeenCalled();
    });

    it('accepts a path inside a deeply nested additionalDir entry', async () => {
      const exec = execReturning('/skills/my-skill/scripts/helper.py\n');
      const { fs } = createTestFs();
      const { kaos, withCwd } = createTestKaos({ exec });
      const tool = new GlobTool(fs, kaos, skillsWorkspace);

      const result = await execute(tool, {
        pattern: '*.py',
        path: '/skills/my-skill/scripts',
      });

      expect(result.output).toContain('/skills/my-skill/scripts/helper.py');
      expect(withCwd).toHaveBeenCalledWith('/skills/my-skill/scripts');
    });
  });

  it('walks "**/" prefix patterns with a literal anchor', async () => {
    const exec = execReturning('/workspace/a.py\n/workspace/sub/b.py\n');
    const { fs } = createTestFs();
    const { kaos, withCwd } = createTestKaos({ exec });
    const tool = new GlobTool(fs, kaos, workspace);

    const result = await execute(tool, { pattern: '**/*.py' });

    expect(result.isError).toBeFalsy();
    expect(withCwd).toHaveBeenCalledWith('/workspace');
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
    const { fs } = createTestFs();
    const { kaos } = createTestKaos({ exec });
    const tool = new GlobTool(fs, kaos, workspace);

    const result = await execute(tool, { pattern: 'src/**/*.py', path: '/workspace' });

    expect(result.output).toContain('src/main.py');
    expect(result.output).toContain('src/utils.py');
    expect(result.output).toContain('src/main/app.py');
    expect(result.output).toContain('src/main/config.py');
    expect(result.output).toContain('src/test/test_app.py');
    expect(result.output).toContain('src/test/test_config.py');
  });

  it('surfaces an explicit no-match message when rg exits 1', async () => {
    const exec = execReturning('', '', 1);
    const { fs } = createTestFs();
    const { kaos } = createTestKaos({ exec });
    const tool = new GlobTool(fs, kaos, workspace);

    const result = await execute(tool, { pattern: '*.xyz', path: '/workspace' });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('No matches found');
  });

  it('keeps complete paths and surfaces a warning when rg exits 2 after traversal errors', async () => {
    const exec = execReturning(
      '/workspace/a.ts\n/workspace/src/b.ts\n',
      'rg: ./locked: Permission denied (os error 13)',
      2,
    );
    const { fs } = createTestFs();
    const { kaos } = createTestKaos({ exec });
    const tool = new GlobTool(fs, kaos, workspace);

    const result = await execute(tool, { pattern: '*.ts', path: '/workspace' });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('a.ts');
    expect(result.output).toContain('src/b.ts');
    expect(result.output).toContain('Glob completed with warnings');
    expect(result.output).toContain('Permission denied');
  });

  it('keeps ripgrep errors hard failures when no complete path is produced', async () => {
    const exec = execReturning('', 'error: invalid glob', 2);
    const { fs } = createTestFs();
    const { kaos } = createTestKaos({ exec });
    const tool = new GlobTool(fs, kaos, workspace);

    const result = await execute(tool, { pattern: '[', path: '/workspace' });

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('Glob failed: error: invalid glob');
  });

  it('reports "does not exist" when the search directory is missing', async () => {
    // The pre-check uses fs.readdir; an ENOENT surfaces before rg runs.
    const readdir = vi.fn(async (): Promise<readonly string[]> => {
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    });
    const exec = vi.fn();
    const { fs } = createTestFs({ readdir });
    const { kaos, withCwd } = createTestKaos({ exec });
    const tool = new GlobTool(fs, kaos, workspace);

    const result = await execute(tool, { pattern: '*.py', path: '/workspace/nonexistent' });

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('does not exist');
    expect(exec).not.toHaveBeenCalled();
    expect(withCwd).not.toHaveBeenCalled();
  });

  it('reports "is not a directory" when the search target is a file', async () => {
    // The pre-check uses fs.readdir; an ENOTDIR surfaces before rg runs.
    const readdir = vi.fn(async (): Promise<readonly string[]> => {
      throw Object.assign(new Error('ENOTDIR: not a directory'), { code: 'ENOTDIR' });
    });
    const exec = vi.fn();
    const { fs } = createTestFs({ readdir });
    const { kaos, withCwd } = createTestKaos({ exec });
    const tool = new GlobTool(fs, kaos, workspace);

    const result = await execute(tool, { pattern: '*.py', path: '/workspace/file.txt' });

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('is not a directory');
    expect(exec).not.toHaveBeenCalled();
    expect(withCwd).not.toHaveBeenCalled();
  });

  it('walks "**/" patterns with literal subdirectory anchors after the prefix', async () => {
    const exec = execReturning('/workspace/src/main/app.py\n');
    const { fs } = createTestFs();
    const { kaos, withCwd } = createTestKaos({ exec });
    const tool = new GlobTool(fs, kaos, workspace);

    const result = await execute(tool, { pattern: '**/main/*.py' });

    expect(result.isError).toBeFalsy();
    expect(withCwd).toHaveBeenCalledWith('/workspace');
    expect(execArgs(exec)).toContain('**/main/*.py');
    expect(result.output).toContain('src/main/app.py');
  });

  it('matches dotfiles like .gitlab-ci.yml under a simple "*.yml" pattern', async () => {
    const exec = execReturning('/workspace/.gitlab-ci.yml\n/workspace/config.yml\n');
    const { fs } = createTestFs();
    const { kaos } = createTestKaos({ exec });
    const tool = new GlobTool(fs, kaos, workspace);

    const result = await execute(tool, { pattern: '*.yml' });

    expect(result.output).toContain('.gitlab-ci.yml');
    expect(result.output).toContain('config.yml');
  });

  it('descends into hidden directories under a recursive pattern', async () => {
    const exec = execReturning('/workspace/src/.config/settings.yml\n');
    const { fs } = createTestFs();
    const { kaos } = createTestKaos({ exec });
    const tool = new GlobTool(fs, kaos, workspace);

    const result = await execute(tool, { pattern: 'src/**/*.yml' });

    expect(result.output).toContain('src/.config/settings.yml');
  });

  it('matches files inside an explicitly addressed hidden directory', async () => {
    const exec = execReturning('/workspace/.github/workflows/ci.yml\n');
    const { fs } = createTestFs();
    const { kaos } = createTestKaos({ exec });
    const tool = new GlobTool(fs, kaos, workspace);

    const result = await execute(tool, { pattern: '.github/**/*.yml' });

    expect(result.output).toContain('.github/workflows/ci.yml');
  });

  it('shows absolute paths when explicit search root is outside all workspace roots', async () => {
    // When the search root is not inside workspaceDir, matches must stay
    // absolute in the output. Otherwise the model would resolve a
    // relativized path against the workspace cwd and hit the wrong file.
    const exec = execReturning('/extra/test.py\n');
    const { fs } = createTestFs();
    const { kaos, withCwd } = createTestKaos({ exec });
    const tool = new GlobTool(fs, kaos, {
      workspaceDir: '/workspace',
      additionalDirs: [],
    });

    const result = await execute(tool, { pattern: '*.py', path: '/extra' });
    expect(result.isError).toBeFalsy();
    expect(result.output).toBe('/extra/test.py');
    expect(withCwd).toHaveBeenCalledWith('/extra');
  });

  it('keeps absolute paths when explicit search root is an additionalDir', async () => {
    // AdditionalDirs are searchable, but model-visible relative paths
    // still resolve against workspaceDir in follow-up Read/Edit calls, so
    // matches under an additionalDir stay absolute.
    const registered: WorkspaceConfig = { workspaceDir: '/workspace', additionalDirs: ['/extra'] };
    const exec = execReturning('/extra/test.py\n');
    const { fs } = createTestFs();
    const { kaos } = createTestKaos({ exec });
    const tool = new GlobTool(fs, kaos, registered);

    const result = await execute(tool, { pattern: '*.py', path: '/extra' });
    expect(result.isError).toBeFalsy();
    expect(result.output).toBe('/extra/test.py');
  });

  it('allows a relative path argument that resolves inside the workspace', async () => {
    const exec = execReturning('/workspace/relative/path/test.py\n');
    const { fs } = createTestFs();
    const { kaos, withCwd } = createTestKaos({ exec });
    const tool = new GlobTool(fs, kaos, workspace);

    const result = await execute(tool, { pattern: '*.py', path: 'relative/path' });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('test.py');
    expect(withCwd).toHaveBeenCalledWith('/workspace/relative/path');
    expect(execArgs(exec).at(-1)).toBe('.');
  });

  it('expands a leading "~/" path before searching outside the workspace', async () => {
    const exec = execReturning('');
    const { fs } = createTestFs();
    const { kaos, withCwd } = createTestKaos({ home: '/home/test', exec });
    const tool = new GlobTool(fs, kaos, {
      workspaceDir: '/workspace',
      additionalDirs: [],
    });

    const result = await execute(tool, { pattern: '*.py', path: '~/' });

    expect(result.isError).toBeFalsy();
    expect(result.output).toBe('No matches found');
    expect(withCwd).toHaveBeenCalledWith('/home/test');
    expect(execArgs(exec).at(-1)).toBe('.');
  });

  it('allows a path sharing the workspace prefix when it is absolute', async () => {
    const exec = execReturning('');
    const { fs } = createTestFs();
    const { kaos, withCwd } = createTestKaos({ exec });
    const tool = new GlobTool(fs, kaos, {
      workspaceDir: '/parent/workdir',
      additionalDirs: [],
    });

    const result = await execute(tool, { pattern: '*.py', path: '/parent/workdir-sneaky' });

    expect(result.isError).toBeFalsy();
    expect(result.output).toBe('No matches found');
    expect(withCwd).toHaveBeenCalledWith('/parent/workdir-sneaky');
    expect(execArgs(exec).at(-1)).toBe('.');
  });

  it('locks down brace-expansion mention and large-directory caveats in the description', () => {
    const { fs } = createTestFs();
    const { kaos } = createTestKaos();
    const tool = new GlobTool(fs, kaos, workspace);

    expect(tool.description).toContain('**');
    expect(tool.description).toMatch(/\*\*\/\*\.py/);
    expect(tool.description).toContain('brace expansion');
    expect(tool.description).toContain('node_modules');
    expect(tool.description).not.toContain('On Windows');
  });

  it('mentions Windows path forms in the description on win32 backends', () => {
    const { fs } = createTestFs();
    const { kaos } = createTestKaos({ pathClass: 'win32' });
    const tool = new GlobTool(fs, kaos, {
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

describe.skipIf(!RG_AVAILABLE)('GlobTool integration (real ripgrep)', () => {
  // Spawns the actual `rg` binary through a real `IKaos` so the ripgrep
  // semantics the tool relies on (sort direction, recursion, brace handling,
  // cwd-relative matching) are exercised end-to-end — not just the argument
  // plumbing. Gated with `skipIf` so environments without `rg` skip cleanly.
  // The locator stays mocked (returning `rg`, found on PATH); everything below
  // it — process spawn, ripgrep itself, output parsing — is real.

  let tmpDir: string | undefined;
  let kaos: IKaos;
  let realFs: ISessionAgentFileSystem;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'glob-rg-'));
    const base = await LocalKaos.create();
    kaos = new KaosService(base.withCwd(tmpDir));
    realFs = new SessionAgentFileSystem(kaos);
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
    const tool = new GlobTool(realFs, kaos, ws());

    const result = await execute(tool, { pattern: '*.ts', path: tmpDir! });

    expect(result.output).toBe('new.ts\nmid.ts\nold.ts');
  });

  it('treats a bare pattern (no slash) as recursive across subdirectories', async () => {
    await touch('root.ts', new Date('2024-01-01T00:00:00Z'));
    await touch('src/a.ts', new Date('2023-01-01T00:00:00Z'));
    await touch('src/sub/b.ts', new Date('2022-01-01T00:00:00Z'));
    const tool = new GlobTool(realFs, kaos, ws());

    const result = await execute(tool, { pattern: '*.ts', path: tmpDir! });

    expect(result.output).toContain('root.ts');
    expect(result.output).toContain('src/a.ts');
    expect(result.output).toContain('src/sub/b.ts');
  });

  it('matches brace alternatives across directories', async () => {
    await touch('src/a.ts', new Date('2024-01-01T00:00:00Z'));
    await touch('test/a.ts', new Date('2023-01-01T00:00:00Z'));
    await touch('other/a.ts', new Date('2022-01-01T00:00:00Z'));
    const tool = new GlobTool(realFs, kaos, ws());

    const result = await execute(tool, { pattern: '{src,test}/*.ts', path: tmpDir! });

    expect(result.output).toContain('src/a.ts');
    expect(result.output).toContain('test/a.ts');
    expect(result.output).not.toContain('other/a.ts');
  });

  it('matches a recursive anchored pattern (src/**/*.ts) under an absolute search root', async () => {
    // Regression guard: with an absolute search root, ripgrep matches a
    // `--glob` pattern containing a `/` against the absolute path, so
    // `src/**/*.ts` returns nothing unless the tool runs rg from the search
    // root (cwd) with `.` as the search path.
    await touch('src/a.ts', new Date('2024-01-01T00:00:00Z'));
    await touch('src/sub/b.ts', new Date('2023-01-01T00:00:00Z'));
    await touch('other/c.ts', new Date('2022-01-01T00:00:00Z'));
    const tool = new GlobTool(realFs, kaos, ws());

    const result = await execute(tool, { pattern: 'src/**/*.ts', path: tmpDir! });

    expect(result.output).toContain('src/a.ts');
    expect(result.output).toContain('src/sub/b.ts');
    expect(result.output).not.toContain('other/c.ts');
  });

  it('treats an escaped brace as a literal filename', async () => {
    await touch('{a,b}.ts', new Date('2024-01-01T00:00:00Z'));
    const tool = new GlobTool(realFs, kaos, ws());

    const result = await execute(tool, { pattern: '\\{a,b\\}.ts', path: tmpDir! });

    expect(result.output).toContain('{a,b}.ts');
  });

  it('returns absolute paths when the search root is outside the workspace', async () => {
    const externalDir = await fs.mkdtemp(path.join(os.tmpdir(), 'glob-ext-'));
    try {
      const extFile = path.join(externalDir, 'pkg.ts');
      await fs.writeFile(extFile, '');
      const tool = new GlobTool(realFs, kaos, ws());

      const result = await execute(tool, { pattern: '*.ts', path: externalDir });

      expect(result.output).toBe(extFile);
    } finally {
      await fs.rm(externalDir, { recursive: true, force: true });
    }
  });
});
