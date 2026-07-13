/**
 * ACP session (v2) — drives a single agent-core-v2 main agent over one ACP
 * `sessionId`.
 *
 * `prompt` submits a user `ContextMessage` to the main agent's
 * `IAgentPromptService`, subscribes the agent's `IEventBus` for the duration of
 * the turn, and translates each `DomainEvent` into an ACP `session/update`
 * notification via the helpers in `./events-map`. The promise settles on the
 * `turn.ended` event (or, defensively, on the turn's `result` promise).
 */

import type {
  AgentSideConnection,
  AvailableCommand,
  ContentBlock,
  PromptResponse,
  SessionConfigOption,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import {
  type ContextMessage,
  type DomainEvent,
  type IAgentScopeHandle,
  IAgentContextMemoryService,
  IAgentPermissionModeService,
  IAgentPlanService,
  IAgentProfileService,
  IAgentPromptService,
  IAgentSkillService,
  IEventBus,
  IModelService,
  ISessionSkillCatalog,
  type ISessionScopeHandle,
  type SkillCatalog,
} from '@moonshot-ai/agent-core-v2';

import { ACP_BUILTIN_SLASH_COMMANDS } from './builtin-commands';
import { buildSessionConfigOptions } from './config-options';
import { acpBlocksToContentParts } from './convert';
import {
  assistantDeltaToSessionUpdate,
  availableCommandsUpdateNotification,
  configOptionUpdateNotification,
  planFromDisplayBlock,
  stringifyArgs,
  thinkingDeltaToSessionUpdate,
  toolCallDeltaToSessionUpdate,
  toolCallLazyCreateToSessionUpdate,
  toolCallStartedUpgradeToSessionUpdate,
  toolCallStartToSessionUpdate,
  toolProgressToSessionUpdate,
  toolResultToSessionUpdate,
  turnEndReasonToStopReason,
} from './events-map';
import { AcpInteractionBridge } from './interaction-bridge';
import { log } from './log';
import { projectModelCatalog } from './model-catalog';
import { type AcpModeId, acpModeToToggles, DEFAULT_MODE_ID } from './modes';
import { projectHistoryToSessionUpdates } from './replay';
import { detectSlashIntent } from './slash';

/** Minimal handle to the in-flight turn, captured so `cancel` can abort it. */
interface ActiveTurn {
  cancel(reason?: unknown): boolean;
}

/** The turn handle returned by the prompt / skill-activation drivers. */
type AgentTurn = Awaited<ReturnType<IAgentSkillService['activate']>>;

/** Leading text of the first text block, if any (used for slash detection). */
function leadingText(blocks: readonly ContentBlock[]): string | undefined {
  const first = blocks[0];
  if (first !== undefined && first.type === 'text') return first.text;
  return undefined;
}

/**
 * Build a command-name → skill-name lookup from the session skill catalog. Both
 * `/<name>` and `/skill:<name>` resolve to the same skill so either client
 * convention works.
 */
function buildSkillCommandMap(catalog: SkillCatalog): Map<string, string> {
  const map = new Map<string, string>();
  for (const skill of catalog.listInvocableSkills()) {
    map.set(skill.name, skill.name);
    map.set(`skill:${skill.name}`, skill.name);
  }
  return map;
}

export class AcpSession {
  private activeTurn: ActiveTurn | undefined;

  /** Currently-selected model id (bare, no suffix). Empty when unbound. */
  private currentModelId: string = '';
  /** Whether the thinking toggle is on for this session. */
  private currentThinkingEnabled: boolean = false;
  /** Current ACP mode. */
  private currentModeId: AcpModeId = DEFAULT_MODE_ID;
  /** Bridges engine approval / ask-user requests to the ACP client. */
  private readonly interactionBridge: AcpInteractionBridge;

  constructor(
    private readonly conn: AgentSideConnection,
    private readonly sessionHandle: ISessionScopeHandle,
    private readonly mainAgent: IAgentScopeHandle,
    readonly sessionId: string,
  ) {
    this.initConfigState();
    this.interactionBridge = new AcpInteractionBridge(conn, sessionHandle, sessionId);
  }

  /**
   * Tear down per-session resources. Cancels the in-flight turn (if any) and
   * stops forwarding approval / ask-user requests to the client. Idempotent.
   */
  dispose(): void {
    this.cancel();
    this.interactionBridge.dispose();
  }

  /**
   * Replay the main agent's persisted context history as an ordered batch of
   * `session/update` notifications. Used by `session/load` so the client
   * re-renders prior turns before the response settles. Awaits every push for
   * ordering — replay is a one-shot batch, not a live stream.
   */
  async replayHistory(): Promise<void> {
    let messages: readonly ContextMessage[];
    try {
      messages = this.mainAgent.accessor.get(IAgentContextMemoryService).get();
    } catch (error) {
      log.warn('acp: replayHistory could not read context memory', {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const updates = projectHistoryToSessionUpdates(this.sessionId, messages);
    for (const update of updates) {
      try {
        await this.conn.sessionUpdate(update);
      } catch (error) {
        // A single transient push failure must not truncate the whole replay;
        // log and continue so the rest of the history still lands.
        log.warn('acp: replayHistory failed to push a session/update; continuing', {
          sessionId: this.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** The live session scope handle (for per-session service resolution). */
  get handle(): ISessionScopeHandle {
    return this.sessionHandle;
  }

  /** Seed config state from the main agent's profile (best-effort). */
  private initConfigState(): void {
    try {
      const data = this.mainAgent.accessor.get(IAgentProfileService).data();
      this.currentModelId = data.modelAlias ?? '';
      const level = data.thinkingLevel;
      this.currentThinkingEnabled =
        typeof level === 'string' && level.length > 0 && level !== 'off';
    } catch {
      // keep defaults (unbound / no model)
    }
  }

  /** Resolve the session's invocable skills into a command-name → skill map. */
  private skillCommandMap(): ReadonlyMap<string, string> {
    const catalog = this.sessionHandle.accessor.get(ISessionSkillCatalog).catalog;
    return buildSkillCommandMap(catalog);
  }

  /** Build the `available_commands_update` payload (builtins + skills). */
  availableCommands(): AvailableCommand[] {
    const catalog = this.sessionHandle.accessor.get(ISessionSkillCatalog).catalog;
    const skills: AvailableCommand[] = catalog.listInvocableSkills().map((skill) => ({
      name: skill.name,
      description: skill.description,
    }));
    return [...ACP_BUILTIN_SLASH_COMMANDS, ...skills];
  }

  /** Push the current `available_commands_update` to the client. */
  async emitAvailableCommandsUpdate(): Promise<void> {
    try {
      await this.sessionHandle.accessor.get(ISessionSkillCatalog).ready;
      await this.conn.sessionUpdate(
        availableCommandsUpdateNotification(this.sessionId, this.availableCommands()),
      );
    } catch (error) {
      log.warn('acp: failed to push available_commands_update', {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async prompt(blocks: readonly ContentBlock[]): Promise<PromptResponse> {
    const text = leadingText(blocks);
    if (text !== undefined) {
      const intent = detectSlashIntent(text, this.skillCommandMap());
      if (intent.kind === 'skill') {
        return this.driveTurn(() =>
          this.mainAgent.accessor.get(IAgentSkillService).activate({
            name: intent.skillName,
            args: intent.args.length > 0 ? intent.args : undefined,
          }),
        );
      }
      // 'builtin' and 'unknown' commands fall through to a normal prompt for
      // now — builtin command execution is a later phase.
    }

    const content = acpBlocksToContentParts(blocks);
    const message: ContextMessage = {
      role: 'user',
      content: [...content],
      toolCalls: [],
      origin: { kind: 'user' },
    };
    return this.driveTurn(() =>
      this.mainAgent.accessor.get(IAgentPromptService).inject(message),
    );
  }

  /**
   * Drive a turn to completion: subscribe the main agent's `IEventBus` BEFORE
   * launching (so no events are missed), translate each event into an ACP
   * `session/update`, and settle on `turn.ended` (falling back to the turn's
   * `result` promise). Used by both normal prompts and skill activations.
   */
  private driveTurn(launch: () => Promise<AgentTurn | undefined>): Promise<PromptResponse> {
    return new Promise<PromptResponse>((resolve, reject) => {
      const eventBus = this.mainAgent.accessor.get(IEventBus);
      let settled = false;

      // Per-tool-call streaming state, reset for every turn.
      const accumulators = new Map<string, { args: string }>();
      const lazyCreated = new Set<string>();
      const started = new Set<string>();

      const settle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        sub.dispose();
        this.activeTurn = undefined;
        action();
      };

      const emit = (notification: SessionNotification | null): void => {
        if (notification === null) return;
        void this.conn.sessionUpdate(notification).catch((error) => {
          log.warn('acp: failed to push session/update', {
            sessionId: this.sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      };

      const handleEvent = (event: DomainEvent): void => {
        switch (event.type) {
          case 'assistant.delta':
            emit(assistantDeltaToSessionUpdate(this.sessionId, event));
            break;
          case 'thinking.delta':
            emit(thinkingDeltaToSessionUpdate(this.sessionId, event));
            break;
          case 'tool.call.delta': {
            const key = event.toolCallId;
            if (!started.has(key) && !lazyCreated.has(key)) {
              lazyCreated.add(key);
              accumulators.set(key, { args: event.argumentsPart ?? '' });
              emit(toolCallLazyCreateToSessionUpdate(this.sessionId, event));
              break;
            }
            const acc = accumulators.get(key) ?? { args: '' };
            accumulators.set(key, acc);
            emit(toolCallDeltaToSessionUpdate(this.sessionId, event, acc));
            break;
          }
          case 'tool.call.started': {
            const key = event.toolCallId;
            started.add(key);
            if (lazyCreated.has(key)) {
              emit(toolCallStartedUpgradeToSessionUpdate(this.sessionId, event));
            } else {
              emit(toolCallStartToSessionUpdate(this.sessionId, event));
            }
            // (Re)seed the accumulator with the canonical args so any later
            // delta appends correctly.
            accumulators.set(key, { args: stringifyArgs(event.args) });
            if (event.display) {
              emit(planFromDisplayBlock(this.sessionId, event.turnId, event.display));
            }
            break;
          }
          case 'tool.progress':
            emit(toolProgressToSessionUpdate(this.sessionId, event));
            break;
          case 'tool.result':
            emit(toolResultToSessionUpdate(this.sessionId, event));
            break;
          case 'turn.ended':
            settle(() =>
              resolve({ stopReason: turnEndReasonToStopReason(event.reason, event.error) }),
            );
            break;
          default:
            break;
        }
      };

      const sub = eventBus.subscribe(handleEvent);

      launch().then(
        (turn) => {
          if (turn === undefined) {
            // busy / not runnable / hook-blocked — no turn will emit
            // `turn.ended`, so settle gracefully.
            settle(() => resolve({ stopReason: 'end_turn' }));
            return;
          }
          this.activeTurn = turn;
          // Fallback settlement: `turn.ended` is the primary signal, but if the
          // turn resolves/rejects without it, settle here so the prompt never
          // hangs.
          turn.result.then(
            () => settle(() => resolve({ stopReason: 'end_turn' })),
            (error) => settle(() => reject(error)),
          );
        },
        (error) => settle(() => reject(error)),
      );
    });
  }

  /** Cancel the in-flight turn, if any. Idempotent. */
  cancel(): void {
    if (this.activeTurn !== undefined) {
      this.activeTurn.cancel();
      this.activeTurn = undefined;
    }
  }

  /** Build the current `configOptions` snapshot (model + thinking? + mode). */
  configOptions(): SessionConfigOption[] {
    const models = projectModelCatalog(this.sessionHandle.accessor.get(IModelService).list());
    return buildSessionConfigOptions(
      models,
      this.currentModelId,
      this.currentThinkingEnabled,
      this.currentModeId,
    );
  }

  /** Switch the active model. */
  async setModel(id: string): Promise<void> {
    await this.mainAgent.accessor.get(IAgentProfileService).setModel(id);
    this.currentModelId = id;
    await this.emitConfigOptionUpdate();
  }

  /** Flip the thinking toggle. */
  async setThinking(on: boolean): Promise<void> {
    const models = projectModelCatalog(this.sessionHandle.accessor.get(IModelService).list());
    const entry = models.find((m) => m.id === this.currentModelId);
    const effort = on ? (entry?.defaultThinkingEffort ?? 'on') : 'off';
    this.mainAgent.accessor.get(IAgentProfileService).setThinking(effort);
    this.currentThinkingEnabled = on;
    await this.emitConfigOptionUpdate();
  }

  /** Switch the ACP mode (plan mode + permission mode). */
  async setMode(id: AcpModeId): Promise<void> {
    const { plan, permission } = acpModeToToggles(id);
    this.mainAgent.accessor.get(IAgentPermissionModeService).setMode(permission);
    try {
      const planService = this.mainAgent.accessor.get(IAgentPlanService);
      if (plan) await planService.enter();
      else planService.exit();
    } catch (error) {
      log.warn('acp: plan mode toggle failed', {
        sessionId: this.sessionId,
        mode: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.currentModeId = id;
    await this.emitConfigOptionUpdate();
  }

  /** Push a fresh `config_option_update` to the client. */
  private async emitConfigOptionUpdate(): Promise<void> {
    try {
      await this.conn.sessionUpdate(
        configOptionUpdateNotification(this.sessionId, this.configOptions()),
      );
    } catch (error) {
      log.warn('acp: failed to push config_option_update', {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
