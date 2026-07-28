import { isAbsolute, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { ErrorCodes, Error2 } from '#/errors';
import { makeSessionContext, ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionStateService } from '#/session/state/sessionState';
import { SessionStateService } from '#/session/state/sessionStateService';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { SessionWorkspaceContextService } from '#/session/workspaceContext/workspaceContextService';

function stubSessionContext(cwd: string = '/repo'): ISessionContext {
  return makeSessionContext({
    sessionId: 's1',
    workspaceId: 'w1',
    sessionDir: '/repo/.session',
    sessionScope: 'session:s1',
    cwd,
  });
}

describe('SessionWorkspaceContextService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(ISessionContext, stubSessionContext());
        reg.defineInstance(ISessionStateService, new SessionStateService());
        reg.define(ISessionWorkspaceContext, SessionWorkspaceContextService);
      },
    });
  });

  afterEach(() => disposables.dispose());

  it('resolves relative paths against the session work dir', () => {
    const workspace = ix.get(ISessionWorkspaceContext);

    expect(workspace.resolve('src/index.ts')).toBe(resolve('/repo/src/index.ts'));
    expect(workspace.assertAllowed('src/index.ts', 'read')).toBe(resolve('/repo/src/index.ts'));
  });

  it('throws a coded error when a path escapes the workspace', () => {
    const workspace = ix.get(ISessionWorkspaceContext);
    const escapingPath = resolve('/repo/../outside');

    expect(() => workspace.assertAllowed('../outside', 'execute')).toThrow(Error2);

    try {
      workspace.assertAllowed('../outside', 'execute');
      throw new Error('expected assertAllowed to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(Error2);
      const coded = err as Error2;
      expect(coded.code).toBe(ErrorCodes.WORKSPACE_CONTEXT_PATH_ESCAPES);
      expect(coded.message).toBe('Path outside workspace');
      expect(coded.details).toEqual({ path: escapingPath, op: 'execute' });
    }
  });

  it('allows paths inside additional dirs', () => {
    const workspace = ix.get(ISessionWorkspaceContext);
    workspace.setAdditionalDirs(['/extra']);

    const target = workspace.assertAllowed('/extra/file.txt', 'read');

    expect(isAbsolute(target)).toBe(true);
    expect(target).toBe(resolve('/extra/file.txt'));
  });
});
