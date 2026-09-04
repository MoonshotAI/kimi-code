import { join } from 'node:path';

import {
  IAgentActivityView,
  IAgentGoalService,
  IAgentLifecycleService,
  IAgentLoopService,
  IAgentPermissionModeService,
  IAgentProfileService,
  IAgentPromptService,
  IAgentScopeContext,
  IAgentStateService,
  IAgentTaskService,
  IAgentTodoService,
  IEventBus,
  ISessionActivityView,
  ISessionIndex,
  IWireService,
  MAIN_AGENT_ID,
  listSessionPendingInteractions,
  onSessionInteractionDidChangePending,
  onSessionInteractionDidResolve,
  type AgentTaskInfo,
  type IAgentScopeHandle,
  type IDisposable,
  type Interaction,
  type ISessionScopeHandle,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { planKey } from '@moonshot-ai/agent-core-v2/features/plan/planOps';
import { swarmKey } from '@moonshot-ai/agent-core-v2/features/swarm/swarmOps';

import { serverMessageSchema, type ServerMessage } from '../../protocol/messages';
import { readLegacyStatus } from '../legacyStatus/legacyStatus';
import { AgentMessageProjector, toTurnOrigin, type ProjectorInteraction } from './agentProjector';
import type { ProjectionBusEvent } from './events';
import { foldTimelineSeed, foldWireTurn, readWireRecords, type ContextRecord } from './heal';
import { isUndoAnchorOrigin } from './ids';
import { SessionStateAggregator } from './sessionState';

const TURN_HEAL_DEBOUNCE_MS = 250;
const TASK_OUTPUT_TAIL_CHARS = 4096;

export interface ProjectionLogger {
  warn(obj: unknown, msg: string): void;
}

export interface SessionProjectionDeps {
  readonly homeDir: string;
  readonly core: Scope;
  readonly logger?: ProjectionLogger;
}

export class SessionProjection {
  private readonly projectors = new Map<string, AgentMessageProjector>();
  private readonly agentDisposables = new Map<string, IDisposable[]>();
  private readonly disposables: IDisposable[] = [];
  private readonly listeners = new Set<(message: ServerMessage) => void>();
  private readonly aggregator = new SessionStateAggregator();
  private readonly subagentTaskIds = new Map<string, string>();
  private readonly interactionAgents = new Map<string, string>();
  private readonly knownInteractions = new Set<string>();
  private readonly unknownEventTypes = new Set<string>();
  private readonly validationFailures = new Map<string, number>();
  private readonly healTimers = new Map<string, { ordinals: Set<number>; timer: NodeJS.Timeout }>();
  private disposed = false;

  constructor(
    readonly sessionId: string,
    private readonly session: ISessionScopeHandle,
    private readonly deps: SessionProjectionDeps,
  ) {
    const agents = session.accessor.get(IAgentLifecycleService);
    for (const context of agents.list()) {
      const handle = agents.handleOf(context.agentId);
      if (handle !== undefined) this.subscribeAgent(handle);
    }
    this.disposables.push(
      agents.onDidCreate(
        this.guard((context) => {
          const handle = agents.handleOf(context.agentId);
          if (handle !== undefined) this.subscribeAgent(handle);
        }),
      ),
      agents.onDidClose(
        this.guard((context) => {
          this.dropAgent(context.agentId);
        }),
      ),
      onSessionInteractionDidChangePending(
        agents,
        this.guard(() => {
          this.onInteractionsChanged(agents);
        }),
      ),
      onSessionInteractionDidResolve(
        agents,
        this.guard(({ id, response }) => {
          this.onInteractionResolve(id, response);
        }),
      ),
    );
    for (const pending of listSessionPendingInteractions(agents)) {
      this.announce(pending, false);
    }
    const activity = session.accessor.get(ISessionActivityView) as
      | ISessionActivityView
      | undefined;
    if (activity !== undefined) {
      this.aggregator.feedSessionActivity(activity.state());
      this.disposables.push(
        activity.onDidChange(
          this.guard((event) => {
            this.aggregator.feedSessionActivity(event.state);
            this.emitState();
          }),
        ),
      );
    }
  }

  onMessage(listener: (message: ServerMessage) => void): IDisposable {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  recoveryMessages(): ServerMessage[] {
    const messages: ServerMessage[] = [this.aggregator.snapshot(this.sessionId)];
    for (const projector of this.projectors.values()) {
      messages.push(...projector.recoveryMessages());
    }
    return messages.filter((message) => this.validate(message) !== undefined);
  }

  notifyContextCleared(agentId: string): void {
    const projector = this.projectors.get(agentId);
    if (projector === undefined) return;
    this.emitAll(projector.notifyContextCleared());
  }

  inFlight(agentId: string): { turn_id: string; step_id: string } | undefined {
    return this.projectors.get(agentId)?.inFlight();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of this.healTimers.values()) clearTimeout(pending.timer);
    this.healTimers.clear();
    for (const list of this.agentDisposables.values()) {
      for (const d of list) d.dispose();
    }
    this.agentDisposables.clear();
    for (const d of this.disposables) d.dispose();
    for (const projector of this.projectors.values()) projector.dispose();
    this.projectors.clear();
    this.listeners.clear();
    this.interactionAgents.clear();
    this.knownInteractions.clear();
  }

  private subscribeAgent(handle: IAgentScopeHandle): void {
    const agentId = handle.id;
    if (this.projectors.has(agentId)) return;
    const projector = new AgentMessageProjector(
      agentId,
      this.sessionId,
      this.subagentTaskIds,
      {
        stepOrdinal: (turnId) => {
          const view = handle.accessor.get(IAgentActivityView) as IAgentActivityView | undefined;
          const turn = view?.state().turn;
          return turn === undefined || `t${turn.turnId}` !== turnId ? undefined : turn.step;
        },
        resolvePlanRevisionKey: (key) =>
          handle.accessor.get(IAgentScopeContext).scope(key),
      },
      {
        onUnknownEvent: (type) => {
          if (this.unknownEventTypes.has(type)) return;
          this.unknownEventTypes.add(type);
          this.deps.logger?.warn(
            { sessionId: this.sessionId, agentId, type },
            'projection: unhandled engine event type, dropped',
          );
        },
        onDeferred: (messages) => {
          if (!this.disposed) this.emitAll(messages);
        },
      },
    );
    this.projectors.set(agentId, projector);
    const agentState = handle.accessor.get(IAgentStateService) as IAgentStateService | undefined;
    const planMode =
      agentState?.has(planKey) === true ? agentState.get(planKey).active : undefined;
    const swarmMode =
      agentState?.has(swarmKey) === true ? agentState.get(swarmKey) !== null : undefined;
    projector.seedModes({ planMode, swarmMode });
    const disposables: IDisposable[] = [];
    const bus = handle.accessor.get(IEventBus) as IEventBus | undefined;
    if (bus !== undefined) {
      disposables.push(
        bus.subscribe(
          this.guard((event) => {
            this.onBusEvent(agentId, event as ProjectionBusEvent);
          }),
        ),
      );
    }
    const todo = handle.accessor.get(IAgentTodoService) as IAgentTodoService | undefined;
    if (todo !== undefined) {
      projector.seedTodo(todo.get());
      disposables.push(
        todo.onDidChange(
          this.guard((items) => {
            this.emitAll(projector.todoChanged(items));
          }),
        ),
      );
    }
    const tasks = handle.accessor.get(IAgentTaskService) as IAgentTaskService | undefined;
    for (const info of tasks?.list() ?? []) projector.seedTask(info);
    const loop = handle.accessor.get(IAgentLoopService) as IAgentLoopService | undefined;
    const status = loop?.status();
    if (status?.state === 'running' && status.activeTurnId !== undefined) {
      const prompts = handle.accessor.get(IAgentPromptService) as IAgentPromptService | undefined;
      const activity = handle.accessor.get(IAgentActivityView) as IAgentActivityView | undefined;
      const rawOrigin = activity?.state().turn?.origin;
      projector.seedActiveTurn({
        turnId: status.activeTurnId,
        promptId: prompts?.list().active?.id,
        origin:
          activity === undefined
            ? undefined
            : toTurnOrigin(rawOrigin, agentId, this.subagentTaskIds),
        anchor: isUndoAnchorOrigin(rawOrigin),
      });
    }
    if (agentId === MAIN_AGENT_ID) {
      this.seedMainAgent(handle, disposables, { planMode, swarmMode });
    }
    this.agentDisposables.set(agentId, disposables);
    void this.seedTimelineFromWire(agentId, projector);
  }

  private seedMainAgent(
    handle: IAgentScopeHandle,
    disposables: IDisposable[],
    modes: { planMode?: boolean; swarmMode?: boolean },
  ): void {
    this.aggregator.feedMainStatus({ planMode: modes.planMode, swarmMode: modes.swarmMode });
    const legacy = readLegacyStatus(handle);
    if (legacy !== undefined) {
      this.aggregator.feedSeed({
        model: legacy.model.length > 0 ? legacy.model : undefined,
        usage: legacy.usage,
        contextTokens: legacy.contextTokens,
        maxContextTokens: legacy.maxContextTokens,
      });
    }
    const profile = handle.accessor.get(IAgentProfileService) as IAgentProfileService | undefined;
    if (profile !== undefined) {
      this.aggregator.feedSeed({ thinkingEffort: profile.getEffectiveThinkingLevel() });
    }
    const permission = handle.accessor.get(IAgentPermissionModeService) as
      | IAgentPermissionModeService
      | undefined;
    if (permission !== undefined) {
      this.aggregator.feedSeed({ permission: permission.mode });
      disposables.push(
        permission.onDidChangeMode(
          this.guard(({ mode }) => {
            this.aggregator.feedSeed({ permission: mode });
            this.emitState();
          }),
        ),
      );
    }
    const goal = handle.accessor.get(IAgentGoalService) as IAgentGoalService | undefined;
    if (goal !== undefined) {
      this.aggregator.feedGoal(goal.getGoal().goal);
    }
    const activity = handle.accessor.get(IAgentActivityView) as IAgentActivityView | undefined;
    if (activity !== undefined) {
      this.aggregator.feedMainActivity(activity.state());
    }
  }

  private dropAgent(agentId: string): void {
    for (const d of this.agentDisposables.get(agentId) ?? []) d.dispose();
    this.agentDisposables.delete(agentId);
    this.projectors.get(agentId)?.dispose();
    this.projectors.delete(agentId);
    const timer = this.healTimers.get(agentId);
    if (timer !== undefined) {
      clearTimeout(timer.timer);
      this.healTimers.delete(agentId);
    }
  }

  private onBusEvent(agentId: string, event: ProjectionBusEvent): void {
    if (this.disposed) return;
    const projector = this.projectors.get(agentId);
    if (projector === undefined) return;
    this.emitAll(projector.map(event));
    if (event.type === 'task.terminated') {
      const info = (event as { info?: AgentTaskInfo }).info;
      if (info !== undefined) void this.patchTaskOutputTail(agentId, info.taskId);
    }
    for (const ordinal of projector.takeEndedTurnOrdinals()) {
      this.scheduleHeal(agentId, ordinal);
    }
    if (agentId === MAIN_AGENT_ID) {
      if (event.type === 'agent.status.updated') {
        this.aggregator.feedMainStatus(event);
      } else if (event.type === 'agent.activity.updated') {
        this.aggregator.feedMainActivity(event);
      } else if (event.type === 'goal.updated') {
        this.aggregator.feedGoal(event.snapshot);
      } else if (event.type === 'plan.revision') {
        const handle = this.agentHandle(MAIN_AGENT_ID);
        const path = handle?.accessor.get(IAgentScopeContext).scope(event.key) ?? event.key;
        this.aggregator.feedPlanRevision(path, event.version);
      }
    }
    this.emitState();
  }

  private agentHandle(agentId: string): IAgentScopeHandle | undefined {
    return this.session.accessor.get(IAgentLifecycleService).handleOf(agentId);
  }

  private guard<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
    return (...args: A) => {
      try {
        fn(...args);
      } catch (error) {
        this.deps.logger?.warn(
          {
            sessionId: this.sessionId,
            err: error instanceof Error ? error.message : String(error),
          },
          'projection: event callback failed, continuing',
        );
      }
    };
  }

  private onInteractionsChanged(agents: IAgentLifecycleService): void {
    for (const pending of listSessionPendingInteractions(agents)) {
      if (this.knownInteractions.has(pending.id)) continue;
      this.announce(pending, true);
    }
  }

  private announce(interaction: Interaction, emit: boolean): void {
    if (interaction.kind !== 'approval' && interaction.kind !== 'question') return;
    this.knownInteractions.add(interaction.id);
    const agentId = interactionAgentId(interaction);
    this.interactionAgents.set(interaction.id, agentId);
    const projector = this.projectorFor(agentId);
    if (projector === undefined) return;
    const request: ProjectorInteraction = {
      id: interaction.id,
      kind: interaction.kind,
      payload: interaction.payload,
      origin: interaction.origin,
      createdAt: interaction.createdAt,
    };
    const ops = projector.interactionRequested(request);
    if (emit) this.emitAll(ops);
  }

  private onInteractionResolve(id: string, response: unknown): void {
    this.knownInteractions.delete(id);
    const agentId = this.interactionAgents.get(id);
    if (agentId === undefined) return;
    this.interactionAgents.delete(id);
    const projector = this.projectors.get(agentId);
    if (projector === undefined) return;
    this.emitAll(projector.interactionResolved(id, response));
    this.emitState();
  }

  private projectorFor(agentId: string): AgentMessageProjector | undefined {
    const existing = this.projectors.get(agentId);
    if (existing !== undefined) return existing;
    const handle = this.agentHandle(agentId);
    if (handle === undefined) return undefined;
    this.subscribeAgent(handle);
    return this.projectors.get(agentId);
  }

  private scheduleHeal(agentId: string, ordinal: number): void {
    const existing = this.healTimers.get(agentId);
    if (existing !== undefined) {
      existing.ordinals.add(ordinal);
      existing.timer.refresh();
      return;
    }
    const ordinals = new Set([ordinal]);
    const timer = setTimeout(() => {
      this.healTimers.delete(agentId);
      void this.healTurns(agentId, ordinals);
    }, TURN_HEAL_DEBOUNCE_MS);
    timer.unref();
    this.healTimers.set(agentId, { ordinals, timer });
  }

  private async seedTimelineFromWire(
    agentId: string,
    projector: AgentMessageProjector,
  ): Promise<void> {
    const records = await this.readAgentWire(agentId);
    if (records === undefined) return;
    if (this.disposed || this.projectors.get(agentId) !== projector) return;
    projector.applyTimelineSeed(foldTimelineSeed(records));
  }

  private async healTurns(agentId: string, ordinals: ReadonlySet<number>): Promise<void> {
    const projector = this.projectors.get(agentId);
    if (projector === undefined || this.disposed) return;
    const records = await this.readAgentWire(agentId);
    if (records === undefined) return;
    if (this.disposed || this.projectors.get(agentId) !== projector) return;
    for (const ordinal of ordinals) {
      this.emitAll(projector.healTurn(ordinal, foldWireTurn(records, ordinal)));
    }
  }

  private async patchTaskOutputTail(agentId: string, taskId: string): Promise<void> {
    const tasks = this.agentHandle(agentId)?.accessor.get(IAgentTaskService);
    if (tasks === undefined) return;
    let tail: string;
    try {
      tail = await tasks.readOutput(taskId, TASK_OUTPUT_TAIL_CHARS);
    } catch {
      return;
    }
    if (this.disposed || tail.length === 0) return;
    this.emitAll(this.projectors.get(agentId)?.taskOutputUpdated(taskId, tail) ?? []);
  }

  private async readAgentWire(agentId: string): Promise<ContextRecord[] | undefined> {
    const index = this.deps.core.accessor.get(ISessionIndex) as ISessionIndex | undefined;
    if (index === undefined) return undefined;
    const summary = await index.get(this.sessionId);
    if (summary === undefined) return undefined;
    const wire = this.agentHandle(agentId)?.accessor.get(IWireService);
    if (wire !== undefined) {
      try {
        await wire.flush();
      } catch (error) {
        this.deps.logger?.warn(
          {
            sessionId: this.sessionId,
            agentId,
            err: error instanceof Error ? error.message : error,
          },
          'projection: wire flush failed, reading what is on disk',
        );
      }
    }
    try {
      return await readWireRecords(
        join(
          this.deps.homeDir,
          'sessions',
          summary.workspaceId,
          this.sessionId,
          'agents',
          agentId,
          'wire.jsonl',
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      this.deps.logger?.warn(
        {
          sessionId: this.sessionId,
          agentId,
          err: error instanceof Error ? error.message : error,
        },
        'projection: wire read failed, continuing without it',
      );
      return undefined;
    }
  }

  private emitAll(messages: ServerMessage[]): void {
    for (const message of messages) this.emit(message);
  }

  private emitState(): void {
    const state = this.aggregator.changed(this.sessionId);
    if (state !== undefined) this.emit(state);
  }

  private emit(message: ServerMessage): void {
    const parsed = this.validate(message);
    if (parsed === undefined) return;
    for (const listener of this.listeners) {
      try {
        listener(parsed);
      } catch {
      }
    }
  }

  private validate(message: ServerMessage): ServerMessage | undefined {
    const parsed = serverMessageSchema.safeParse(message);
    if (parsed.success) return parsed.data;
    const type = String((message as { type?: unknown }).type);
    const count = (this.validationFailures.get(type) ?? 0) + 1;
    this.validationFailures.set(type, count);
    if (count === 1 || count % 100 === 0) {
      this.deps.logger?.warn(
        {
          sessionId: this.sessionId,
          type,
          count,
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
        'projection: outbound message failed schema validation, dropped',
      );
    }
    return undefined;
  }
}

function interactionAgentId(interaction: Interaction): string {
  const payloadAgent = (interaction.payload as { agentId?: unknown }).agentId;
  return (
    interaction.origin.agentId ??
    (typeof payloadAgent === 'string' ? payloadAgent : undefined) ??
    MAIN_AGENT_ID
  );
}
