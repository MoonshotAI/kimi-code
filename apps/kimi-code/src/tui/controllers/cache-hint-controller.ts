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
import type { AppState, InlineSkillActivation } from '../types';
import type { TUIState } from '../tui-state';
import { evaluateCacheHint } from '../utils/cache-hint';
import { rebaseInlineSkillActivations } from '../utils/inline-skill-tokens';
import { formatErrorMessage } from '../utils/event-payload';
import {
  makeSessionExtractionResendable,
  type ExtractionResult,
} from '../utils/image-placeholder';

interface StashedSubmit {
  readonly text: string;
  readonly extraction?: ExtractionResult;
  readonly sessionId: string;
  readonly inlineSkillActivations?: readonly InlineSkillActivation[];
}

export interface CacheHintHost {
  readonly harness: KimiHarness;
  readonly session: Session | undefined;
  readonly state: TUIState;
  track(event: string, props?: Record<string, unknown>): void;
  setAppState(patch: Partial<AppState>): void;
  mountEditorReplacement(panel: Component & Focusable): void;
  restoreEditor(): void;
  restoreInputText(text: string, inlineSkillActivations?: readonly InlineSkillActivation[]): void;
  recallStashedMedia(extraction: ExtractionResult | undefined): void;
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

export class CacheHintController {
  private lastActivityAt: number | undefined;
  private idlePrompted = false;
  private triggerFetchAttempted = false;
  private pendingInterceptions = 0;
  private interceptionTail: Promise<void> = Promise.resolve();
  private releasingStashed = false;
  private lastDialogRestored = false;
  private restoredTexts: string[] = [];
  private restoredActivations: InlineSkillActivation[] = [];
  private readonly resumedSessions = new Set<string>();

  constructor(private readonly host: CacheHintHost) {}

  recordActivity(): void {
    this.lastActivityAt = Date.now();
  }

  onTurnBegin(): void {
    this.idlePrompted = false;
    this.triggerFetchAttempted = false;
    this.lastDialogRestored = false;
    this.restoredTexts = [];
    this.restoredActivations = [];
  }

  resetRuntime(): void {
    this.lastActivityAt = undefined;
    this.idlePrompted = false;
    this.triggerFetchAttempted = false;
    this.lastDialogRestored = false;
    this.restoredTexts = [];
    this.restoredActivations = [];
  }

  refreshConfigInBackground(): void {
    void this.resolveConfig();
  }

  async maybeShowOnResume(): Promise<void> {
    const { host } = this;
    const session = host.session;
    if (session === undefined) return;
    if (this.resumedSessions.has(session.id)) return;
    const main = session.getResumeState()?.agents[MAIN_AGENT_ID];
    let lastActiveAt = 0;
    for (const record of main?.replay ?? []) {
      if (record.type !== 'message' && record.type !== 'compaction') continue;
      if (record.time > lastActiveAt) lastActiveAt = record.time;
    }
    if (lastActiveAt === 0) lastActiveAt = session.summary?.updatedAt ?? 0;
    if (lastActiveAt === 0) return;
    const config = await this.resolveConfig();
    if (host.session !== session) return;
    if (host.state.appState.streamingPhase !== 'idle' || host.state.appState.isCompacting) {
      return;
    }
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
    if (host.state.editorReplacementMounted) return;
    this.resumedSessions.add(session.id);
    this.idlePrompted = true;
    await this.showDialog('resume', decision, undefined);
  }

  maybeInterceptOnSubmit(
    text: string,
    extraction?: ExtractionResult,
    inlineSkillActivations?: readonly InlineSkillActivation[],
  ): boolean {
    const { host } = this;
    if (host.session === undefined) return false;
    if (this.releasingStashed) return false;
    if (this.idlePrompted || this.lastActivityAt === undefined) return false;
    if (host.state.appState.streamingPhase !== 'idle' || host.state.appState.isCompacting) {
      return false;
    }
    if (host.state.appState.cacheExpiryHint === false) return false;
    if (this.upstreamModelId() === undefined) return false;
    if (Date.now() - this.lastActivityAt < 60_000) return false;
    const stash: StashedSubmit = { text, extraction, sessionId: host.session.id, inlineSkillActivations };
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
      void this.showDialog('idle', decision, stash);
      return true;
    }
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

  private async interceptAfterFetch(stash: StashedSubmit, sessionId: string): Promise<void> {
    const { host } = this;
    if (this.idlePrompted) {
      if (this.lastDialogRestored) {
        this.restoreStashedInput(stash);
      } else {
        await this.releaseStashed(stash);
      }
      return;
    }
    const config = await this.resolveConfig();
    if (host.session?.id !== sessionId) {
      this.restoreStashedInput(stash);
      return;
    }
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
    await this.releaseStashed(stash);
  }

  private async releaseStashed(stash: StashedSubmit): Promise<void> {
    this.releasingStashed = true;
    try {
      await this.releaseToSendPath(stash);
    } finally {
      this.releasingStashed = false;
    }
  }

  private async releaseToSendPath(stash: StashedSubmit): Promise<void> {
    let extraction = stash.extraction;
    if (extraction !== undefined && this.host.state.appState.sessionId !== stash.sessionId) {
      const session = this.host.session;
      if (session === undefined) {
        this.restoreStashedInput(stash);
        return;
      }
      try {
        extraction = await makeSessionExtractionResendable(extraction, session);
      } catch (error) {
        this.host.showError(`Failed to prepare media attachment: ${formatErrorMessage(error)}. Paste the image again before retrying.`);
        this.restoreStashedInput(stash);
        return;
      }
      if (this.host.session !== session) {
        this.restoreStashedInput(stash);
        return;
      }
    }
    if (stash.inlineSkillActivations !== undefined && stash.inlineSkillActivations.length > 0) {
      await this.host.sendInlineSkillUserInput(stash.text, stash.inlineSkillActivations, extraction);
      return;
    }
    await this.host.sendNormalUserInput(stash.text, extraction);
  }

  private restoreStashedInput(stash: StashedSubmit | undefined): void {
    if (stash === undefined) return;
    const offset = this.restoredTexts.length === 0 ? 0 : this.restoredTexts.join('\n').length + 1;
    if (stash.inlineSkillActivations !== undefined) {
      this.restoredActivations.push(...rebaseInlineSkillActivations(stash.inlineSkillActivations, offset));
    }
    this.restoredTexts.push(stash.text);
    this.host.restoreInputText(
      this.restoredTexts.join('\n'),
      this.restoredActivations.length === 0 ? undefined : this.restoredActivations,
    );
    this.host.recallStashedMedia(stash.extraction);
  }

  private upstreamModelId(): string | undefined {
    const { model, availableModels, availableProviders } = this.host.state.appState;
    const alias = availableModels[model];
    if (alias === undefined) return undefined;
    if (availableProviders[alias.provider]?.oauth === undefined) return undefined;
    return alias.model;
  }

  private async resolveConfig() {
    let accessToken: string | undefined;
    try {
      accessToken = await this.host.harness.auth.getCachedAccessToken();
    } catch {
      return undefined;
    }
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
      this.restoreStashedInput(stashed);
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
          restoreInput();
          return;
        }
        break;
      }
      case 'continue':
        break;
    }
    this.lastDialogRestored = false;
    if (stashed !== undefined) await this.releaseStashed(stashed);
  }

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
