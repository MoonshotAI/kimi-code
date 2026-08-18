import {
  IAgentLifecycleService,
  IAgentActivityView,
  IAgentTaskService,
  IEventBus,
  ISessionMetadata,
  ISessionInteractionService,
  MAIN_AGENT_ID,
  type AgentMeta,
  type IDisposable,
  type IAgentScopeHandle,
  type Interaction,
  type ISessionScopeHandle,
} from '@moonshot-ai/agent-core-v2';
import type { AgentDescriptor, TranscriptChangeEvent, TranscriptStore } from '@moonshot-ai/transcript';

import {
  AgentTranscriptProjector,
  type ProjectorBusEvent,
  type ProjectorInteraction,
} from './coreEventMap';

/** Minimal warn sink (matches `JournalLogger`). */
export interface TranscriptBindingLogger {
  warn(obj: unknown, msg: string): void;
}

/** The live binding plus its deferred seeding hook. */
export interface TranscriptBinding extends IDisposable {
  /**
   * Announce interactions that were already pending at bind time.
   * Deliberately NOT run during bind: the store (and the projector's tool
   * map) is empty until the initial history backfill lands, so an early
   * announce misplaces the frame into a synthetic step and loses the
   * resolve-time `approvalId` back-link. The service calls it after the
   * initial backfill for the main agent, and after each agent's on-demand
   * backfill for that agent's interactions — pass `agentId` to seed only the
   * pendings routed to that agent (a subagent's pending must not be placed
   * before its own history is replayed).
   */
  seedPendingInteractions(agentId?: string): void;
}

export function bindSessionTranscript(
  store: TranscriptStore,
  session: ISessionScopeHandle,
  logger?: TranscriptBindingLogger,
  onOps?: (event: TranscriptChangeEvent) => void,
): TranscriptBinding {
  const agents = session.accessor.get(IAgentLifecycleService);
  const interactions = session.accessor.get(ISessionInteractionService);
  const disposables: IDisposable[] = [];
  const agentDisposables = new Map<string, IDisposable[]>();
  const subscribedAgents = new Set<string>();
  const projectors = new Map<string, AgentTranscriptProjector>();
  const interactionAgents = new Map<string, string>();
  const knownInteractions = new Set<string>();
  const unseeded = new Map<string, Interaction>();
  const earlyResolves = new Map<string, { agentId: string; response: unknown }>();
  const seededAgents = new Set<string>();
  let seededAll = false;
  const isSeeded = (agentId: string): boolean => seededAll || seededAgents.has(agentId);

  const applyOps = (agentId: string, ops: ReturnType<AgentTranscriptProjector['map']>): void => {
    if (ops.length === 0) return;
    const result = store.ensureAgent(agentId).apply(ops);
    if (result.gap !== undefined) {
      logger?.warn(
        { sessionId: store.sessionId, agentId, gap: result.gap },
        'transcript: append gap — producer/consumer skew',
      );
      return;
    }
    onOps?.({ agentId, ops });
  };

  const projectorFor = (agentId: string): AgentTranscriptProjector => {
    let projector = projectors.get(agentId);
    if (projector === undefined) {
      projector = new AgentTranscriptProjector(agentId, {
        stepFrames: (turnId, stepId) =>
          store.getAgent(agentId)?.getTurn(turnId)?.steps.find((s) => s.stepId === stepId)?.frames,
        toolFrame: (toolCallId) => {
          const transcript = store.getAgent(agentId);
          if (transcript === undefined) return undefined;
          for (const item of transcript.getItems()) {
            if (item.kind !== 'turn') continue;
            for (const step of item.steps) {
              for (const frame of step.frames) {
                if (frame.kind === 'tool' && frame.toolCallId === toolCallId) {
                  return { turnId: item.turnId, stepId: step.stepId, frame };
                }
              }
            }
          }
          return undefined;
        },
        stepOrdinal: (turnId) => {
          const agentHandle = agents.get(agentId);
          if (agentHandle === undefined) return undefined;
          const view: IAgentActivityView | undefined = agentHandle.accessor.get(IAgentActivityView);
          const turn = view?.state().turn;
          return turn === undefined || `t${turn.turnId}` !== turnId ? undefined : turn.step;
        },
        turn: (turnId) => store.getAgent(agentId)?.getTurn(turnId),
      });
      for (const agent of agents.list()) {
        if (agent.id !== agentId) continue;
        const tasks = agent.accessor.get(IAgentTaskService)?.list() ?? [];
        for (const info of tasks) {
          if (info.kind === 'agent' && typeof info.agentId === 'string' && info.agentId.length > 0) {
            applyOps(
              agentId,
              projector.seedSubagentTask({
                taskId: info.taskId,
                agentId: info.agentId,
                description: info.description,
                status: info.status,
                detached: info.detached ?? false,
                startedAt: info.startedAt,
              }),
            );
          }
        }
      }
      projectors.set(agentId, projector);
    }
    return projector;
  };

  const subscribeAgent = (handle: IAgentScopeHandle): void => {
    if (subscribedAgents.has(handle.id)) return;
    subscribedAgents.add(handle.id);
    const projector = projectorFor(handle.id);
    store.ensureAgent(handle.id, { agentId: handle.id });
    const bus = handle.accessor.get(IEventBus);
    const busD = bus.subscribe((event) =>
      applyOps(handle.id, projector.map(event as ProjectorBusEvent)),
    );
    const list = agentDisposables.get(handle.id) ?? [];
    list.push(busD);
    agentDisposables.set(handle.id, list);
  };

  const interactionAgentId = (interaction: Interaction): string => {
    const payloadAgent = (interaction.payload as { agentId?: unknown }).agentId;
    return (
      interaction.origin.agentId ??
      (typeof payloadAgent === 'string' ? payloadAgent : undefined) ??
      MAIN_AGENT_ID
    );
  };

  const announceInteraction = (interaction: Interaction): void => {
    if (interaction.kind !== 'approval' && interaction.kind !== 'question') return;
    const agentId = interactionAgentId(interaction);
    interactionAgents.set(interaction.id, agentId);
    const request: ProjectorInteraction = {
      id: interaction.id,
      kind: interaction.kind,
      payload: interaction.payload,
      origin: interaction.origin,
    };
    applyOps(agentId, projectorFor(agentId).mapInteractionRequested(request));
  };

  const refreshDescriptors = (): void => {
    void session.accessor
      .get(ISessionMetadata)
      .read()
      .then((meta) => {
        for (const agentId of projectors.keys()) {
          store.describeAgent(descriptorFromMeta(agentId, meta.agents?.[agentId]));
        }
      })
      .catch(() => {
      });
  };

  for (const handle of agents.list()) subscribeAgent(handle);
  disposables.push(
    agents.onDidCreate((handle) => {
      subscribeAgent(handle);
      seededAgents.add(handle.id);
      refreshDescriptors();
    }),
    agents.onDidDispose((agentId) => {
      for (const d of agentDisposables.get(agentId) ?? []) d.dispose();
      agentDisposables.delete(agentId);
      subscribedAgents.delete(agentId);
      projectors.delete(agentId);
      store.markDisposed(agentId, new Date().toISOString());
    }),
  );

  for (const pending of interactions.listPending()) {
    if (pending.kind !== 'approval' && pending.kind !== 'question') continue;
    if (knownInteractions.has(pending.id)) continue;
    knownInteractions.add(pending.id);
    interactionAgents.set(pending.id, interactionAgentId(pending));
    unseeded.set(pending.id, pending);
  }
  const seedPendingInteractions = (agentId?: string): void => {
    if (agentId === undefined) seededAll = true;
    else seededAgents.add(agentId);
    for (const [id, interaction] of unseeded) {
      if (agentId !== undefined && interactionAgents.get(id) !== agentId) continue;
      unseeded.delete(id);
      announceInteraction(interaction);
      const early = earlyResolves.get(id);
      if (early === undefined) continue;
      interactionAgents.delete(id);
      earlyResolves.delete(id);
      const projector = projectors.get(early.agentId);
      if (projector !== undefined) {
        applyOps(early.agentId, projector.mapInteractionResolved(id, early.response));
      }
    }
    for (const pending of interactions.listPending()) {
      if (knownInteractions.has(pending.id)) continue;
      if (agentId !== undefined && interactionAgentId(pending) !== agentId) continue;
      knownInteractions.add(pending.id);
      announceInteraction(pending);
    }
  };
  disposables.push(
    interactions.onDidChangePending(() => {
      for (const pending of interactions.listPending()) {
        if (knownInteractions.has(pending.id)) continue;
        const agentId = interactionAgentId(pending);
        knownInteractions.add(pending.id);
        if (!isSeeded(agentId)) {
          interactionAgents.set(pending.id, agentId);
          unseeded.set(pending.id, pending);
          continue;
        }
        announceInteraction(pending);
      }
    }),
    interactions.onDidResolve(({ id, response }) => {
      knownInteractions.delete(id);
      const agentId = interactionAgents.get(id);
      if (agentId === undefined) return;
      interactionAgents.delete(id);
      if (unseeded.has(id)) {
        earlyResolves.set(id, { agentId, response });
        return;
      }
      const projector = projectors.get(agentId);
      if (projector === undefined) return;
      applyOps(agentId, projector.mapInteractionResolved(id, response));
    }),
  );

  refreshDescriptors();

  return {
    seedPendingInteractions,
    dispose: () => {
      for (const d of disposables) d.dispose();
      for (const list of agentDisposables.values()) {
        for (const d of list) d.dispose();
      }
      agentDisposables.clear();
      projectors.clear();
      interactionAgents.clear();
      knownInteractions.clear();
      unseeded.clear();
      earlyResolves.clear();
    },
  };
}

export function descriptorFromMeta(agentId: string, meta: AgentMeta | undefined): AgentDescriptor {
  const parentFromLabels = meta?.labels?.['parentAgentId'];
  const swarmItem = meta?.labels?.['swarmItem'] ?? meta?.swarmItem;
  return {
    agentId,
    type: meta?.type ?? (agentId === MAIN_AGENT_ID ? 'main' : 'sub'),
    parentAgentId:
      parentFromLabels !== undefined && parentFromLabels.length > 0
        ? parentFromLabels
        : (meta?.parentAgentId ?? undefined),
    label: swarmItem !== undefined && swarmItem.length > 0 ? swarmItem : undefined,
  };
}
