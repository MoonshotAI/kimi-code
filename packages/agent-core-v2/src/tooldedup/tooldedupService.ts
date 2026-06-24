/**
 * `tooldedup` domain (L4) — `IToolDedupService` (Turn scope) implementation.
 *
 * Tracks tool calls within the current step to detect same-step duplicates,
 * and a cross-step streak counter for repeated identical calls.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ITelemetryService } from '#/telemetry/telemetry';
import { ITurnContext } from '#/turn/turn';

import { IToolDedupService } from './tooldedup';

function fingerprint(args: unknown): string {
  return JSON.stringify(args);
}

export class ToolDedupService extends Disposable implements IToolDedupService {
  declare readonly _serviceBrand: undefined;
  private readonly seenThisStep = new Set<string>();
  private lastFingerprint: string | undefined;
  private streak = 0;

  constructor(
    @ITelemetryService _telemetry: ITelemetryService,
    @ITurnContext _turnContext: ITurnContext,
  ) {
    super();
  }

  checkSameStep(toolCallId: string, args: unknown): boolean {
    const key = `${toolCallId}:${fingerprint(args)}`;
    if (this.seenThisStep.has(key)) return true;
    this.seenThisStep.add(key);
    return false;
  }

  finalize(toolCallId: string): void {
    const fp = toolCallId;
    if (fp === this.lastFingerprint) {
      this.streak += 1;
    } else {
      this.lastFingerprint = fp;
      this.streak = 1;
    }
  }

  get currentStreak(): number {
    return this.streak;
  }
}

registerScopedService(LifecycleScope.Turn, IToolDedupService, ToolDedupService, InstantiationType.Delayed, 'tooldedup');
