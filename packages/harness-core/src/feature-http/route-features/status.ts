import { useApp } from '@moonshot-ai/agent-core/app/index';
import { useCollection, useInject } from '@moonshot-ai/agent-core/kernel/index';
import type { UnitNode } from '@moonshot-ai/agent-core/kernel/runtime';
import { MAIN_AGENT_ID, type Session } from '@moonshot-ai/agent-core/session/index';

import { CompactionRef } from '#/features/compaction/index';
import { ConfigRef, DEFAULT_MODEL_CONFIG_SECTION, type ConfigStore } from '#/features/config/index';
import { InteractionRef, INTERACTION_TAG_SESSION_ID } from '#/features/interaction/index';
import { PermissionRef } from '#/features/permission/index';
import { PlanRef } from '#/features/plan/index';
import {
  AgentModelRef,
  CatalogModels,
  matchCatalogBinding,
  type CatalogModelBinding,
} from '#/features/provider-catalog/index';
import { TaskRef } from '#/features/task/index';
import { TokenCountingRef } from '#/features/tokenCounting/index';
import { TowerRef } from '#/features/tower/index';

import { agentFacade, findAgentUnit, sessionFacade, unitsReady, useHttpRoute, useRootUnit } from '../scope';
import { ErrorCode, param, sendErr, sendOk } from '../route/http';
import { resumeSession } from '../route/resume-session';

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
  const app = useApp();
  const root = useRootUnit();
  const bindings = useCollection(CatalogModels);
  const config = useInject(ConfigRef);
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
      const session = await resumeSession(app, sessionId);
      if (session === undefined) {
        sendErr(request, response, ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
        return;
      }
      const status = await sessionStatusView(root, bindings.value, session, config.value);
      if (status === undefined) {
        sendErr(request, response, ErrorCode.AGENT_NOT_FOUND, `agent ${MAIN_AGENT_ID} does not exist`);
        return;
      }
      sendOk(request, response, status);
    },
  });
}

export function effectiveModelAlias(
  root: UnitNode,
  config: ConfigStore | undefined,
  sessionId: string,
  agentId: string,
): string | undefined {
  const bound = agentFacade(root, AgentModelRef, sessionId, agentId)?.current.value.alias;
  if (bound !== undefined && bound !== null && bound !== '') return bound;
  if (findAgentUnit(root, sessionId, agentId) === undefined) return undefined;
  const configured = config?.get<string>(DEFAULT_MODEL_CONFIG_SECTION);
  return typeof configured === 'string' && configured.length > 0 ? configured : undefined;
}

export async function sessionStatusView(
  root: UnitNode,
  bindings: readonly CatalogModelBinding[],
  session: Session,
  config?: ConfigStore,
): Promise<SessionStatusView | undefined> {
  await unitsReady(root);
  const main = session.agents.get(MAIN_AGENT_ID);
  if (main === undefined) return undefined;
  const alias = effectiveModelAlias(root, config, session.id, MAIN_AGENT_ID);
  const catalog = alias === undefined ? undefined : matchCatalogBinding(alias, bindings);
  const model = catalog?.model.name ?? alias;
  const binding = agentFacade(root, AgentModelRef, session.id, MAIN_AGENT_ID)?.current.value;
  const maxTokens = catalog?.model.maxInputSize ?? catalog?.model.maxContextSize ?? 0;
  const tokens = agentFacade(root, TokenCountingRef, session.id, MAIN_AGENT_ID)?.statusSize() ?? 0;
  const plan = agentFacade(root, PlanRef, session.id, MAIN_AGENT_ID);
  return {
    busy: sessionBusy(root, session),
    model,
    thinking_level: model === undefined ? '' : (binding?.thinking ?? 'off'),
    permission: agentFacade(root, PermissionRef, session.id, MAIN_AGENT_ID)?.mode() ?? 'manual',
    plan_mode: plan !== undefined ? (await plan.status()) !== null : false,
    tower_mode: agentFacade(root, TowerRef, session.id, MAIN_AGENT_ID)?.isActive() ?? false,
    context_tokens: tokens,
    max_context_tokens: maxTokens > 0 ? maxTokens : undefined,
    context_usage: maxTokens > 0 ? Math.min(1, tokens / maxTokens) : undefined,
    pending_interaction: sessionPendingInteraction(root, session),
  };
}

export function sessionBusy(root: UnitNode, session: Session): boolean {
  return session.status().busy || sessionFeatureBusy(root, session);
}

function sessionFeatureBusy(root: UnitNode, session: Session): boolean {
  for (const agentId of session.agents.keys()) {
    const tasks = agentFacade(root, TaskRef, session.id, agentId);
    if (
      tasks !== undefined &&
      [...tasks.records.value.values()].some((record) => record.status === 'running')
    ) {
      return true;
    }
    const compaction = agentFacade(root, CompactionRef, session.id, agentId);
    if (compaction !== undefined && compaction.status().phase !== 'idle') return true;
  }
  return false;
}

export function sessionPendingInteraction(root: UnitNode, session: Session): SessionPendingInteraction {
  const interactions = sessionFacade(root, InteractionRef, session.id);
  if (interactions === undefined) return 'none';
  const pending = interactions.findAll({
    resolved: false,
    tags: { [INTERACTION_TAG_SESSION_ID]: session.id },
  });
  if (pending.some((interaction) => interaction.kind === 'approval')) return 'approval';
  if (pending.some((interaction) => interaction.kind === 'question')) return 'question';
  return 'none';
}
