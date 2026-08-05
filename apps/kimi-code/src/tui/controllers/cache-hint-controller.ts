/**
 * CacheHintController — drives the "cache expired" dialog for the two trigger
 * scenarios: resuming a long-idle session (fires right after the resume
 * finishes loading) and submitting after an in-process idle stretch
 * (intercepts the submit). Owns the frequency guards and the in-process
 * activity baseline; the pure trigger rule lives in `../utils/cache-hint`.
 */

import type { Component, Focusable } from '@moonshot-ai/pi-tui';
import type { KimiHarness, Session } from '@moonshot-ai/kimi-code-sdk';

import { getCacheHintConfig, peekCacheHintConfig } from '#/utils/cache-hint-config';
import { currentTuiConfig } from '../commands/config';
import {
  CacheHintDialogComponent,
  type CacheHintAction,
} from '../components/dialogs/cache-hint-dialog';
import { saveTuiConfig } from '../config';
import { MAIN_AGENT_ID } from '../constant/kimi-tui';
import type { AppState } from '../types';
import type { TUIState } from '../tui-state';
import { evaluateCacheHint } from '../utils/cache-hint';
import { formatErrorMessage } from '../utils/event-payload';

export interface CacheHintHost {
  readonly engineV2: boolean;
  readonly harness: KimiHarness;
  readonly session: Session | undefined;
  readonly state: TUIState;
  track(event: string, props?: Record<string, unknown>): void;
  setAppState(patch: Partial<AppState>): void;
  mountEditorReplacement(panel: Component & Focusable): void;
  restoreEditor(): void;
  restoreInputText(text: string): void;
  showError(message: string): void;
  createNewSession(): Promise<void>;
  sendNormalUserInput(text: string): Promise<void>;
}

type HintDecision = { readonly idleSeconds: number; readonly totalTokens: number };

export class CacheHintController {
  /** Latest in-process LLM round-trip time (turn begin / turn end). */
  private lastActivityAt: number | undefined;
  /** One prompt per idle cycle; reset when a real send starts a turn. */
  private idlePrompted = false;
  /** Cold-cache trigger fetches at most once per idle cycle (loop guard for
   *  the release-and-resend path). */
  private triggerFetchAttempted = false;
  /** Resume scenario fires at most once per session per TUI instance. */
  private readonly resumedSessions = new Set<string>();

  constructor(private readonly host: CacheHintHost) {}

  recordActivity(): void {
    this.lastActivityAt = Date.now();
  }

  /** A real send starts a turn — new activity and a new idle cycle. */
  onTurnBegin(): void {
    this.recordActivity();
    this.idlePrompted = false;
    this.triggerFetchAttempted = false;
  }

  /** Session switch / create: the new session has no in-process baseline. */
  resetRuntime(): void {
    this.lastActivityAt = undefined;
    this.idlePrompted = false;
    this.triggerFetchAttempted = false;
  }

  /** Background warm-up on session creation; never blocks, never throws. */
  refreshConfigInBackground(): void {
    void this.resolveConfig();
  }

  /** Scenario 1: call right after a resume finishes loading. */
  async maybeShowOnResume(): Promise<void> {
    const { host } = this;
    const session = host.session;
    if (!host.engineV2 || session === undefined) return;
    if (this.resumedSessions.has(session.id)) return;
    const main = session.getResumeState()?.agents[MAIN_AGENT_ID];
    let lastActiveAt = 0;
    for (const record of main?.replay ?? []) {
      if (record.time > lastActiveAt) lastActiveAt = record.time;
    }
    // `summary.updatedAt` ≈ last user prompt — a coarser but valid fallback.
    if (lastActiveAt === 0) lastActiveAt = session.summary?.updatedAt ?? 0;
    if (lastActiveAt === 0) return;
    const decision = evaluateCacheHint({
      now: Date.now(),
      lastActiveAt,
      totalTokens: main?.context.tokenCount,
      modelId: this.upstreamModelId(),
      config: await this.resolveConfig(),
      dismissed: host.state.appState.cacheExpiryHint === false,
    });
    if (decision.kind === 'skip') return;
    this.resumedSessions.add(session.id);
    // The resume dialog also covers this idle cycle: the first submit right
    // after it must not be intercepted again.
    this.idlePrompted = true;
    await this.showDialog('resume', decision, undefined);
  }

  /**
   * Scenario 2: intercept an idle submit. Returns true when swallowed.
   * Synchronous in every non-hint path — the send pipeline must stay
   * await-free up to `sendMessage` (tests assert `prompt()` synchronously
   * right after `handleUserInput`). When the config cache is cold the submit
   * is swallowed while the config is fetched (spec: the trigger must reach
   * the interface); the message is then either shown the dialog or released.
   */
  maybeInterceptOnSubmit(text: string): boolean {
    const { host } = this;
    if (!host.engineV2 || host.session === undefined) return false;
    if (this.idlePrompted || this.lastActivityAt === undefined) return false;
    if (host.state.appState.streamingPhase !== 'idle' || host.state.appState.isCompacting) {
      return false;
    }
    if (host.state.appState.cacheExpiryHint === false) return false;
    // Coarse floor: configured cache durations are 10min+, so anything
    // fresher than a minute can never hint.
    if (Date.now() - this.lastActivityAt < 60_000) return false;
    const cached = peekCacheHintConfig();
    if (cached !== undefined) {
      const decision = evaluateCacheHint({
        now: Date.now(),
        lastActiveAt: this.lastActivityAt,
        totalTokens: host.state.appState.contextTokens,
        modelId: this.upstreamModelId(),
        config: cached,
        dismissed: false,
      });
      if (decision.kind === 'skip') return false;
      this.idlePrompted = true;
      // Mounts synchronously inside; the action resolution runs async.
      void this.showDialog('idle', decision, text);
      return true;
    }
    // Config cache cold: fetch at trigger time, once per idle cycle.
    if (this.triggerFetchAttempted) return false;
    this.triggerFetchAttempted = true;
    void this.interceptAfterFetch(text);
    return true;
  }

  /** Cold-cache path: fetch the config, then show the dialog or release. */
  private async interceptAfterFetch(text: string): Promise<void> {
    const config = await this.resolveConfig();
    if (config !== undefined) {
      const decision = evaluateCacheHint({
        now: Date.now(),
        lastActiveAt: this.lastActivityAt ?? 0,
        totalTokens: this.host.state.appState.contextTokens,
        modelId: this.upstreamModelId(),
        config,
        dismissed: false,
      });
      if (decision.kind === 'hint') {
        this.idlePrompted = true;
        await this.showDialog('idle', decision, text);
        return;
      }
    }
    // No hint (fetch failed or rules don't match): release the message. The
    // re-entry skips the fetch (fresh cache or triggerFetchAttempted) and
    // flows straight to send.
    await this.host.sendNormalUserInput(text);
  }

  private upstreamModelId(): string | undefined {
    const { model, availableModels, availableProviders } = this.host.state.appState;
    const alias = availableModels[model];
    if (alias === undefined) return undefined;
    // The cache rules describe the managed service's server-side cache, so
    // they only apply to OAuth-managed providers — apiKey or self-hosted
    // providers never hint.
    if (availableProviders[alias.provider]?.oauth === undefined) return undefined;
    return alias.model;
  }

  private async resolveConfig() {
    let accessToken: string | undefined;
    try {
      accessToken = await this.host.harness.auth.getCachedAccessToken();
    } catch {
      // Facade unavailable (test doubles) — never fetch.
      return undefined;
    }
    // The endpoint is public: apiKey-only users fetch anonymously.
    return getCacheHintConfig({ accessToken });
  }

  private async showDialog(
    scene: 'resume' | 'idle',
    decision: HintDecision,
    stashedInput: string | undefined,
  ): Promise<void> {
    const { host } = this;
    host.track('cache_hint_shown', {
      scene,
      model: host.state.appState.model,
      idle_seconds: decision.idleSeconds,
      total_tokens: decision.totalTokens,
    });
    const action = await new Promise<CacheHintAction | 'dismiss'>((resolve) => {
      host.state.activeDialog = 'cache-hint';
      host.mountEditorReplacement(
        new CacheHintDialogComponent({
          idleSeconds: decision.idleSeconds,
          totalTokens: decision.totalTokens,
          onSelect: (a) => {
            resolve(a);
          },
          onCancel: () => {
            resolve('dismiss');
          },
        }),
      );
    });
    host.state.activeDialog = null;
    host.restoreEditor();
    host.track('cache_hint_action', { action, scene });
    await this.runAction(action, stashedInput);
  }

  private async runAction(
    action: CacheHintAction | 'dismiss',
    stashedInput: string | undefined,
  ): Promise<void> {
    const { host } = this;
    const restoreInput = () => {
      if (stashedInput !== undefined) host.restoreInputText(stashedInput);
    };
    switch (action) {
      case 'dismiss':
        restoreInput();
        return;
      case 'never':
        host.setAppState({ cacheExpiryHint: false });
        try {
          await saveTuiConfig({ ...currentTuiConfig(host), cacheExpiryHint: false });
        } catch {
          host.showError('Failed to save the tui.toml preference.');
        }
        break;
      case 'compact': {
        const session = host.session;
        if (session !== undefined) {
          try {
            await session.compact({});
          } catch (error) {
            host.showError(`Compact failed: ${formatErrorMessage(error)}`);
            restoreInput();
            return;
          }
          if (stashedInput !== undefined) {
            // compact() is trigger-only — the engine engages asynchronously.
            // Wait for the engagement barrier so the resend lands in the
            // queue and drains automatically when compaction finishes.
            if (!(await this.waitForCompactionStart())) {
              host.showError('Compact did not start; message not sent.');
              restoreInput();
              return;
            }
          }
        }
        break;
      }
      case 'new': {
        const previousId = host.state.appState.sessionId;
        await host.createNewSession();
        if (host.state.appState.sessionId === previousId) {
          // Creation failed (error already surfaced); keep the input for retry.
          restoreInput();
          return;
        }
        break;
      }
      case 'continue':
        break;
    }
    if (stashedInput !== undefined) await host.sendNormalUserInput(stashedInput);
  }

  /** Bounded wait for the engine to flip `isCompacting` after a compact RPC. */
  private async waitForCompactionStart(timeoutMs = 3000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.host.state.appState.isCompacting) return true;
      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });
    }
    return false;
  }
}
