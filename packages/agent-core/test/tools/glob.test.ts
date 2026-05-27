import { describe, expect, it, vi } from 'vitest';

import { type GlobInput, GlobInputSchema, GlobTool, MAX_MATCHES } from '../../src/tools/builtin/file/glob';
import type { WorkspaceConfig } from '../../src/tools/support/workspace';
import { createFakeKaos } from './fixtures/fake-kaos';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;
const workspace: WorkspaceConfig = { workspaceDir: '/workspace', additionalDirs: ['/extra'] };

async function* asyncPaths(paths: readonly string[]) {
  for (const item of paths) yield item;
}

function stat(mtime: number, mode = 0o100000) {
  return { stMtime: mtime, stMode: mode };
}

function context(args: GlobInput) {
  return { turnId: '0', toolCallId: 'call_glob', args, signal };
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

  it('exposes the include_dirs default in its JSON Schema without making it required', () => {
    const tool = new GlobTool(createFakeKaos(), workspace);
    const schema = tool.parameters as {
      properties: { include_dirs: { default?: unknown } };
      required?: string[];
    };

    // The default must be structurally visible to the model, not only
    // described in prose, so it survives without an explicit argument.
    expect(schema.properties.include_dirs.default).toBe(true);
    // A default value must not promote include_dirs into `required`.
    expect(schema.required ?? []).not.toContain('include_dirs');
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

  it('returns matching paths sorted by mtime and relative to an explicit search root', async () => {
    const glob = vi
      .fn()
      .mockReturnValue(asyncPaths(['/workspace/src/old.ts', '/workspace/src/new.ts']));
    const tool = new GlobTool(
      createFakeKaos({
        glob,
        stat: vi.fn().mockResolvedValueOnce(stat(1)).mockResolvedValueOnce(stat(10)),
      }),
      workspace,
    );

    const result = await executeTool(tool, context({ pattern: 'src/**/*.ts', path: '/workspace' }));

    expect(result.output).toBe('src/new.ts\nsrc/old.ts');
    expect(glob).toHaveBeenCalledWith('/workspace', 'src/**/*.ts');
  });

  it('uses the backend path class when displaying paths relative to a windows root', async () => {
    const glob = vi.fn().mockReturnValue(asyncPaths(['C:\\workspace\\src\\old.ts']));
    const tool = new GlobTool(
      createFakeKaos({
        pathClass: () => 'win32',
        glob,
        stat: vi.fn().mockResolvedValue(stat(1)),
      }),
      { workspaceDir: 'C:\\workspace', additionalDirs: [] },
    );

    const result = await executeTool(tool, context({ pattern: 'src/**/*.ts', path: 'C:\\WORKSPACE' }));

    expect(result.output).toBe('src/old.ts');
    expect(glob).toHaveBeenCalledWith('C:/WORKSPACE', 'src/**/*.ts');
  });

  it('rejects pure wildcard patterns before walking the tree', async () => {
    const glob = vi.fn();
    const tool = new GlobTool(
      createFakeKaos({
        glob,
        iterdir: vi.fn().mockReturnValue(asyncPaths(['/workspace/src'])),
        stat: vi.fn().mockResolvedValue(stat(0, 0o040000)),
      }),
      workspace,
    );

    const result = await executeTool(tool, context({ pattern: '**' }));

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('pure wildcard');
    expect(result.output).toContain('/workspace');
    expect(glob).not.toHaveBeenCalled();
  });

  it('rejects brace expansion patterns with a clear split-call hint', async () => {
    const glob = vi.fn();
    const tool = new GlobTool(createFakeKaos({ glob }), workspace);

    const result = await executeTool(tool, context({ pattern: '*.{ts,tsx}' }));

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('brace expansion');
    expect(result.output).toContain('Split it into separate calls');
    expect(glob).not.toHaveBeenCalled();
  });

  it('searches only the current workspace when path is omitted', async () => {
    const glob = vi.fn().mockReturnValue(asyncPaths(['/workspace/a.ts', '/workspace/shared.ts']));
    const tool = new GlobTool(
      createFakeKaos({
        glob,
        stat: vi.fn().mockResolvedValue(stat(1)),
      }),
      workspace,
    );

    const result = await executeTool(tool, context({ pattern: '*.ts' }));

    expect(glob).toHaveBeenCalledTimes(1);
    expect(glob).toHaveBeenCalledWith('/workspace', '*.ts');
    expect(result.output).toBe('a.ts\nshared.ts');
  });

  it('can search an additional directory when path is explicit', async () => {
    const glob = vi.fn().mockReturnValue(asyncPaths(['/extra/pkg/a.ts']));
    const tool = new GlobTool(
      createFakeKaos({ glob, stat: vi.fn().mockResolvedValue(stat(1)) }),
      workspace,
    );

    const result = await executeTool(tool, context({ pattern: 'pkg/**/*.ts', path: '/extra' }));

    expect(result.output).toBe('pkg/a.ts');
    expect(glob).toHaveBeenCalledTimes(1);
    expect(glob).toHaveBeenCalledWith('/extra', 'pkg/**/*.ts');
  });

  it('filters directories when include_dirs is false', async () => {
    const glob = vi.fn().mockReturnValue(asyncPaths(['/workspace/src', '/workspace/src/a.ts']));
    const tool = new GlobTool(
      createFakeKaos({
        glob,
        stat: vi
          .fn()
          .mockResolvedValueOnce(stat(2, 0o040000))
          .mockResolvedValueOnce(stat(1, 0o100000)),
      }),
      workspace,
    );

    const result = await executeTool(tool,
      context({ pattern: 'src*', path: '/workspace', include_dirs: false }),
    );

    expect(result.output).toBe('src/a.ts');
  });

  it('caps returned matches and surfaces the truncation header', async () => {
    const paths = Array.from({ length: MAX_MATCHES + 1 }, (_, i) => `/workspace/${String(i)}.ts`);
    const tool = new GlobTool(
      createFakeKaos({
        glob: vi.fn().mockReturnValue(asyncPaths(paths)),
        stat: vi.fn().mockResolvedValue(stat(1)),
      }),
      { workspaceDir: '/workspace', additionalDirs: [] },
    );

    const result = await executeTool(tool, context({ pattern: '*.ts' }));

    expect(result.output).toContain(`[Truncated at ${String(MAX_MATCHES)} matches`);
    expect(result.output).toContain('0.ts');
    expect(result.output).not.toContain(`${String(MAX_MATCHES)}.ts`);
  });

  describe('skills / additional dirs', () => {
    const skillsWorkspace: WorkspaceConfig = {
      workspaceDir: '/workspace',
      additionalDirs: ['/skills'],
    };

    it('searches inside a registered additionalDir entry', async () => {
      const glob = vi
        .fn()
        .mockReturnValue(asyncPaths(['/skills/read_content.py', '/skills/utils.py']));
      const tool = new GlobTool(
        createFakeKaos({ glob, stat: vi.fn().mockResolvedValue(stat(1)) }),
        skillsWorkspace,
      );

      const result = await executeTool(tool, context({ pattern: '*.py', path: '/skills' }));

      expect(result.output).toContain('read_content.py');
      expect(result.output).toContain('utils.py');
      expect(glob).toHaveBeenCalledWith('/skills', '*.py');
    });

    it('searches inside a subdirectory of an additionalDir entry', async () => {
      const glob = vi
        .fn()
        .mockReturnValue(asyncPaths(['/skills/feishu/scripts/read_content.py']));
      const tool = new GlobTool(
        createFakeKaos({ glob, stat: vi.fn().mockResolvedValue(stat(1)) }),
        skillsWorkspace,
      );

      const result = await executeTool(tool,
        context({ pattern: '*.py', path: '/skills/feishu/scripts' }),
      );

      expect(result.output).toContain('read_content.py');
    });

    it('rejects a relative path that escapes both workspace and additionalDirs', async () => {
      const glob = vi.fn();
      const tool = new GlobTool(createFakeKaos({ glob }), {
        workspaceDir: '/workspace/project',
        additionalDirs: ['/skills'],
      });

      const result = await executeTool(tool, context({ pattern: '*.py', path: '../../tmp/evil' }));

      expect(result).toMatchObject({ isError: true });
      expect(result.output).toContain('absolute path');
      expect(glob).not.toHaveBeenCalled();
    });

    it('accepts a path inside a deeply nested additionalDir entry', async () => {
      const glob = vi
        .fn()
        .mockReturnValue(asyncPaths(['/skills/my-skill/scripts/helper.py']));
      const tool = new GlobTool(
        createFakeKaos({ glob, stat: vi.fn().mockResolvedValue(stat(1)) }),
        skillsWorkspace,
      );

      const result = await executeTool(tool,
        context({ pattern: '*.py', path: '/skills/my-skill/scripts' }),
      );

      expect(result.output).toContain('helper.py');
    });
  });

  it('rejects "**/" prefix patterns even with a literal anchor', async () => {
    // py rejects every pattern starting with "**/". TS only rejects pure-
    // wildcard patterns and accepts "**/*.py" because the `.py` literal
    // anchors the walk. Test as a lockdown of the py contract — expected
    // to fail under the current TS policy.
    const glob = vi.fn();
    const tool = new GlobTool(
      createFakeKaos({
        glob,
        iterdir: vi.fn().mockReturnValue(asyncPaths([])),
        stat: vi.fn().mockResolvedValue(stat(0, 0o040000)),
      }),
      workspace,
    );

    const result = await executeTool(tool, context({ pattern: '**/*.py' }));

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toMatch(/starts with '\*\*' which is not allowed/);
  });

  it('walks safe recursive patterns with a literal subdirectory anchor', async () => {
    const glob = vi.fn().mockReturnValue(
      asyncPaths([
        '/workspace/src/main.py',
        '/workspace/src/utils.py',
        '/workspace/src/main/app.py',
        '/workspace/src/main/config.py',
        '/workspace/src/test/test_app.py',
        '/workspace/src/test/test_config.py',
      ]),
    );
    const tool = new GlobTool(
      createFakeKaos({ glob, stat: vi.fn().mockResolvedValue(stat(1)) }),
      workspace,
    );

    const result = await executeTool(tool, context({ pattern: 'src/**/*.py', path: '/workspace' }));

    expect(result.output).toContain('src/main.py');
    expect(result.output).toContain('src/utils.py');
    expect(result.output).toContain('src/main/app.py');
    expect(result.output).toContain('src/main/config.py');
    expect(result.output).toContain('src/test/test_app.py');
    expect(result.output).toContain('src/test/test_config.py');
  });

  it('surfaces an explicit no-match message when no paths are yielded', async () => {
    const glob = vi.fn().mockReturnValue(asyncPaths([]));
    const tool = new GlobTool(createFakeKaos({ glob }), workspace);

    const result = await executeTool(tool, context({ pattern: '*.xyz', path: '/workspace' }));

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('No matches found');
  });

  it('reports "does not exist" when the search directory is missing', async () => {
    // Real kaos.glob silently returns empty for a missing root because
    // its _globWalk catches readdir failures. The tool now pre-checks
    // with iterdir so ENOENT surfaces before glob runs. Realistic mock:
    // iterdir throws ENOENT, glob is never called.
    const iterdir = vi.fn(async function* (): AsyncGenerator<string> {
      await Promise.resolve();
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
      yield ''; // eslint-disable-line no-unreachable -- satisfies require-yield
    });
    const glob = vi.fn();
    const tool = new GlobTool(createFakeKaos({ iterdir, glob }), workspace);

    const result = await executeTool(tool,
      context({ pattern: '*.py', path: '/workspace/nonexistent' }),
    );

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('does not exist');
    expect(glob).not.toHaveBeenCalled();
  });

  it('reports "is not a directory" when the search target is a file', async () => {
    // Real kaos.glob silently returns empty when the root is a regular
    // file because its _globWalk's readdir hits ENOTDIR and exits. The
    // pre-check uses iterdir, which raises ENOTDIR on file-as-dir.
    // Realistic mock: iterdir throws ENOTDIR, glob is never called.
    const iterdir = vi.fn(async function* (): AsyncGenerator<string> {
      await Promise.resolve();
      throw Object.assign(new Error('ENOTDIR: not a directory'), { code: 'ENOTDIR' });
      yield ''; // eslint-disable-line no-unreachable -- satisfies require-yield
    });
    const glob = vi.fn();
    const tool = new GlobTool(createFakeKaos({ iterdir, glob }), workspace);

    const result = await executeTool(tool, context({ pattern: '*.py', path: '/workspace/file.txt' }));

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('is not a directory');
    expect(glob).not.toHaveBeenCalled();
  });

  it('surfaces a "first N matches" header when matches exceed MAX_MATCHES', async () => {
    const paths = Array.from(
      { length: MAX_MATCHES + 50 },
      (_, i) => `/workspace/file_${String(i)}.txt`,
    );
    const tool = new GlobTool(
      createFakeKaos({
        glob: vi.fn().mockReturnValue(asyncPaths(paths)),
        stat: vi.fn().mockResolvedValue(stat(1)),
      }),
      { workspaceDir: '/workspace', additionalDirs: [] },
    );

    const result = await executeTool(tool, context({ pattern: '*.txt' }));

    expect(result.output).toContain(`Only the first ${String(MAX_MATCHES)} matches are returned`);
  });

  it('includes a directory listing in the rejection message for "**/" patterns', async () => {
    // py rejection includes the top-level directory listing as a hint.
    const iterdir = vi
      .fn()
      .mockReturnValue(asyncPaths(['/workspace/file1.txt', '/workspace/file2.py', '/workspace/src', '/workspace/docs']));
    const glob = vi.fn();
    const tool = new GlobTool(
      createFakeKaos({
        glob,
        iterdir,
        stat: vi.fn().mockResolvedValue(stat(0, 0o100000)),
      }),
      workspace,
    );

    const result = await executeTool(tool, context({ pattern: '**/*.txt' }));

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toMatch(/starts with '\*\*' which is not allowed/);
    expect(result.output).toContain('Use more specific patterns instead');
    expect(result.output).toContain('file1.txt');
    expect(result.output).toContain('file2.py');
    expect(result.output).toContain('src');
    expect(result.output).toContain('docs');
  });

  it('returns a "Found N matches" footer at exactly MAX_MATCHES without truncation', async () => {
    const paths = Array.from(
      { length: MAX_MATCHES },
      (_, i) => `/workspace/test_${String(i)}.py`,
    );
    const tool = new GlobTool(
      createFakeKaos({
        glob: vi.fn().mockReturnValue(asyncPaths(paths)),
        stat: vi.fn().mockResolvedValue(stat(1)),
      }),
      { workspaceDir: '/workspace', additionalDirs: [] },
    );

    const result = await executeTool(tool, context({ pattern: '*.py' }));

    expect(result.output).not.toContain('Only the first');
    expect(result.output).toContain(`Found ${String(MAX_MATCHES)} matches`);
  });

  it('rejects "**/" patterns with literal subdirectory anchors after the prefix', async () => {
    const glob = vi.fn();
    const tool = new GlobTool(
      createFakeKaos({
        glob,
        iterdir: vi.fn().mockReturnValue(asyncPaths([])),
        stat: vi.fn().mockResolvedValue(stat(0, 0o040000)),
      }),
      workspace,
    );

    const result = await executeTool(tool, context({ pattern: '**/main/*.py' }));

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toMatch(/starts with '\*\*' which is not allowed/);
    expect(glob).not.toHaveBeenCalled();
  });

  it('matches dotfiles like .gitlab-ci.yml under a simple "*.yml" pattern', async () => {
    const glob = vi
      .fn()
      .mockReturnValue(asyncPaths(['/workspace/.gitlab-ci.yml', '/workspace/config.yml']));
    const tool = new GlobTool(
      createFakeKaos({ glob, stat: vi.fn().mockResolvedValue(stat(1)) }),
      workspace,
    );

    const result = await executeTool(tool, context({ pattern: '*.yml' }));

    expect(result.output).toContain('.gitlab-ci.yml');
    expect(result.output).toContain('config.yml');
  });

  it('descends into hidden directories under a recursive pattern', async () => {
    const glob = vi.fn().mockReturnValue(asyncPaths(['/workspace/src/.config/settings.yml']));
    const tool = new GlobTool(
      createFakeKaos({ glob, stat: vi.fn().mockResolvedValue(stat(1)) }),
      workspace,
    );

    const result = await executeTool(tool, context({ pattern: 'src/**/*.yml' }));

    expect(result.output).toContain('src/.config/settings.yml');
  });

  it('matches files inside an explicitly addressed hidden directory', async () => {
    const glob = vi.fn().mockReturnValue(asyncPaths(['/workspace/.github/workflows/ci.yml']));
    const tool = new GlobTool(
      createFakeKaos({ glob, stat: vi.fn().mockResolvedValue(stat(1)) }),
      workspace,
    );

    const result = await executeTool(tool, context({ pattern: '.github/**/*.yml' }));

    expect(result.output).toContain('.github/workflows/ci.yml');
  });

  it('picks up a freshly appended additionalDir without rebuilding the tool', async () => {
    // py rejects `/extra` before it is registered in additional_dirs, then
    // allows it after a runtime append. TS Glob runs with the
    // `absolute-outside-allowed` policy so the first call is NOT rejected.
    // Divergence lockdown — captures the cost of TS's looser default.
    const additionalDirs: string[] = [];
    const mutable: WorkspaceConfig = { workspaceDir: '/workspace', additionalDirs };
    const glob = vi.fn((root: string) =>
      asyncPaths(root === '/extra' ? ['/extra/test.py'] : []),
    );
    const tool = new GlobTool(
      createFakeKaos({ glob, stat: vi.fn().mockResolvedValue(stat(1)) }),
      mutable,
    );

    const before = await executeTool(tool, context({ pattern: '*.py', path: '/extra' }));
    expect(before).toMatchObject({ isError: true });
    expect(before.output).toContain('outside the working directory');

    additionalDirs.push('/extra');

    const after = await executeTool(tool, context({ pattern: '*.py', path: '/extra' }));
    expect(after.isError).toBeFalsy();
    expect(after.output).toContain('test.py');
  });

  it('rejects a relative path argument before resolving it against any cwd', async () => {
    // py rejects any relative `directory` outright with "not an absolute
    // path". TS currently joins relative paths onto the workspace cwd and
    // proceeds — divergence lockdown.
    const glob = vi.fn().mockReturnValue(asyncPaths([]));
    const tool = new GlobTool(
      createFakeKaos({ glob, stat: vi.fn().mockResolvedValue(stat(1)) }),
      workspace,
    );

    const result = await executeTool(tool, context({ pattern: '*.py', path: 'relative/path' }));

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('not an absolute path');
  });

  it('expands a leading "~/" path before applying the workspace guard', async () => {
    // py: `~/` is expanded to the home dir, which is outside the
    // workspace; the guard then rejects with "outside the workspace".
    // The key invariant under test is that tilde expansion happens BEFORE
    // the absolute-path check — otherwise the user would see the misleading
    // "not an absolute path" error. TS currently runs Glob with
    // `absolute-outside-allowed` so the workspace check does NOT reject
    // outside paths once tilde expansion makes them absolute — divergence
    // lockdown.
    const glob = vi.fn().mockReturnValue(asyncPaths([]));
    const tool = new GlobTool(
      createFakeKaos({ glob, gethome: () => '/home/test', stat: vi.fn().mockResolvedValue(stat(1)) }),
      { workspaceDir: '/workspace', additionalDirs: [] },
    );

    const result = await executeTool(tool, context({ pattern: '*.py', path: '~/' }));

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('outside the workspace');
    expect(result.output).not.toContain('not an absolute path');
  });

  it('rejects a path sharing the workspace prefix but outside it', async () => {
    // py rejects shared-prefix outside paths with "outside the workspace".
    // TS Glob uses `absolute-outside-allowed`, so an absolute path outside
    // the workspace is accepted by design. Divergence lockdown.
    const glob = vi.fn().mockReturnValue(asyncPaths([]));
    const tool = new GlobTool(
      createFakeKaos({ glob, stat: vi.fn().mockResolvedValue(stat(1)) }),
      { workspaceDir: '/parent/workdir', additionalDirs: [] },
    );

    const result = await executeTool(tool,
      context({ pattern: '*.py', path: '/parent/workdir-sneaky' }),
    );

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toMatch(/outside the workspace|outside the working directory/);
  });

  it('locks down rejection phrasing and large-directory caveats in the description', () => {
    const tool = new GlobTool(createFakeKaos(), workspace);

    expect(tool.description).toContain('**');
    expect(tool.description).toMatch(/\*\*\/\*\.py/);
    expect(tool.description).toContain('node_modules');
    expect(tool.description).not.toContain('On Windows');
  });

  it('mentions Windows path forms in the description on win32 backends', () => {
    // py emits an OS-conditional hint about C:\Users\foo and /c/Users/foo
    // forms; TS currently uses a single static description.
    const tool = new GlobTool(createFakeKaos({ pathClass: () => 'win32' }), {
      workspaceDir: 'C:\\workspace',
      additionalDirs: [],
    });

    expect(tool.description).toContain('C:\\Users\\foo');
    expect(tool.description).toContain('/c/Users/foo');
  });
});
