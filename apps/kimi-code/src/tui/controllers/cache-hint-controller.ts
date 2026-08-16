/**
 * CacheHintController — drives the "cache expired" dialog for the two trigger
 * scenarios: resuming a long-idle session (fires right after the resume
 * finishes loading) and submitting after an in-process idle stretch
 * (intercepts the submit). Owns the frequency guards and the in-process
 * activity baseline; the pure trigger rule lives in `../utils/cache-hint`.
 */

import type { Component, Focusable } from '@moonshot-ai/pi-tui';
import type { KimiHarness, Session, TokenUsage } from '@moonshot-ai/kimi-code-sdk';

import { getCacheHintConfig, peekCacheHintConfig } from '#/utils/cache-hint-config';
import { currentTuiConfig } from '../commands/config';
import {
  CacheHintDialogComponent,
  type CacheHintAction,
} from '../components/dialogs/cache-hint-dialog';
import { saveTuiConfig } from '../config';
import { MAIN_AGENT_ID } from '../constant/kimi-tui';
import type { AppState, InlineSkillActivation } from '../types';
import type { TUIState } from '../tui-state';
import { evaluateCacheHint } from '../utils/cache-hint';
import { formatErrorMessage } from '../utils/event-payload';
import type { ExtractionResult } from '../utils/image-placeholder';

/** A swallowed submit: the raw text plus its media extraction (done before
 *  the dialog so pasted attachments survive a later store clear). */
interface StashedSubmit {
  readonly text: string;
  readonly extraction?: ExtractionResult;
  readonly inlineSkillActivations?: readonly InlineSkillActivation[];
}

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
  sendNormalUserInput(text: string, preExtracted?: ExtractionResult): Promise<void>;
  sendInlineSkillUserInput(
    text: string,
    activations: readonly InlineSkillActivation[],
    preExtracted?: ExtractionResult,
  ): Promise<void>;
}

type HintDecision = { readonly idleSeconds: number; readonly totalTokens: number };

/** Cache-break detection: a step's cache read dropping under 95% of the
 *  previous step's by more than this many tokens counts as a break. */
const CACHE_BREAK_MIN_DROP_TOKENS = 2000;
const CACHE_BREAK_DROP_RATIO = 0.95;

interface CacheBreakBaseline {
  readonly model: string;
  readonly effort: string;
  readonly usage: TokenUsage;
  readonly time: number;
}

export class CacheHintController {
  /** Latest in-process LLM round-trip time (turn begin / turn end). */
  private lastActivityAt: number | undefined;
  /** One prompt per idle cycle; reset when a real send starts a turn. */
  private idlePrompted = false;
  /** Cold-cache trigger fetches at most once per idle cycle (loop guard for
   *  the release-and-resend path). */
  private triggerFetchAttempted = false;
  /** Swallowed submits waiting on the cold-cache interception chain. */
  private pendingInterceptions = 0;
  /** FIFO chain serializing swallowed submits so they keep submit order. */
  private interceptionTail: Promise<void> = Promise.resolve();
  /** Set while a stashed message is being released back into the send path. */
  private releasingStashed = false;
  /** Whether the idle dialog's triggering message was restored, not sent. */
  private lastDialogRestored = false;
  /** Inputs restored this cycle — chained restores append (newline-joined)
   *  instead of overwriting the editor. */
  private restoredTexts: string[] = [];
  /** Resume scenario fires at most once per session per TUI instance. */
  private readonly resumedSessions = new Set<string>();
  /** Last measured main-loop step usage for cache-break detection. */
  private breakBaseline: CacheBreakBaseline | undefined;

  constructor(private readonly host: CacheHintHost) {}

  /**
   * Cache-break detection (client-side, main loop): feed each completed
   * step's usage. A step whose cache read drops sharply below the previous
   * one is reported as `cache_break_detected` with both usages, both
   * model/effort values, the drop ratio, and the interval — a mid-session
   * model/effort switch busts the cache key, and that cause is exactly what
   * the report should carry. Unmeasured (missing/all-zero) usage is skipped
   * without touching the baseline; compaction resets it (the drop there is
   * expected).
   *
   * Also doubles as the cache-activity signal: a completed step is a real
   * provider round trip, so the server-side cache was just refreshed —
   * unlike a bare turn begin, whose prompt may still fail before any model
   * request.
   */
  noteStepUsage(usage: TokenUsage | undefined): void {
    this.recordActivity();
    if (usage === undefined) return;
    if (
      usage.inputOther === 0 &&
      usage.output === 0 &&
      usage.inputCacheRead === 0 &&
      usage.inputCacheCreation === 0
    ) {
      return;
    }
    const model = this.host.state.appState.model;
    const effort = this.host.state.appState.thinkingEffort;
    const now = Date.now();
    const prev = this.breakBaseline;
    this.breakBaseline = { model, effort, usage, time: now };
    if (prev === undefined) return;
    const prevRead = prev.usage.inputCacheRead;
    const currRead = usage.inputCacheRead;
    if (currRead >= prevRead * CACHE_BREAK_DROP_RATIO) return;
    if (prevRead - currRead <= CACHE_BREAK_MIN_DROP_TOKENS) return;
    this.host.track('cache_break_detected', {
      prev_model: prev.model,
      curr_model: model,
      prev_effort: prev.effort,
      curr_effort: effort,
      prev_input_cache_read: prevRead,
      curr_input_cache_read: currRead,
      prev_input_other: prev.usage.inputOther,
      curr_input_other: usage.inputOther,
      prev_output: prev.usage.output,
      curr_output: usage.output,
      prev_input_cache_creation: prev.usage.inputCacheCreation,
      curr_input_cache_creation: usage.inputCacheCreation,
      cache_read_drop_ratio: (prevRead - currRead) / prevRead,
      interval_ms: now - prev.time,
    });
  }

  /** Compaction legitimately shrinks the cached prefix — reset the baseline.
   *  Also used when the context is cut by other means (e.g. /undo). */
  resetCacheBreakBaseline(): void {
    this.breakBaseline = undefined;
  }

  recordActivity(): void {
    this.lastActivityAt = Date.now();
  }

  /**
   * A real send starts a turn — open a fresh idle cycle. Cache activity is
   * deliberately NOT recorded here: the prompt may still fail before any
   * model request (rejected call, hook-blocked turn), and only a completed
   * provider round trip refreshes the server-side cache.
   */
  onTurnBegin(): void {
    this.idlePrompted = false;
    this.triggerFetchAttempted = false;
    this.lastDialogRestored = false;
    this.restoredTexts = [];
  }

  /** Session switch / create: the new session has no in-process baseline. */
  resetRuntime(): void {
    this.lastActivityAt = undefined;
    this.idlePrompted = false;
    this.triggerFetchAttempted = false;
    this.lastDialogRestored = false;
    this.restoredTexts = [];
    this.breakBaseline = undefined;
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
      // Only message/compaction records correspond to LLM round-trips; state
      // records (permission/plan/config updates, approval results) can be
      // appended by slash commands without touching the cache.
      if (record.type !== 'message' && record.type !== 'compaction') continue;
      if (record.time > lastActiveAt) lastActiveAt = record.time;
    }
    // `summary.updatedAt` ≈ last user prompt — a coarser but valid fallback.
    if (lastActiveAt === 0) lastActiveAt = session.summary?.updatedAt ?? 0;
    if (lastActiveAt === 0) return;
    const config = await this.resolveConfig();
    // The config fetch above can outlive the user's patience: if they switched
    // sessions meanwhile, this dialog (and its actions) would target the wrong
    // session — drop it. Likewise, if they already sent the first prompt and
    // a turn is now running, don't mount over the active turn.
    if (host.session !== session) return;
    if (host.state.appState.streamingPhase !== 'idle' || host.state.appState.isCompacting) {
      return;
    }
    // Fold in-process activity into the replay-derived baseline before
    // judging: a turn may have completed during the fetch, and a completed
    // turn refreshes the server-side cache — the stale replay timestamp would
    // warn about an expiration the user just paid to fix. Seeding the
    // baseline either way also lets a resume inside the cache window expire
    // via the idle-submit path while the user idles in the TUI.
    lastActiveAt = Math.max(lastActiveAt, this.lastActivityAt ?? 0);
    this.lastActivityAt = lastActiveAt;
    const decision = evaluateCacheHint({
      now: Date.now(),
      lastActiveAt,
      totalTokens: main?.context.tokenCount,
      modelId: this.upstreamModelId(),
      config,
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
  maybeInterceptOnSubmit(
    text: string,
    extraction?: ExtractionResult,
    inlineSkillActivations?: readonly InlineSkillActivation[],
  ): boolean {
    const { host } = this;
    if (!host.engineV2 || host.session === undefined) return false;
    // A stashed message being released re-enters the send path here — never
    // re-intercept it (that would start a second fetch loop).
    if (this.releasingStashed) return false;
    if (this.idlePrompted || this.lastActivityAt === undefined) return false;
    if (host.state.appState.streamingPhase !== 'idle' || host.state.appState.isCompacting) {
      return false;
    }
    if (host.state.appState.cacheExpiryHint === false) return false;
    // Providers that can never match a cache rule (apiKey / self-hosted) must
    // not pay the cold-fetch stall below — no hint can ever come of it.
    if (this.upstreamModelId() === undefined) return false;
    // Coarse floor: configured cache durations are 10min+, so anything
    // fresher than a minute can never hint.
    if (Date.now() - this.lastActivityAt < 60_000) return false;
    const stash: StashedSubmit = { text, extraction, inlineSkillActivations };
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
      void this.showDialog('idle', decision, stash);
      return true;
    }
    // Config cache cold: fetch at trigger time. Submits arriving while the
    // interception is in flight are swallowed too and replayed through a FIFO
    // chain, so a later prompt can never overtake the stashed one. A fetch
    // that already failed this cycle falls through to the normal send path.
    if (this.triggerFetchAttempted && this.pendingInterceptions === 0) return false;
    this.triggerFetchAttempted = true;
    const sessionId = host.session.id;
    this.pendingInterceptions += 1;
    this.interceptionTail = this.interceptionTail
      .then(() => this.interceptAfterFetch(stash, sessionId))
      .finally(() => {
        this.pendingInterceptions -= 1;
      });
    return true;
  }

  /** Cold-cache path: fetch the config, then show the dialog or release. */
  private async interceptAfterFetch(stash: StashedSubmit, sessionId: string): Promise<void> {
    const { host } = this;
    // A dialog already ran for this idle cycle: chained submits follow the
    // fate of the message that opened it. If that message was restored
    // (dismissed or its action failed), restore these too — sending them now
    // would reorder the conversation.
    if (this.idlePrompted) {
      if (this.lastDialogRestored) {
        this.restoreStashedInput(stash.text);
      } else {
        await this.releaseStashed(stash);
      }
      return;
    }
    const config = await this.resolveConfig();
    // The fetch window is unbounded for the user: if they switched sessions
    // meanwhile, never send the stashed text into the wrong session — hand it
    // back to the editor instead.
    if (host.session?.id !== sessionId) {
      this.restoreStashedInput(stash.text);
      return;
    }
    // If a foreground operation (turn, /compact, …) started meanwhile, don't
    // mount over it — release through the normal path, which queues behind
    // the running operation.
    if (host.state.appState.streamingPhase !== 'idle' || host.state.appState.isCompacting) {
      await this.releaseStashed(stash);
      return;
    }
    if (config !== undefined) {
      const decision = evaluateCacheHint({
        now: Date.now(),
        lastActiveAt: this.lastActivityAt ?? 0,
        totalTokens: host.state.appState.contextTokens,
        modelId: this.upstreamModelId(),
        config,
        dismissed: false,
      });
      if (decision.kind === 'hint') {
        this.idlePrompted = true;
        await this.showDialog('idle', decision, stash);
        return;
      }
    }
    // No hint (fetch failed or rules don't match): release the message. The
    // re-entry skips the fetch (fresh cache or triggerFetchAttempted) and
    // flows straight to send.
    await this.releaseStashed(stash);
  }

  /** Release a stashed message through the normal send path, bypassing the
   *  interception gate so the re-entry cannot start a second fetch. */
  private async releaseStashed(stash: StashedSubmit): Promise<void> {
    this.releasingStashed = true;
    try {
      await this.releaseToSendPath(stash);
    } finally {
      this.releasingStashed = false;
    }
  }

  private async releaseToSendPath(stash: StashedSubmit): Promise<void> {
    if (stash.inlineSkillActivations !== undefined && stash.inlineSkillActivations.length > 0) {
      await this.host.sendInlineSkillUserInput(
        stash.text,
        stash.inlineSkillActivations,
        stash.extraction,
      );
      return;
    }
    await this.host.sendNormalUserInput(stash.text, stash.extraction);
  }

  /** Restore a stashed input to the editor, appending to anything already
   *  restored this cycle so earlier text is not overwritten. */
  private restoreStashedInput(text: string | undefined): void {
    if (text === undefined) return;
    this.restoredTexts.push(text);
    this.host.restoreInputText(this.restoredTexts.join('\n'));
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
    stashed: StashedSubmit | undefined,
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
    await this.runAction(action, stashed);
  }

  private async runAction(
    action: CacheHintAction | 'dismiss',
    stashed: StashedSubmit | undefined,
  ): Promise<void> {
    const { host } = this;
    const restoreInput = () => {
      this.lastDialogRestored = true;
      this.restoreStashedInput(stashed?.text);
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
          if (stashed !== undefined) {
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
    this.lastDialogRestored = false;
    if (stashed !== undefined) await this.releaseToSendPath(stashed);
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
