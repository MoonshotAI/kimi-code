import { describe, expect, it } from 'vitest';

import { WorkspaceFsService, WorkspaceRegistry } from '#/workspace/workspaceService';

describe('WorkspaceRegistry', () => {
  it('register / get / list', () => {
    const reg = new WorkspaceRegistry(undefined as never, undefined as never);
    const ws = reg.register('/repo');
    expect(ws.root).toBe('/repo');
    expect(reg.get(ws.id)).toEqual(ws);
    expect(reg.list()).toEqual([ws]);
  });
});

describe('WorkspaceFsService', () => {
  it('resolves a relative path against a registered workspace', () => {
    const reg = new WorkspaceRegistry(undefined as never, undefined as never);
    const ws = reg.register('/repo');
    const fs = new WorkspaceFsService(undefined as never, undefined as never, reg);
    expect(fs.resolve(ws.id, 'src/index.ts')).toBe('/repo/src/index.ts');
  });

  it('throws for unknown workspace', () => {
    const fs = new WorkspaceFsService(undefined as never, undefined as never);
    expect(() => fs.resolve('nope', 'x')).toThrow(/unknown workspace/);
  });
});
