/**
 * Session-level transcript binding — the live producer path.
 *
 * Mirrors the broadcaster's `attachAgents` pattern
 * (`transport/ws/v1/sessionEventBroadcaster.ts`): driven by the Session-scope
 * `IAgentLifecycleService` (`list()` + `onDidCreate` / `onDidDispose`), each
 * agent gets `store.ensureAgent(...)` + an {@link AgentTranscriptProjector}
 * subscribed to that agent's `IEventBus`. Approvals / questions are bridged
 * from the Session-scope `ISessionInteractionService`
 * (`onDidChangePending` / `onDidResolve`) — deliberately NOT from
 * `permission.*` agent events — and routed to the owning agent's projector via
 * `origin.agentId` (falling back to the request payload's `agentId`, then
 * 'main').
 *
 * All ops flow through `AgentTranscript.apply` (the single convergence path);
 * an `append` gap signals producer/consumer skew and is logged at warn level.
 *
 * The returned Disposable tears down every subscription created here.
 */

import {
  IAgentLifecycleService,
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

import { AgentTranscriptProjector, type ProjectorInteraction } from './coreEventMap';

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
   * resolve-time `approvalId` back-link. Call it after the backfill.
   */
  seedPendingInteractions(): void;
}

export function bindSessionTranscript(
  store: TranscriptStore,
  session: ISessionScopeHandle,
  logger?: TranscriptBindingLogger,
  /**
   * Mapped-op batches (post-`apply`, gap-checked) — the WS fanout source.
   *
   * Why not `AgentTranscript.onChange`: `apply` reports only ops that CHANGED
   * the store, and the producer store has already absorbed every `append`, so
   * the step/turn flush `frame.upsert` (full text) is a local no-op and never
   * re-emitted. That flush is exactly what 'block'-grade subscribers (who
   * receive no `append`) need for convergence, so the wire stream must carry
   * the projector's mapped ops, not the store's accepted ops. All ops remain
   * state-style/idempotent, so replaying a locally-unchanged upsert is safe.
   */
  onOps?: (event: TranscriptChangeEvent) => void,
): TranscriptBinding {
  const agents = session.accessor.get(IAgentLifecycleService);
  const interactions = session.accessor.get(ISessionInteractionService);
  const disposables: IDisposable[] = [];
  const projectors = new Map<string, AgentTranscriptProjector>();
  /** interaction id → owning projector agent id (for resolve routing). */
  const interactionAgents = new Map<string, string>();
  /** interaction ids already announced (seeded + seen), mirrors the broadcaster. */
  const knownInteractions = new Set<string>();

  const applyOps = (agentId: string, ops: ReturnType<AgentTranscriptProjector['map']>): void => {
    if (ops.length === 0) return;
    const result = store.ensureAgent(agentId).apply(ops);
    if (result.gap !== undefined) {
      logger?.warn(
        { sessionId: store.sessionId, agentId, gap: result.gap },
        'transcript: append gap — producer/consumer skew',
      );
      // A gapped batch never reaches the wire: the producer store could not
      // place it, so clients would inherit the inconsistency.
      return;
    }
    onOps?.({ agentId, ops });
  };

  const projectorFor = (agentId: string): AgentTranscriptProjector => {
    let projector = projectors.get(agentId);
    if (projector === undefined) {
      // The lookups let the projector adopt state the history backfill seeded
      // into the store before the projector existed (mid-stream/mid-bind
      // attach): stream frames continue id + offset, tool frames take their
      // results, instead of clobbering the seeded state or dropping events.
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
      });
      projectors.set(agentId, projector);
    }
    return projector;
  };

  const subscribeAgent = (handle: IAgentScopeHandle): void => {
    if (projectors.has(handle.id)) return;
    const projector = projectorFor(handle.id);
    store.ensureAgent(handle.id, { agentId: handle.id });
    // Every domain emits live events via the per-agent `IEventBus`; the bus is
    // Agent-scoped, so this sees only this agent's events.
    const bus = handle.accessor.get(IEventBus);
    const busD = bus.subscribe((event) => applyOps(handle.id, projector.map(event)));
    disposables.push(busD);
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

  // Agent descriptors (type / parentAgentId / label) ride read-only on top of
  // the persisted session meta registry (`SessionMeta.agents`); the
  // AgentMeta write lands before `onDidCreate` fires, so one refresh per
  // roster event is enough. `label` mirrors the swarm item name when present.
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
        // Metadata read is best-effort; transcripts work without descriptors.
      });
  };

  for (const handle of agents.list()) subscribeAgent(handle);
  disposables.push(
    agents.onDidCreate((handle) => {
      subscribeAgent(handle);
      refreshDescriptors();
    }),
    agents.onDidDispose((agentId) => {
      projectors.delete(agentId);
      store.removeAgent(agentId);
    }),
  );

  // Interactions pending at bind time are seeded via `seedPendingInteractions`
  // (deferred until after the initial backfill — see the handle's doc); new
  // pendings announce live through this same dedupe.
  const seedPendingInteractions = (): void => {
    for (const pending of interactions.listPending()) {
      if (knownInteractions.has(pending.id)) continue;
      knownInteractions.add(pending.id);
      announceInteraction(pending);
    }
  };
  disposables.push(
    interactions.onDidChangePending(seedPendingInteractions),
    interactions.onDidResolve(({ id, response }) => {
      knownInteractions.delete(id);
      const agentId = interactionAgents.get(id);
      if (agentId === undefined) return;
      interactionAgents.delete(id);
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
      projectors.clear();
      interactionAgents.clear();
      knownInteractions.clear();
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
