import { MAIN_AGENT_ID, useApp, type SessionHandle } from '@moonshot-ai/agent-core';

import { CompactionRef } from '#/features/compaction/index';
import { InteractionRef, INTERACTION_TAG_SESSION_ID } from '#/features/interaction/index';
import { PermissionRef } from '#/features/permission/index';
import { PlanRef } from '#/features/plan/index';
import { TaskRef } from '#/features/task/index';
import { TokenCountingRef } from '#/features/tokenCounting/index';
import { TowerRef } from '#/features/tower/index';

import { useHttpRoute } from '../feature';
import { ErrorCode, param, sendErr, sendOk } from '../route/http';

export type SessionPendingInteraction = 'none' | 'approval' | 'question';

export interface SessionStatusView {
  readonly busy: boolean;
  readonly model?: string;
  readonly thinking_level: string;
  readonly permission: string;
  readonly plan_mode: boolean;
  readonly tower_mode: boolean;
  readonly context_tokens: number;
  readonly max_context_tokens?: number;
  readonly context_usage?: number;
  readonly pending_interaction: SessionPendingInteraction;
}

export function useStatusRoutes(prefix: string): void {
  useHttpRoute({
    id: 'sessions.status',
    method: 'GET',
    path: `${prefix}/sessions/:session_id/status`,
    handler: async (request, response) => {
      const sessionId = param(request, 'session_id');
      if (sessionId === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'session_id is required');
        return;
      }
      const session = useApp().get(sessionId);
      if (session === undefined) {
        sendErr(request, response, ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
        return;
      }
      const status = await sessionStatusView(session);
      if (status === undefined) {
        sendErr(request, response, ErrorCode.AGENT_NOT_FOUND, `agent ${MAIN_AGENT_ID} does not exist`);
        return;
      }
      sendOk(request, response, status);
    },
  });
}

export async function sessionStatusView(session: SessionHandle): Promise<SessionStatusView | undefined> {
  const main = session.get(MAIN_AGENT_ID);
  if (main === undefined) return undefined;
  const model = main.config?.model.model ?? '';
  const maxTokens = main.config?.model.maxInputSize ?? main.config?.model.maxContextSize ?? 0;
  const tokens = main.resolve(TokenCountingRef)?.statusSize() ?? 0;
  const plan = main.resolve(PlanRef);
  return {
    busy: sessionBusy(session),
    model: model === '' ? undefined : model,
    thinking_level: model === '' ? '' : (main.config?.thinking?.effort ?? 'off'),
    permission: main.resolve(PermissionRef)?.mode() ?? 'manual',
    plan_mode: plan !== undefined ? (await plan.status()) !== null : false,
    tower_mode: main.resolve(TowerRef)?.isActive() ?? false,
    context_tokens: tokens,
    max_context_tokens: maxTokens > 0 ? maxTokens : undefined,
    context_usage: maxTokens > 0 ? Math.min(1, tokens / maxTokens) : undefined,
    pending_interaction: sessionPendingInteraction(session),
  };
}

export function sessionBusy(session: SessionHandle): boolean {
  return session.status().busy || sessionFeatureBusy(session);
}

function sessionFeatureBusy(session: SessionHandle): boolean {
  for (const agentId of session.list()) {
    const agent = session.get(agentId);
    if (agent === undefined) continue;
    const tasks = agent.resolve(TaskRef);
    if (
      tasks !== undefined &&
      [...tasks.records.value.values()].some((record) => record.status === 'running')
    ) {
      return true;
    }
    const compaction = agent.resolve(CompactionRef);
    if (compaction !== undefined && compaction.status().phase !== 'idle') return true;
  }
  return false;
}

export function sessionPendingInteraction(session: SessionHandle): SessionPendingInteraction {
  const interactions = session.resolve(InteractionRef);
  if (interactions === undefined) return 'none';
  const pending = interactions.findAll({
    resolved: false,
    tags: { [INTERACTION_TAG_SESSION_ID]: session.sessionId },
  });
  if (pending.some((interaction) => interaction.kind === 'approval')) return 'approval';
  if (pending.some((interaction) => interaction.kind === 'question')) return 'question';
  return 'none';
}
