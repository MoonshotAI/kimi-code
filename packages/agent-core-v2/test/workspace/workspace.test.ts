import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import type { TestInstantiationService } from '#/_base/di/test';
import { IKaosFactory } from '#/kaos/kaos';
import { IWorkspaceFsService, IWorkspaceRegistry } from '#/workspace/workspace';
import { WorkspaceFsService, WorkspaceRegistry } from '#/workspace/workspaceService';
import { registerLogServices } from '../log/stubs';

describe('WorkspaceRegistry', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      base: [registerLogServices],
      additionalServices: (reg) => {
        reg.definePartialInstance(IKaosFactory, {});
        reg.define(IWorkspaceRegistry, WorkspaceRegistry);
      },
    });
  });
  afterEach(() => disposables.dispose());

  it('register / get / list', () => {
    const reg = ix.get(IWorkspaceRegistry);
    const ws = reg.register('/repo');
    expect(ws.root).toBe('/repo');
    expect(reg.get(ws.id)).toEqual(ws);
    expect(reg.list()).toEqual([ws]);
  });
});

describe('WorkspaceFsService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      base: [registerLogServices],
      additionalServices: (reg) => {
        reg.definePartialInstance(IKaosFactory, {});
        reg.define(IWorkspaceRegistry, WorkspaceRegistry);
        reg.define(IWorkspaceFsService, WorkspaceFsService);
      },
    });
  });
  afterEach(() => disposables.dispose());

  it('resolves a relative path against a registered workspace', () => {
    const reg = ix.get(IWorkspaceRegistry);
    const ws = reg.register('/repo');
    const fs = ix.createInstance(WorkspaceFsService, reg);
    expect(fs.resolve(ws.id, 'src/index.ts')).toBe('/repo/src/index.ts');
  });

  it('throws for unknown workspace', () => {
    const fs = ix.get(IWorkspaceFsService);
    expect(() => fs.resolve('nope', 'x')).toThrow(/unknown workspace/);
  });
});
