/**
 * `microCompaction` domain (L4) - `IAgentMicroCompactionService` implementation.
 *
 * Tracks cache-miss compaction cutoffs over `contextMemory` in the wire
 * `MicroCompactionModel` (`{ cutoff }`): reads it through `wire.getModel`,
 * writes it through `wire.dispatch(microCompactionApply(...))` (both advances
 * from `detect` and the `cutoff: 0` resets recorded on the live full-compaction
 * / context-clear paths), so `wire.replay` rebuilds the cutoff — including the
 * resume-time reset — without a `full_compaction.complete` resumer. Sizes
 * context via `contextSize`, resolves model capacity through `profile`, gates
 * behavior through `flag`, reads tuning through `config`, emits telemetry, and
 * participates in `loop` hooks. The effective cutoff is clamped to the current
 * context length at read time (an undo that shortens the context cannot leave a
 * dangling cutoff), so the delete-clamp needs no persisted record. Bound at
 * Agent scope.
 */

import type { ContentPart } from '#/app/llmProtocol';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import {
  Disposable,
} from "#/_base/di";
import {
  estimateTokensForContentParts,
  estimateTokensForMessages,
} from "#/_base/utils/tokens";
import type { TelemetryProperties } from '#/app/telemetry';
import { IConfigService } from '#/app/config';
import { IAgentContextMemoryService } from '#/agent/contextMemory';
import { IAgentContextSizeService } from '#/agent/contextSize';
import { IFlagService } from '#/app/flag';
import { IAgentLoopService } from '#/agent/loop';
import { IAgentProfileService } from '#/agent/profile';
import { ITelemetryService } from '#/app/telemetry';
import type { ContextMessage } from '#/agent/contextMemory';
import { IAgentWireService, type IWireService } from '#/wire';
import {
  IAgentMicroCompactionService,
  type MicroCompactionConfig,
  type MicroCompactionEffect,
} from './microCompaction';
import { MicroCompactionModel, microCompactionApply } from './microCompactionOps';
import {
  MICRO_COMPACTION_SECTION,
  type MicroCompactionConfigPatch,
} from './configSection';

const DEFAULT_CONFIG: MicroCompactionConfig = {
  keepRecentMessages: 20,
  minContentTokens: 100,
  cacheMissedThresholdMs: 60 * 60 * 1000,
  truncatedMarker: '[Old tool result content cleared]',
  minContextUsageRatio: 0.5,
};

export class AgentMicroCompactionService
  extends Disposable
  implements IAgentMicroCompactionService
{
  declare readonly _serviceBrand: undefined;
  private microConfig: MicroCompactionConfig;
  private _lastAssistantAt: number | null = null;

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentContextSizeService private readonly contextSize: IAgentContextSizeService,
    @IAgentWireService private readonly wire: IWireService,
    @IFlagService private readonly flags: IFlagService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentLoopService loop: IAgentLoopService,
    @IConfigService private readonly config: IConfigService,
  ) {
    super();
    this.microConfig = this.readConfig();
    this._register(
      this.config.onDidSectionChange((event) => {
        if (event.domain === MICRO_COMPACTION_SECTION) {
          this.microConfig = this.readConfig();
        }
      }),
    );
    this._register(
      loop.hooks.beforeStep.register(
        'micro-compaction',
        async (_ctx, next) => {
          this.detect();
          await next();
        },
      ),
    );
    this._register(
      this.context.hooks.onSpliced.register('micro-compaction', async (ctx, next) => {
        this.observeSplice(ctx);
        await next();
      }),
    );
  }

  get lastAssistantAt(): number | null {
    return this._lastAssistantAt;
  }

  private get cutoff(): number {
    const cutoff = this.wire.getModel(MicroCompactionModel).cutoff;
    const length = (this.context.get() as readonly ContextMessage[]).length;
    return cutoff <= length ? cutoff : length;
  }

  private reset(maxCutoff = 0): void {
    const next = Math.min(this.cutoff, maxCutoff);
    if (next === this.cutoff) return;
    this.wire.dispatch(microCompactionApply({ cutoff: next }));
  }

  private apply(cutoff: number): void {
    this.wire.dispatch(microCompactionApply({ cutoff }));
  }

  private detect(): void {
    if (!this.flags.enabled('micro_compaction')) return;

    const lastAssistantAt = this._lastAssistantAt;
    if (lastAssistantAt === null) return;

    const cacheAgeMs = Date.now() - lastAssistantAt;
    if (cacheAgeMs < this.microConfig.cacheMissedThresholdMs) return;

    const history = this.context.get();
    if (this.contextSizeRatio() < this.microConfig.minContextUsageRatio) return;

    const previousCutoff = this.cutoff;
    const nextCutoff = Math.max(0, history.length - this.microConfig.keepRecentMessages);
    this.apply(nextCutoff);
    if (previousCutoff === nextCutoff) return;

    const effect = this.measureEffect(history, nextCutoff);
    const previousEffect = this.measureEffect(history, previousCutoff);
    const rawContextTokens = estimateTokensForMessages(history);
    const properties: TelemetryProperties = {
      keep_recent_messages: this.microConfig.keepRecentMessages,
      min_content_tokens: this.microConfig.minContentTokens,
      cache_missed_threshold_ms: this.microConfig.cacheMissedThresholdMs,
      truncated_marker: this.microConfig.truncatedMarker,
      min_context_usage_ratio: this.microConfig.minContextUsageRatio,
      truncated_tool_result_count: effect.truncatedToolResultCount,
      truncated_tool_result_tokens_before: effect.truncatedToolResultTokensBefore,
      truncated_tool_result_tokens_after: effect.truncatedToolResultTokensAfter,
      tokens_before:
        rawContextTokens -
        previousEffect.truncatedToolResultTokensBefore +
        previousEffect.truncatedToolResultTokensAfter,
      tokens_after:
        rawContextTokens -
        effect.truncatedToolResultTokensBefore +
        effect.truncatedToolResultTokensAfter,
      previous_cutoff: previousCutoff,
      cutoff: nextCutoff,
      message_count: history.length,
      cache_age_ms: cacheAgeMs,
      thinking_level: this.profile.data().thinkingLevel,
    };
    this.telemetry.track('micro_compaction_finished', properties);
  }

  compact(messages: readonly ContextMessage[]): readonly ContextMessage[] {
    if (!this.flags.enabled('micro_compaction')) return messages;

    const result: ContextMessage[] = [];
    let index = 0;
    for (const message of messages) {
      if (this.shouldTruncate(message, index)) {
        result.push({
          ...message,
          content: [
            { type: 'text', text: this.microConfig.truncatedMarker } satisfies ContentPart,
          ],
        });
      } else {
        result.push(message);
      }
      index++;
    }
    return result;
  }

  private observeSplice(context: {
    readonly deleteCount: number;
    readonly messages: readonly ContextMessage[];
  }): void {
    if (this.context.get().length === 0) {
      this._lastAssistantAt = null;
      this.reset();
      return;
    }

    if (context.messages.some(isCompactionSummary)) {
      this.reset();
    }

    if (context.messages.some(isAssistantCacheAnchor)) {
      this._lastAssistantAt = Date.now();
    }
  }

  private shouldTruncate(message: ContextMessage, index: number): boolean {
    return (
      index < this.cutoff &&
      message.role === 'tool' &&
      message.toolCallId !== undefined &&
      estimateTokensForContentParts(message.content) >= this.microConfig.minContentTokens
    );
  }

  private readConfig(): MicroCompactionConfig {
    const config = this.config.get<MicroCompactionConfigPatch | undefined>(MICRO_COMPACTION_SECTION);
    return { ...DEFAULT_CONFIG, ...config };
  }

  private contextSizeRatio(): number {
    const maxContextTokens = this.profile.getModelCapabilities().max_context_tokens;
    if (maxContextTokens === undefined || maxContextTokens <= 0) return 1;
    return this.contextSize.getStatus().contextTokensWithPending / maxContextTokens;
  }

  private measureEffect(
    messages: readonly ContextMessage[],
    cutoff: number,
  ): MicroCompactionEffect {
    let markerTokenCount: number | undefined;
    let truncatedToolResultCount = 0;
    let truncatedToolResultTokensBefore = 0;
    let truncatedToolResultTokensAfter = 0;
    for (let i = 0; i < messages.length && i < cutoff; i++) {
      const message = messages[i];
      if (message === undefined || message.role !== 'tool' || message.toolCallId === undefined) {
        continue;
      }

      const contentTokens = estimateTokensForContentParts(message.content);
      if (contentTokens < this.microConfig.minContentTokens) continue;

      markerTokenCount ??= estimateTokensForContentParts([
        { type: 'text', text: this.microConfig.truncatedMarker },
      ]);
      truncatedToolResultCount += 1;
      truncatedToolResultTokensBefore += contentTokens;
      truncatedToolResultTokensAfter += markerTokenCount;
    }
    return {
      truncatedToolResultCount,
      truncatedToolResultTokensBefore,
      truncatedToolResultTokensAfter,
    };
  }
}

function isCompactionSummary(message: ContextMessage): boolean {
  return message.origin?.kind === 'compaction_summary';
}

function isAssistantCacheAnchor(message: ContextMessage): boolean {
  return message.role === 'assistant' && !isCompactionSummary(message);
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentMicroCompactionService,
  AgentMicroCompactionService,
  InstantiationType.Eager,
  'microCompaction',
);
