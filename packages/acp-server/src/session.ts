/**
 * ACP session (v2) — drives a single main agent over one ACP `sessionId`,
 * through the `Klient` facade. `start.ts` creates the klient over the
 * in-memory transport; everything below goes through facade calls and typed
 * klient events, so swapping the transport (http / ipc) requires no change
 * here.
 *
 * `prompt` submits the user input via `agent.prompt(...)` and translates the
 * agent's scoped event stream — subscribed once per session in `init()`,
 * before the first prompt — into ACP `session/update` notifications via the
 * helpers in `./events-map`. The promise settles on the `turn.ended` event; a
 * submission that launches no turn (busy / hook-blocked / not runnable)
 * settles gracefully with `end_turn`, mirroring the engine's `PromptHandle`
 * behavior.
 *
 * KLIENT GAPS (all reported; each marked `KLIENT-GAP` inline):
 *  - no session skill catalog / skill activation → skills are not advertised
 *    and slash-skill input degrades to a plain prompt.
 *  - no thinking read/write → the thinking config option is hidden rather
 *    than advertising a toggle that cannot take effect.
 *  - no `tool.call.delta` / `tool.progress` events → streaming-args lazy
 *    create/accumulation and mid-call title progress are skipped (the
 *    `events-map` helpers for them stay ready to re-wire).
 *  - no `Turn.result` promise → settlement relies solely on `turn.ended`.
 */

import type {
  AgentSideConnection,
  AvailableCommand,
  ContentBlock,
  PromptResponse,
  SessionConfigOption,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import { RequestError } from '@agentclientprotocol/sdk';
import type { ContextMessage } from '@moonshot-ai/agent-core-v2';
import type {
  AgentEventPayloads,
  AgentHandle,
  ContentPart,
  IDisposable,
  Klient,
  SessionHandle,
} from '@moonshot-ai/klient';
import type {
  ToolCallStartedEvent,
  ToolInputDisplay,
  ToolResultEvent,
} from '@moonshot-ai/protocol';

import { buildSessionConfigOptions } from './config-options';
import { acpBlocksToContentParts } from './convert';
import {
  assistantDeltaToSessionUpdate,
  availableCommandsUpdateNotification,
  configOptionUpdateNotification,
  planFromDisplayBlock,
  thinkingDeltaToSessionUpdate,
  toolCallStartToSessionUpdate,
  toolResultToSessionUpdate,
  turnEndReasonToStopReason,
  isAuthError,
} from './events-map';
import { AcpInteractionBridge } from './interaction-bridge';
import { log } from './log';
import { projectModelCatalog } from './model-catalog';
import { type AcpModeId, acpModeToToggles, DEFAULT_MODE_ID } from './modes';
import { projectHistoryToSessionUpdates } from './replay';
import { detectSlashIntent } from './slash';

/** Leading text of the first text block, if any (used for slash detection). */
function leadingText(blocks: readonly ContentBlock[]): string | undefined {
  const first = blocks[0];
  if (first !== undefined && first.type === 'text') return first.text;
  return undefined;
}

/** Per-turn settlement state for one in-flight `session/prompt`. */
interface TurnDriver {
  resolve(response: PromptResponse): void;
  reject(error: unknown): void;
  /**
   * Learned once `agent.prompt` resolves. Events carry a `turnId`, but until
   * this is set no turn-scoped event can be attributed to this prompt, so
   * they are ignored (e.g. events of a still-draining prior turn).
   */
  turnId?: number;
  settled: boolean;
}

export class AcpSession {
  /** The klient facade this session was created from. */
  private readonly klient: Klient;
  private readonly session: SessionHandle;
  private readonly agent: AgentHandle;

  /** Currently-selected model id (bare, no suffix). Empty when unbound. */
  private currentModelId: string = '';
  /** Current ACP mode. */
  private currentModeId: AcpModeId = DEFAULT_MODE_ID;
  /** The in-flight prompt's driver, if any. */
  private driver: TurnDriver | undefined;
  /** Session-level agent-event subscriptions, torn down by `dispose()`. */
  private readonly subscriptions: IDisposable[] = [];
  /** Bridges engine approval / ask-user requests to the ACP client. */
  private readonly interactionBridge: AcpInteractionBridge;

  constructor(
    private readonly conn: AgentSideConnection,
    klient: Klient,
    readonly sessionId: string,
  ) {
    this.klient = klient;
    this.session = klient.session(sessionId);
    // `main` is auto-materialized by the transport's scope resolution on the
    // first call — no explicit agent bootstrap is needed here.
    this.agent = this.session.agent('main');
    this.interactionBridge = new AcpInteractionBridge(conn, this.session, sessionId);
  }

  /**
   * Subscribe the agent event stream and seed the config state. Must be
   * awaited before the first `prompt` so no early turn events are missed.
   */
  async init(): Promise<void> {
    const events = this.agent.events;
    this.subscriptions.push(
      events.on('assistant.delta', (event) => {
        this.onAssistantDelta(event);
      }),
      events.on('thinking.delta', (event) => {
        this.onThinkingDelta(event);
      }),
      events.on('tool.call.started', (event) => {
        this.onToolCallStarted(event);
      }),
      events.on('tool.result', (event) => {
        this.onToolResult(event);
      }),
      events.on('turn.ended', (event) => {
        this.onTurnEnded(event);
      }),
    );
    try {
      this.currentModelId = await this.agent.getModel();
    } catch (error) {
      // Keep the unbound default ('') — configOptions stays honest.
      log.warn('acp: could not seed model state', {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Tear down per-session resources. Settles an in-flight prompt as
   * cancelled, stops forwarding approval / ask-user requests to the client,
   * and detaches the event subscriptions. Idempotent.
   */
  dispose(): void {
    this.cancel();
    const driver = this.driver;
    if (driver !== undefined) {
      // Never leave the JSON-RPC `session/prompt` hanging after teardown.
      this.settleDriver(driver, () => {
        driver.resolve({ stopReason: 'cancelled' });
      });
    }
    this.interactionBridge.dispose();
    for (const subscription of this.subscriptions.splice(0)) {
      subscription.dispose();
    }
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
      // `history` items cross the wire as JSON-cloned `ContextMessage`s (the
      // facade types them via the engine RPC signature).
      messages = (await this.agent.getContext()).history;
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

  /**
   * Build the `available_commands_update` payload.
   *
   * KLIENT-GAP(skills): klient exposes no session skill catalog, so no skills
   * can be advertised. Proposed klient API: `klient.session(id).skills.list()`
   * → readonly `{ name, description }[]` (invocable skills only, resolving the
   * catalog's readiness internally). ACP builtin slash commands stay
   * unadvertised too — the host cannot execute them yet.
   */
  availableCommands(): AvailableCommand[] {
    return [];
  }

  /** Push the current `available_commands_update` to the client. */
  async emitAvailableCommandsUpdate(): Promise<void> {
    try {
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
    // Slash-intent detection stays wired so skills resume dispatching the
    // moment klient grows a skill catalog + activation surface
    // (KLIENT-GAP(skills), see `availableCommands`). Until then the skill map
    // is empty and every slash command falls through to a normal prompt —
    // `builtin` command execution is a later phase either way.
    const text = leadingText(blocks);
    if (text !== undefined && detectSlashIntent(text, this.skillCommandMap()).kind === 'skill') {
      log.warn('acp: skill command matched but skill activation is unavailable; sending as prompt');
    }

    const content = acpBlocksToContentParts(blocks);
    return this.driveTurn(content);
  }

  /**
   * The skill command lookup.
   *
   * KLIENT-GAP(skills): empty until klient exposes the session skill catalog.
   */
  private skillCommandMap(): ReadonlyMap<string, string> {
    return new Map();
  }

  /**
   * Submit the prompt and drive the turn to completion: `agent.prompt()`
   * returns the launched turn id, which the session-level event handlers use
   * to attribute events to this driver. Settles on `turn.ended`; a no-launch
   * result (busy / hook-blocked / not runnable) settles with `end_turn`.
   */
  private driveTurn(input: readonly ContentPart[]): Promise<PromptResponse> {
    return new Promise<PromptResponse>((resolve, reject) => {
      const driver: TurnDriver = { resolve, reject, settled: false };
      this.driver = driver;
      this.agent.prompt({ input }).then(
        (launched) => {
          if (driver.settled) return;
          if (launched === undefined) {
            // No turn will emit `turn.ended`, so settle gracefully. The engine
            // publishes a `prompt.completed` with reason 'blocked' for the
            // hook-blocked case; the wire carries no blocking message to
            // surface, matching the old `PromptHandle`-based behavior.
            this.settleDriver(driver, () => {
              resolve({ stopReason: 'end_turn' });
            });
            return;
          }
          driver.turnId = launched.turn_id;
        },
        (error) => {
          this.settleDriver(driver, () => {
            reject(error);
          });
        },
      );
    });
  }

  /**
   * Settle the driver exactly once and detach it from the session so later
   * events of its turn are ignored.
   */
  private settleDriver(driver: TurnDriver, action: () => void): void {
    if (driver.settled) return;
    driver.settled = true;
    if (this.driver === driver) this.driver = undefined;
    action();
  }

  /** The active driver, but only for events of ITS turn. */
  private driverFor(turnId: number): TurnDriver | undefined {
    const driver = this.driver;
    if (driver === undefined || driver.turnId === undefined || driver.turnId !== turnId) {
      return undefined;
    }
    return driver;
  }

  private onAssistantDelta(event: AgentEventPayloads['assistant.delta']): void {
    if (this.driverFor(event.turnId) === undefined) return;
    this.emit(assistantDeltaToSessionUpdate(this.sessionId, event));
  }

  private onThinkingDelta(event: AgentEventPayloads['thinking.delta']): void {
    if (this.driverFor(event.turnId) === undefined) return;
    this.emit(thinkingDeltaToSessionUpdate(this.sessionId, event));
  }

  private onToolCallStarted(event: AgentEventPayloads['tool.call.started']): void {
    if (this.driverFor(event.turnId) === undefined) return;
    // The klient payload mirrors `ToolCallStartedEvent` (`args` / `display`
    // arrive as `unknown` — cast at this seam).
    const mapped = event as unknown as ToolCallStartedEvent;
    this.emit(toolCallStartToSessionUpdate(this.sessionId, mapped));
    if (event.display !== undefined) {
      this.emit(
        planFromDisplayBlock(this.sessionId, event.turnId, event.display as ToolInputDisplay),
      );
    }
  }

  private onToolResult(event: AgentEventPayloads['tool.result']): void {
    if (this.driverFor(event.turnId) === undefined) return;
    this.emit(toolResultToSessionUpdate(this.sessionId, event as unknown as ToolResultEvent));
  }

  private onTurnEnded(event: AgentEventPayloads['turn.ended']): void {
    const driver = this.driverFor(event.turnId);
    if (driver === undefined) return;
    const error = event.error as { readonly code: string; readonly message?: string } | undefined;
    this.settleDriver(driver, () => {
      // Auth failures must surface as a JSON-RPC `auth_required` error
      // so the client triggers its re-auth flow, not a silent `end_turn`.
      if (event.reason === 'failed' && isAuthError(error)) {
        driver.reject(RequestError.authRequired(undefined, error?.message));
        return;
      }
      driver.resolve({ stopReason: turnEndReasonToStopReason(event.reason, error) });
    });
  }

  /** Push a `session/update` notification (best-effort, never throws). */
  private emit(notification: SessionNotification | null): void {
    if (notification === null) return;
    void this.conn.sessionUpdate(notification).catch((error) => {
      log.warn('acp: failed to push session/update', {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /** Cancel the in-flight turn, if any. Idempotent. */
  cancel(): void {
    const turnId = this.driver?.turnId;
    if (turnId === undefined) return;
    void this.agent.cancel({ turnId }).catch((error) => {
      log.warn('acp: cancel failed', {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * Build the current `configOptions` snapshot (model + mode; thinking stays
   * hidden).
   *
   * KLIENT-GAP(thinking): klient exposes neither a thinking read
   * (`AgentConfigData.thinkingLevel`) nor `setThinking`, so the option is
   * filtered out rather than advertising a toggle that cannot take effect.
   * Proposed klient API: `agent.setThinking(level: string)` +
   * `agent.getConfig()` (or `getThinking()`); once available, seed
   * `currentThinkingEnabled` in `init()` and stop filtering.
   */
  async configOptions(): Promise<SessionConfigOption[]> {
    const models = projectModelCatalog(await this.klient.global.models.list());
    return buildSessionConfigOptions(models, this.currentModelId, false, this.currentModeId).filter(
      (option) => option.id !== 'thinking',
    );
  }

  /** Switch the active model. */
  async setModel(id: string): Promise<void> {
    await this.agent.setModel(id);
    this.currentModelId = id;
    await this.emitConfigOptionUpdate();
  }

  /** Switch the ACP mode (plan mode + permission mode). */
  async setMode(id: AcpModeId): Promise<void> {
    const { plan, permission } = acpModeToToggles(id);
    await this.agent.setPermission(permission);
    try {
      if (plan) {
        await this.agent.enterPlan();
      } else {
        // KLIENT-GAP(plan): `exitPlan` (`planService.exit()`) is not on the
        // klient surface; `cancelPlan` (`planModeCancel`) has the identical
        // state effect (see `agent/plan/planOps.ts`) — only the persisted op
        // name differs.
        await this.agent.cancelPlan();
      }
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
        configOptionUpdateNotification(this.sessionId, await this.configOptions()),
      );
    } catch (error) {
      log.warn('acp: failed to push config_option_update', {
        sessionId: this.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
