/**
 * `sessionLegacy` domain — `ISessionLegacyService` implementation.
 *
 * Stateless App-scope dispatcher: each method resolves the target session (and
 * its main agent) per call, delegates to the native v2 services, and projects
 * the result into the v1 wire shape. Only `updateProfile` (the cross-domain
 * `agent_config` patch), `status` (the best-effort status rollup), and `goal`
 * (the current-goal read) live here;
 * the `:undo`, `fork`-as-child, and child-listing actions were pushed down into
 * the native services (`IAgentPromptService.undo`,
 * `ISessionLifecycleService.createChild`, `ISessionIndex.list({ childOf })`) and
 * are called by the edge route directly. No business logic is duplicated here;
 * the real work stays in the native services.
 */

import type {
  GoalSnapshot,
  SessionStatusResponse,
  UpdateSessionProfileRequest,
} from '@moonshot-ai/protocol';

import { InstantiationType } from '#/_base/di/extensions';
import { type IAgentScopeHandle, LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentContextSizeService } from '#/agent/contextSize/contextSize';
import { IAgentGoalService } from '#/agent/goal/goal';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import { IAgentPlanService } from '#/agent/plan/plan';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentSwarmService } from '#/agent/swarm/swarm';
import { IConfigService } from '#/app/config/config';
import { IModelResolver } from '#/app/model/modelResolver';
import { ISessionLifecycleService } from '#/app/sessionLifecycle/sessionLifecycle';
import { ErrorCodes, Error2 } from '#/errors';
import { ensureMainAgent } from '#/session/agentLifecycle/mainAgent';
import { ISessionActivity } from '#/session/sessionActivity/sessionActivity';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';

import { ISessionLegacyService, type SessionWireFields } from './sessionLegacy';

export class SessionLegacyService implements ISessionLegacyService {
  declare readonly _serviceBrand: undefined;

  constructor(@ISessionLifecycleService private readonly lifecycle: ISessionLifecycleService) {}

  async updateProfile(
    sessionId: string,
    body: UpdateSessionProfileRequest,
  ): Promise<SessionWireFields> {
    const session = await this.lifecycle.resume(sessionId);
    if (session === undefined) {
      throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
    }
    const metadata = session.accessor.get(ISessionMetadata);

    if (typeof body.title === 'string') {
      await metadata.setTitle(body.title);
    }

    // v1 `ISessionService.update` writes the wire metadata patch straight into
    // `custom` (replace, not deep-merge); `toProtocolSession` then spreads
    // `custom` back onto the wire `Session.metadata`. An empty patch is a no-op
    // (matches v1's `Object.keys(...).length > 0` guard).
    const metadataPatch = body.metadata;
    if (metadataPatch !== undefined && Object.keys(metadataPatch).length > 0) {
      await metadata.update({ custom: { ...(metadataPatch as Record<string, unknown>) } });
    }

    const agentConfig = body.agent_config;
    if (agentConfig !== undefined) {
      const agent = await this.resolveMainAgent(sessionId);
      await this.applyAgentConfig(agent, agentConfig);
    }

    const meta = await metadata.read();
    // `ISessionContext` carries the frozen work dir (gap G3 closed), so an
    // unregistered workspace does not collapse `cwd` here — matches v1, which
    // stores `workDir` on the session itself.
    const ctx = session.accessor.get(ISessionContext);
    return {
      id: meta.id,
      workspaceId: ctx.workspaceId,
      root: ctx.cwd,
      title: meta.title,
      lastPrompt: meta.lastPrompt,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      archived: meta.archived,
      custom: meta.custom,
    };
  }

  // --- internals -------------------------------------------------------------

  /**
   * Apply the v1 `agent_config` patch onto the main agent. Mirrors v1's
   * `IPromptService.applyAgentState` (`promptService.ts:650-743`) in both order
   * (model → thinking → permission → plan → swarm → goal) and diff behaviour:
   * the non-idempotent `plan.enter` / `swarm.enter` are guarded behind a state
   * read so a repeated `true` does not throw ('Already in plan mode'); the
   * idempotent setters (model / thinking / permission) fire directly. Goal
   * actions are one-shot and let domain errors (`goal.*`) propagate to the
   * route's `sendMappedError`.
   */
  private async applyAgentConfig(
    agent: IAgentScopeHandle,
    agentConfig: NonNullable<UpdateSessionProfileRequest['agent_config']>,
  ): Promise<void> {
    const profile = agent.accessor.get(IAgentProfileService);
    if (agentConfig.model !== undefined && agentConfig.model !== '') {
      await profile.setModel(agentConfig.model);
    }
    if (agentConfig.thinking !== undefined) {
      profile.setThinking(agentConfig.thinking);
    }
    if (agentConfig.permission_mode !== undefined) {
      agent.accessor
        .get(IAgentPermissionModeService)
        .setMode(agentConfig.permission_mode as PermissionMode);
    }
    if (agentConfig.plan_mode !== undefined) {
      const plan = agent.accessor.get(IAgentPlanService);
      const active = (await plan.status()) !== null;
      if (active !== agentConfig.plan_mode) {
        if (agentConfig.plan_mode) await plan.enter();
        else plan.exit();
      }
    }
    if (agentConfig.swarm_mode !== undefined) {
      const swarm = agent.accessor.get(IAgentSwarmService);
      if (swarm.isActive !== agentConfig.swarm_mode) {
        if (agentConfig.swarm_mode) swarm.enter('manual');
        else swarm.exit();
      }
    }
    if (agentConfig.goal_objective !== undefined) {
      await agent.accessor
        .get(IAgentGoalService)
        .createGoal({ objective: agentConfig.goal_objective });
    }
    if (agentConfig.goal_control !== undefined) {
      const goal = agent.accessor.get(IAgentGoalService);
      switch (agentConfig.goal_control) {
        case 'pause':
          await goal.pauseGoal({});
          break;
        case 'resume':
          await goal.resumeGoal({});
          break;
        case 'cancel':
          await goal.cancelGoal({});
          break;
      }
    }
  }

  private async resolveMainAgent(sessionId: string): Promise<IAgentScopeHandle> {
    // `resume` (not `get`) so a persisted-but-cold session — freshly opened in
    // the web UI before any prompt, or created by a previous process — is loaded
    // from disk instead of being reported as `session.not_found`. Mirrors v1's
    // `SessionService.undo`/`compact`, which call `resumeSession` first; `resume`
    // returns `undefined` only when the session is unknown or its workspace is
    // gone, so a genuinely missing session still 404s.
    const session = await this.lifecycle.resume(sessionId);
    if (session === undefined) {
      throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
    }
    return ensureMainAgent(session);
  }

  async status(sessionId: string): Promise<SessionStatusResponse> {
    const agent = await this.resolveMainAgent(sessionId);
    return this.assembleStatus(sessionId, agent);
  }

  private async assembleStatus(
    sessionId: string,
    agent: IAgentScopeHandle,
  ): Promise<SessionStatusResponse> {
    const session = this.lifecycle.get(sessionId);
    const profile = agent.accessor.get(IAgentProfileService);
    const contextSize = agent.accessor.get(IAgentContextSizeService);
    const permission = agent.accessor.get(IAgentPermissionModeService);
    const plan = agent.accessor.get(IAgentPlanService);
    const swarm = agent.accessor.get(IAgentSwarmService);

    const profileData = profile.data();
    const model = profile.getModel();
    const caps = profile.getModelCapabilities() as { max_context_tokens?: number };
    // v1 binds the default model to the main agent at session creation, so its
    // status always reports a real context window. v2 creates the main agent
    // lazily without binding a model until the first prompt/profile update, so a
    // fresh session has no model and `max_context_tokens` resolves to 0 — the
    // status line then shows "0/0". Mirror v1 by falling back to the configured
    // default model's context window whenever the agent has no model bound yet.
    const maxTokens =
      model === '' ? resolveDefaultModelContextTokens(agent) : (caps.max_context_tokens ?? 0);
    // `size` (measured + estimated) mirrors v1's `context.tokenCount`: it
    // reflects the live context even before the first measured exchange, whereas
    // `measured` stays 0 until the first LLM response lands.
    const tokens = contextSize.get().size;
    const planData = await plan.status();

    return {
      status: session?.accessor.get(ISessionActivity).status() ?? 'idle',
      model: model === '' ? undefined : model,
      thinking_level: profileData.thinkingLevel,
      permission: permission.mode,
      plan_mode: planData !== null,
      swarm_mode: swarm.isActive,
      context_tokens: tokens,
      max_context_tokens: maxTokens,
      context_usage: maxTokens > 0 ? tokens / maxTokens : 0,
    };
  }

  async goal(sessionId: string): Promise<GoalSnapshot | null> {
    const agent = await this.resolveMainAgent(sessionId);
    return agent.accessor.get(IAgentGoalService).getGoal().goal;
  }
}

/**
 * Resolve the configured default model's context window for the status line
 * when the main agent has no model bound yet (fresh session before the first
 * prompt). Returns 0 when no default model is configured or it cannot be
 * resolved (e.g. auth not ready), matching v1's "unknown" fallback.
 */
function resolveDefaultModelContextTokens(agent: IAgentScopeHandle): number {
  const defaultModel = agent.accessor.get(IConfigService).get<string>('defaultModel');
  if (typeof defaultModel !== 'string' || defaultModel.length === 0) return 0;
  try {
    return agent.accessor.get(IModelResolver).resolve(defaultModel).capabilities.max_context_tokens;
  } catch {
    return 0;
  }
}

registerScopedService(
  LifecycleScope.App,
  ISessionLegacyService,
  SessionLegacyService,
  InstantiationType.Delayed,
  'sessionLegacy',
);
