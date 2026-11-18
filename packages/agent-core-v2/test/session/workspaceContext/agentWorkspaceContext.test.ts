import { describe, expect, it } from 'vitest';

import { Event } from '#/_base/event';
import { createScopedTestHost } from '#/_base/di/test';
import { LifecycleScope } from '#/app/scopes';
import { AgentWorkspaceContextService } from '#/session/workspaceContext/agentWorkspaceContextService';
import {
  ISessionContext,
  makeSessionContext,
} from '#/session/sessionContext/sessionContext';
import { SessionStateService } from '#/session/state/sessionStateService';
import { ISessionWorkspaceInfo } from '#/session/workspaceInfo/workspaceInfo';
import { ISessionWorkdir } from '#/session/workdir/workdir';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import {
  SessionWorkspaceContextService,
  workspaceContextAdditionalDirsKey,
  workspaceContextWorkDirKey,
} from '#/session/workspaceContext/workspaceContextService';

describe('AgentWorkspaceContextService', () => {
  it('reads the shared session roots and guards paths', () => {
    const states = new SessionStateService();
    states.contributeState(workspaceContextWorkDirKey);
    states.contributeState(workspaceContextAdditionalDirsKey);
    states.set(workspaceContextWorkDirKey, '/session/work');
    states.set(workspaceContextAdditionalDirsKey, ['/extra']);
    const context = new AgentWorkspaceContextService(states);

    expect(context.workDir).toBe('/session/work');
    expect(context.additionalDirs).toEqual(['/extra']);
    expect(context.resolve('src/index.ts')).toBe('/session/work/src/index.ts');
    expect(context.isWithin('/session/work/src')).toBe(true);
    expect(context.isWithin('/elsewhere')).toBe(false);
    expect(() => context.assertAllowed('/elsewhere', 'read')).toThrowError(/outside workspace/);
  });
});

describe('ISessionWorkspaceContext scope resolution', () => {
  it('resolves session and agent views of the shared roots', () => {
    const host = createScopedTestHost();
    try {
      const session = host.child(LifecycleScope.Session, 'session-1', [
        [ISessionContext, makeSessionContext({
          sessionId: 's',
          workspaceId: 'workspace',
          sessionDir: '/session',
          sessionScope: 'sessions/s',
          cwd: '/host/session/cwd',
        })],
        [ISessionWorkspaceInfo, {
          _serviceBrand: undefined,
          ready: Promise.resolve(),
          primaryByWorkspace: {},
          additionalDirs: [],
          onDidChange: Event.None,
        } as unknown as ISessionWorkspaceInfo],
        [ISessionWorkdir, { _serviceBrand: undefined, cwd: undefined, fs: undefined } as unknown as ISessionWorkdir],
      ]);
      const fromSession = session.accessor.get(ISessionWorkspaceContext);
      expect(fromSession).toBeInstanceOf(SessionWorkspaceContextService);
      expect(fromSession.workDir).toBe('/host/session/cwd');

      const fromAgent = host.childOf(session, LifecycleScope.Agent, 'agent-1').accessor.get(ISessionWorkspaceContext);
      expect(fromAgent).toBeInstanceOf(AgentWorkspaceContextService);
      expect(fromAgent.workDir).toBe(fromSession.workDir);
      expect(fromAgent.additionalDirs).toEqual(fromSession.additionalDirs);
    } finally {
      host.dispose();
    }
  });
});
