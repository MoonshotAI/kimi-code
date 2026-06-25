import type { ContentPart } from '@moonshot-ai/kosong';

import {
  Disposable,
  registerSingleton,
  SyncDescriptor,
} from "#/_base/di";
import { FlagResolver, type ExperimentalFlagResolver } from '../../../flags';
import {
  estimateTokensForContentParts,
  estimateTokensForMessages,
} from "#/_base/utils/tokens";
import type { TelemetryProperties } from '../../../telemetry';
import { IContextMemory } from '../contextMemory/contextMemory';
import { IContextSizeService } from '../contextSize/contextSize';
import { IProfileService } from '../profile/profile';
import { ITelemetryService } from '../telemetry/telemetry';
import { ITurnRunner } from '../turnRunner/turnRunner';
import type { ContextMessage } from '../types';
import { IWireRecord } from '../wireRecord/wireRecord';
import {
  IMicroCompactionService,
  type MicroCompactionConfig,
  type MicroCompactionEffect,
  type MicroCompactionServiceOptions,
} from './microCompaction';

const DEFAULT_CONFIG: MicroCompactionConfig = {
  keepRecentMessages: 20,
  minContentTokens: 100,
  cacheMissedThresholdMs: 60 * 60 * 1000,
  truncatedMarker: '[Old tool result content cleared]',
  minContextUsageRatio: 0.5,
};

export class MicroCompactionService
  extends Disposable
  implements IMicroCompactionService
{
  private cutoff = 0;
  private readonly flags: ExperimentalFlagResolver;
  private readonly clock: () => number;
  private readonly config: MicroCompactionConfig;
  private _lastAssistantAt: number | null = null;

  constructor(
    private readonly options: MicroCompactionServiceOptions = {},
    @IContextMemory private readonly context: IContextMemory,
    @IContextSizeService private readonly contextSize: IContextSizeService,
    @IWireRecord private readonly wireRecord: IWireRecord,
    @IProfileService private readonly profile: IProfileService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @ITurnRunner turnRunner: ITurnRunner,
  ) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...options.config };
    this.flags = options.experimentalFlags ?? new FlagResolver();
    this.clock = options.now ?? Date.now;
    this._register(
      turnRunner.hooks.beforeStep.register(
        'micro-compaction',
        async (_ctx, next) => {
          this.detect();
          await next();
        },
        { after: 'turn-before-step-event' },
      ),
    );
    this._register(
      this.wireRecord.register('micro_compaction.apply', (record) => {
        this.apply(record.cutoff);
      }),
    );
    this._register(
      this.wireRecord.register('full_compaction.complete', () => {
        this.reset();
      }),
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

  private reset(maxCutoff = 0): void {
    this.cutoff = Math.min(this.cutoff, maxCutoff);
  }

  private apply(cutoff: number): void {
    this.wireRecord.append({
      type: 'micro_compaction.apply',
      cutoff,
    });
    this.cutoff = cutoff;
  }

  private detect(): void {
    if (!this.flags.enabled('micro_compaction')) return;

    const lastAssistantAt = this._lastAssistantAt;
    if (lastAssistantAt === null) return;

    const cacheAgeMs = this.clock() - lastAssistantAt;
    if (cacheAgeMs < this.config.cacheMissedThresholdMs) return;

    const history = this.context.getHistory();
    if (this.contextSizeRatio() < this.config.minContextUsageRatio) return;

    const previousCutoff = this.cutoff;
    const nextCutoff = Math.max(0, history.length - this.config.keepRecentMessages);
    this.apply(nextCutoff);
    if (previousCutoff === nextCutoff) return;

    const effect = this.measureEffect(history, nextCutoff);
    const previousEffect = this.measureEffect(history, previousCutoff);
    const rawContextTokens = estimateTokensForMessages(history);
    const properties: TelemetryProperties = {
      ...this.config,
      ...effect,
      tokensBefore:
        rawContextTokens -
        previousEffect.truncatedToolResultTokensBefore +
        previousEffect.truncatedToolResultTokensAfter,
      tokensAfter:
        rawContextTokens -
        effect.truncatedToolResultTokensBefore +
        effect.truncatedToolResultTokensAfter,
      previous_cutoff: previousCutoff,
      cutoff: nextCutoff,
      message_count: history.length,
      cache_age_ms: cacheAgeMs,
      thinkingLevel: this.profile.data().thinkingLevel,
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
            { type: 'text', text: this.config.truncatedMarker } satisfies ContentPart,
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
    if (this.context.getHistory().length === 0) {
      this._lastAssistantAt = null;
      this.reset();
      return;
    }

    if (context.messages.some(isCompactionSummary)) {
      this.reset();
    } else if (context.deleteCount > 0) {
      this.reset(this.context.getHistory().length);
    }

    if (context.messages.some(isAssistantCacheAnchor)) {
      this._lastAssistantAt = this.wireRecord.restoring?.time ?? this.clock();
    }
  }

  private shouldTruncate(message: ContextMessage, index: number): boolean {
    return (
      index < this.cutoff &&
      message.role === 'tool' &&
      message.toolCallId !== undefined &&
      estimateTokensForContentParts(message.content) >= this.config.minContentTokens
    );
  }

  private contextSizeRatio(): number {
    const maxContextTokens = this.options.maxContextTokens?.();
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
      if (contentTokens < this.config.minContentTokens) continue;

      markerTokenCount ??= estimateTokensForContentParts([
        { type: 'text', text: this.config.truncatedMarker },
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

registerSingleton(
  IMicroCompactionService,
  new SyncDescriptor(MicroCompactionService, [{}], false),
);
