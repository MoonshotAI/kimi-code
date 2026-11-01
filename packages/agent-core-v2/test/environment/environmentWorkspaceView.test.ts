import { describe, expect, it } from 'vitest';

import { FakeEnvironment } from '#/environment/fakeEnvironment';
import { EnvironmentWorkspaceView } from '#/environment/environmentWorkspaceView';
import { fakeEnvironment } from './stubs';

function environment(generation: string, pathClass: 'posix' | 'win32'): FakeEnvironment {
  return fakeEnvironment('local', generation, { pathClass, capabilities: [] });
}

describe('EnvironmentWorkspaceView', () => {
  it('uses win32 path semantics and rejects sibling prefixes', () => {
    const view = new EnvironmentWorkspaceView(environment('one', 'win32'), {
      workDir: 'C:\\workspace\\project',
      additionalDirs: ['D:\\shared'],
    });
    expect(view.resolve('src\\index.ts')).toBe('C:\\workspace\\project\\src\\index.ts');
    expect(view.resolve('d:\\SHARED\\file.txt')).toBe('d:\\SHARED\\file.txt');
    expect(() => view.assertAllowed(view.resolve('C:\\workspace\\project-other\\file.txt'))).toThrow('outside environment workspace');
  });

  it('keeps heterogeneous provider mappings and allowlists isolated', () => {
    const posix = new FakeEnvironment(
      { environmentId: 'remote-posix', generation: 'one' },
      { mapWorkspaceRoots: () => ({ workDir: '/provider-a/repo', additionalDirs: ['/provider-a/shared'] }) },
    );
    const win32 = new FakeEnvironment(
      { environmentId: 'remote-win32', generation: 'one' },
      {
        pathClass: 'win32',
        mapWorkspaceRoots: () => ({ workDir: 'C:\\provider-b\\repo', additionalDirs: ['D:\\provider-b\\shared'] }),
      },
    );
    const roots = { workDir: '/repo', additionalDirs: ['/shared'] };
    const posixView = new EnvironmentWorkspaceView(posix, roots);
    const win32View = new EnvironmentWorkspaceView(win32, roots);

    expect(posixView.binding.environmentId).toBe('remote-posix');
    expect(win32View.binding.environmentId).toBe('remote-win32');
    expect(posixView.resolve('/provider-a/shared/file.txt')).toBe('/provider-a/shared/file.txt');
    expect(win32View.resolve('D:\\provider-b\\shared\\file.txt')).toBe('D:\\provider-b\\shared\\file.txt');
    expect(() => posixView.assertAllowed(posixView.resolve('/provider-b/shared/file.txt'))).toThrow('outside environment workspace');
    expect(() => win32View.assertAllowed(win32View.resolve('C:\\provider-a\\repo\\file.txt'))).toThrow('outside environment workspace');
  });
});
