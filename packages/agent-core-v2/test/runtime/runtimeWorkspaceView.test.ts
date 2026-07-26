import { describe, expect, it } from 'vitest';

import { FakeRuntime } from '#/runtime/fakeRuntime';
import { RuntimeWorkspaceView } from '#/runtime/runtimeWorkspaceView';

function runtime(generation: string, pathClass: 'posix' | 'win32'): FakeRuntime {
  return new FakeRuntime(
    { workspaceId: 'workspace', runtimeId: 'local', generation },
    { pathClass },
  );
}

describe('RuntimeWorkspaceView', () => {
  it('resolves posix paths within the fixed runtime roots', () => {
    const view = new RuntimeWorkspaceView(runtime('one', 'posix'), {
      workDir: '/workspace/project',
      additionalDirs: ['/shared'],
    });
    expect(view.resolve('src/index.ts')).toBe('/workspace/project/src/index.ts');
    expect(view.resolve('../shared/file.txt', '/workspace/project/src')).toBe('/workspace/project/shared/file.txt');
    expect(view.resolve('/shared/file.txt')).toBe('/shared/file.txt');
    expect(() => view.resolve('../../outside')).toThrow('outside runtime workspace');
  });

  it('uses win32 path semantics and rejects sibling prefixes', () => {
    const view = new RuntimeWorkspaceView(runtime('one', 'win32'), {
      workDir: 'C:\\workspace\\project',
      additionalDirs: ['D:\\shared'],
    });
    expect(view.resolve('src\\index.ts')).toBe('C:\\workspace\\project\\src\\index.ts');
    expect(view.resolve('d:\\SHARED\\file.txt')).toBe('d:\\SHARED\\file.txt');
    expect(() => view.resolve('C:\\workspace\\project-other\\file.txt')).toThrow('outside runtime workspace');
  });

  it('uses provider-owned workspace root mapping', () => {
    const mapped = new FakeRuntime(
      { workspaceId: 'workspace', runtimeId: 'remote', generation: 'one' },
      {
        mapWorkspaceRoots: (roots) => ({
          workDir: roots.workDir.replace('/repo', '/remote/workspace'),
          additionalDirs: roots.additionalDirs?.map((root) => root.replace('/shared', '/remote/shared')),
        }),
      },
    );
    const view = new RuntimeWorkspaceView(mapped, {
      workDir: '/repo/project',
      additionalDirs: ['/shared/assets'],
    });
    expect(view.workDir).toBe('/remote/workspace/project');
    expect(view.additionalDirs).toEqual(['/remote/shared/assets']);
    expect(view.resolve('src/index.ts')).toBe('/remote/workspace/project/src/index.ts');
  });

  it('keeps heterogeneous provider mappings and allowlists isolated', () => {
    const posix = new FakeRuntime(
      { workspaceId: 'workspace', runtimeId: 'remote-posix', generation: 'one' },
      { mapWorkspaceRoots: () => ({ workDir: '/provider-a/repo', additionalDirs: ['/provider-a/shared'] }) },
    );
    const win32 = new FakeRuntime(
      { workspaceId: 'workspace', runtimeId: 'remote-win32', generation: 'one' },
      {
        pathClass: 'win32',
        mapWorkspaceRoots: () => ({ workDir: 'C:\\provider-b\\repo', additionalDirs: ['D:\\provider-b\\shared'] }),
      },
    );
    const roots = { workDir: '/repo', additionalDirs: ['/shared'] };
    const posixView = new RuntimeWorkspaceView(posix, roots);
    const win32View = new RuntimeWorkspaceView(win32, roots);

    expect(posixView.binding.runtimeId).toBe('remote-posix');
    expect(win32View.binding.runtimeId).toBe('remote-win32');
    expect(posixView.resolve('/provider-a/shared/file.txt')).toBe('/provider-a/shared/file.txt');
    expect(win32View.resolve('D:\\provider-b\\shared\\file.txt')).toBe('D:\\provider-b\\shared\\file.txt');
    expect(() => posixView.resolve('/provider-b/shared/file.txt')).toThrow('outside runtime workspace');
    expect(() => win32View.resolve('C:\\provider-a\\repo\\file.txt')).toThrow('outside runtime workspace');
  });

  it('translates Git Bash POSIX paths on win32 bash runtimes', () => {
    const winBash = new FakeRuntime(
      { workspaceId: 'workspace', runtimeId: 'local', generation: 'one' },
      {
        pathClass: 'win32',
        environment: {
          osKind: 'Windows',
          shellName: 'bash',
          shellPath: 'C:\\kimi-test-nonexistent\\Git\\bin\\bash.exe',
        },
      },
    );
    const view = new RuntimeWorkspaceView(winBash, {
      workDir: 'C:\\workspace\\project',
      additionalDirs: [],
    });
    expect(view.resolve('/c/workspace/project/src/index.ts')).toBe('C:\\workspace\\project\\src\\index.ts');
    expect(view.resolve('/cygdrive/c/workspace/project/package.json')).toBe(
      'C:\\workspace\\project\\package.json',
    );
    expect(() => view.resolve('/tmp/scratch.txt')).toThrow('outside runtime workspace');
  });

  it('deduplicates roots and preserves generation identity', () => {
    const first = new RuntimeWorkspaceView(runtime('one', 'posix'), {
      workDir: '/workspace',
      additionalDirs: ['/shared', '/shared'],
    });
    const second = new RuntimeWorkspaceView(runtime('two', 'posix'), {
      workDir: '/workspace',
      additionalDirs: ['/shared'],
    });
    expect(first.roots).toEqual(['/workspace', '/shared']);
    expect(first.binding).toEqual({ workspaceId: 'workspace', runtimeId: 'local' });
    expect(first.generation).toBe('one');
    expect(second.generation).toBe('two');
    expect(second.runtime).not.toBe(first.runtime);
  });
});
