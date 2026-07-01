/**
 * `session` domain (L6) — `ISessionWarningService` implementation.
 *
 * Aggregates session-level warnings. Today the only source is the
 * `agents-md-oversized` warning, computed from the AGENTS.md hierarchy via
 * `prepareSystemPromptContext` (the same soft budget used when the system
 * prompt is assembled). The main agent's cached value (populated by
 * `IAgentProfileService.applyProfile`) is preferred when the agent is live;
 * otherwise the warning is recomputed on demand. Bound at Session scope.
 */

import type { SessionWarning } from '@moonshot-ai/protocol';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentLifecycleService } from '#/session/agent-lifecycle';
import { IBootstrapService } from '#/app/bootstrap';
import { IHostEnvironment } from '#/app/hostEnvironment';
import { ISessionAgentFileSystem } from '#/session/agentFs';
import { IExecContext } from '#/session/execContext';
import { IAgentProfileService, prepareSystemPromptContext } from '#/agent/profile';
import { ISessionWorkspaceContext } from '#/session/workspaceContext';

import { ISessionWarningService } from './sessionWarning';

const MAIN_AGENT_ID = 'main';
const AGENTS_MD_OVERSIZED_CODE = 'agents-md-oversized';

export class SessionWarningService implements ISessionWarningService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IHostEnvironment private readonly env: IHostEnvironment,
    @ISessionAgentFileSystem private readonly fs: ISessionAgentFileSystem,
    @IExecContext private readonly ctx: IExecContext,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
  ) {}

  async getSessionWarnings(): Promise<readonly SessionWarning[]> {
    const agentsMdWarning = await this.resolveAgentsMdWarning();
    if (agentsMdWarning === undefined) return [];
    return [
      {
        code: AGENTS_MD_OVERSIZED_CODE,
        message: agentsMdWarning,
        severity: 'warning',
      },
    ];
  }

  private async resolveAgentsMdWarning(): Promise<string | undefined> {
    const cached = this.readMainAgentWarning();
    if (cached !== undefined) return cached;
    // No live main agent (or it has not applied a profile yet): recompute on
    // demand so the warning still surfaces for long-lived / resumed sessions.
    try {
      const context = await prepareSystemPromptContext(
        { fs: this.fs, homeDir: this.env.homeDir },
        this.ctx.cwd,
        this.bootstrap.homeDir,
        {
          additionalDirs: this.workspace.additionalDirs,
        },
      );
      return context.agentsMdWarning;
    } catch {
      // Best-effort: warning retrieval must not throw to the caller.
      return undefined;
    }
  }

  private readMainAgentWarning(): string | undefined {
    const main = this.agentLifecycle.getHandle(MAIN_AGENT_ID);
    if (main === undefined) return undefined;
    return main.accessor.get(IAgentProfileService).getAgentsMdWarning();
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionWarningService,
  SessionWarningService,
  InstantiationType.Delayed,
  'sessionWarning',
);
