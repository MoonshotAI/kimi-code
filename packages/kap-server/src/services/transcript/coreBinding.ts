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
  IAgentActivityView,
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
  /** Per-agent subscriptions (bus listeners capturing the agent's projector) — disposed with the agent. */
  const agentDisposables = new Map<string, IDisposable[]>();
  /** Agents with a live bus subscription (a projector may exist before its handle does — see seedPendingInteractions). */
  const subscribedAgents = new Set<string>();
  const projectors = new Map<string, AgentTranscriptProjector>();
  /** interaction id → owning projector agent id (for resolve routing). */
  const interactionAgents = new Map<string, string>();
  /** interaction ids already announced (seeded + seen), mirrors the broadcaster. */
  const knownInteractions = new Set<string>();
  /**
   * Pendings registered at bind time but not yet announced (deferred to the
   * post-backfill seed): id → the interaction to announce.
   */
  const unseeded = new Map<string, Interaction>();
  /** Resolves captured before the seed ran: id → routed resolve to replay. */
  const earlyResolves = new Map<string, { agentId: string; response: unknown }>();
  /** Agents whose pendings may announce live (their backfill+seed has run). */
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
        // The engine's folded activity view knows the current step even when
        // the projector attached after `turn.step.started` for a later step.
        // The handle resolves lazily (the projector may predate the handle).
        stepOrdinal: (turnId) => {
          const agentHandle = agents.get(agentId);
          if (agentHandle === undefined) return undefined;
          const view: IAgentActivityView | undefined = agentHandle.accessor.get(IAgentActivityView);
          const turn = view?.state().turn;
          return turn === undefined || `t${turn.turnId}` !== turnId ? undefined : turn.step;
        },
      });
      projectors.set(agentId, projector);
    }
    return projector;
  };

  const subscribeAgent = (handle: IAgentScopeHandle): void => {
    // Guard on the subscription, not the projector: seeding can create the
    // projector before the agent's handle exists, and it still needs its bus
    // subscription once the handle appears.
    if (subscribedAgents.has(handle.id)) return;
    subscribedAgents.add(handle.id);
    const projector = projectorFor(handle.id);
    store.ensureAgent(handle.id, { agentId: handle.id });
    // Every domain emits live events via the per-agent `IEventBus`; the bus is
    // Agent-scoped, so this sees only this agent's events. The subscription is
    // tracked per agent and disposed with it — the listener captures the
    // projector, so a dead agent must not keep projecting into the store.
    const bus = handle.accessor.get(IEventBus);
    const busD = bus.subscribe((event) => applyOps(handle.id, projector.map(event)));
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
      // An agent created AFTER binding is fully covered by its live
      // projector (every event happens from now on) — its pendings may
      // announce immediately, no backfill to wait for. (Pre-existing agents
      // seed after their own backfill via ensureAgentHistory.)
      seededAgents.add(handle.id);
      refreshDescriptors();
    }),
    agents.onDidDispose((agentId) => {
      // Release the agent's subscriptions first — late events from a dying
      // scope must not project into the store. Only the projector dies with
      // the scope; the materialized transcript and roster entry stay (the
      // roster mirrors session metadata, which keeps completed agents), and
      // dropping the transcript would lose already-served history for good —
      // the service's backfill cache dedupes per agent, so a later read
      // would rebuild an empty shell instead of replaying persisted records.
      for (const d of agentDisposables.get(agentId) ?? []) d.dispose();
      agentDisposables.delete(agentId);
      subscribedAgents.delete(agentId);
      projectors.delete(agentId);
      store.markDisposed(agentId, new Date().toISOString());
    }),
  );

  // Interactions already pending at bind time are REGISTERED without
  // announcing (ownership must exist immediately so a resolve arriving before
  // the deferred seed still routes); their entity ops land in
  // seedPendingInteractions, which the service calls after the initial
  // backfill so the resolve-time approvalId back-link finds the persisted
  // tool frames. New pendings announce live through onDidChangePending below.
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
      // The interaction opened and closed before the transcript attached:
      // emit request + resolve back to back so the entity lands resolved,
      // with the approvalId back-link on the (now backfilled) tool frame.
      interactionAgents.delete(id);
      earlyResolves.delete(id);
      const projector = projectors.get(early.agentId);
      if (projector !== undefined) {
        applyOps(early.agentId, projector.mapInteractionResolved(id, early.response));
      }
    }
    // Pendings that arrived live since bind are announced already; sweep for
    // any that slipped past (e.g. a pending change during the backfill).
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
        // A pending created before its owning agent was seeded (the backfill
        // may not have replayed the referenced tool frame yet) defers like a
        // bind-time one — announcing it now would misplace it into a
        // synthetic step, with no later repair.
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
      // A resolve that beats the post-backfill seed: capture and replay onto
      // the freshly announced frame at seed time.
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
