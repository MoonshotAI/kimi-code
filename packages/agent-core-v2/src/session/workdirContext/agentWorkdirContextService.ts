import { ref, type LiveRef } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IAgentEnvironmentService } from '#/agent/environmentBinding/agentEnvironment';
import type { EnvironmentWorkspaceRoots } from '#/environment/environment';
import { ISessionStateService } from '#/session/state/sessionState';

import { ISessionWorkdirContext, type PathAccessOperation } from './workdirContext';
import {
  workdirContextAdditionalDirsKey,
  workdirContextWorkDirKey,
} from './workdirContextService';
import {
  assertWorkdirAllowed,
  hostWorkdirPathSemantics,
  isWithinWorkdir,
  resolveWorkdirPath,
  type WorkdirPathSemantics,
} from './workdirPaths';

export class AgentWorkdirContextService implements ISessionWorkdirContext {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionStateService private readonly states: ISessionStateService,
    @ref(IAgentEnvironmentService) private readonly environment: LiveRef<IAgentEnvironmentService>,
  ) {}

  private roots(): EnvironmentWorkspaceRoots {
    const environment = this.environment.current;
    if (environment === undefined) {
      return {
        workDir: this.states.get(workdirContextWorkDirKey),
        additionalDirs: this.states.get(workdirContextAdditionalDirsKey),
      };
    }
    return environment.workspaceRoots();
  }

  private pathSemantics(): WorkdirPathSemantics {
    const environment = this.environment.current;
    if (environment !== undefined) {
      try {
        return environment.inspect().path ?? hostWorkdirPathSemantics;
      } catch {
        return hostWorkdirPathSemantics;
      }
    }
    return hostWorkdirPathSemantics;
  }

  get workDir(): string {
    return this.roots().workDir;
  }

  get additionalDirs(): readonly string[] {
    return this.roots().additionalDirs ?? [];
  }

  setWorkDir(workDir: string): void {
    this.states.set(workdirContextWorkDirKey, workDir);
  }

  resolve(rel: string): string {
    return resolveWorkdirPath(this.pathSemantics(), this.workDir, rel);
  }

  isWithin(absPath: string): boolean {
    return isWithinWorkdir(this.pathSemantics(), this.workDir, this.additionalDirs, absPath);
  }

  assertAllowed(absPath: string, op: PathAccessOperation): string {
    return assertWorkdirAllowed(this.pathSemantics(), this.workDir, this.additionalDirs, absPath, op);
  }
}

registerScopedService(
  LifecycleScope.Agent,
  ISessionWorkdirContext,
  AgentWorkdirContextService,
  ScopeActivation.OnDemand,
  'workspaceContext',
);
