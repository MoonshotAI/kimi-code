import { runHook } from './runner';
import type {
  HookBlockDecision,
  HookDef,
  HookEngineOptions,
  HookEngineTriggerArgs,
  HookMatcherValue,
  HookResult,
} from './types';

const DEFAULT_HOOK_TIMEOUT_SECONDS = 30;

export class HookEngine {
  private readonly byEvent = new Map<string, HookDef[]>();
  private readonly pendingTriggers = new Set<Promise<HookResult[]>>();

  constructor(
    hooks: readonly HookDef[] = [],
    private readonly options: HookEngineOptions = {},
  ) {
    for (const hook of hooks) {
      const entries = this.byEvent.get(hook.event) ?? [];
      entries.push(hook);
      this.byEvent.set(hook.event, entries);
    }
  }

  get summary(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [event, hooks] of this.byEvent.entries()) {
      result[event] = hooks.length;
    }
    return result;
  }

  trigger(event: string, args: HookEngineTriggerArgs = {}): Promise<HookResult[]> {
    try {
      return this.triggerInner(event, args).catch((): HookResult[] => []);
    } catch {
      return Promise.resolve([]);
    }
  }

  async triggerBlock(
    event: string,
    args: HookEngineTriggerArgs = {},
  ): Promise<HookBlockDecision | undefined> {
    return blockDecision(event, await this.trigger(event, args));
  }

  fireAndForgetTrigger(
    event: string,
    args: HookEngineTriggerArgs = {},
  ): Promise<HookResult[]> {
    let promise: Promise<HookResult[]>;
    try {
      promise = this.trigger(event, args).catch((): HookResult[] => []);
    } catch {
      promise = Promise.resolve([]);
    }
    this.pendingTriggers.add(promise);
    void promise.finally(() => {
      this.pendingTriggers.delete(promise);
    });
    return promise;
  }

  private async triggerInner(
    event: string,
    args: HookEngineTriggerArgs,
  ): Promise<HookResult[]> {
    const matcherValue = matcherValueText(args.matcherValue);
    const inputData = toHookInputData({
      hookEventName: event,
      sessionId: this.options.sessionId ?? '',
      cwd: this.options.cwd ?? '',
      ...args.inputData,
    });
    const matched = this.matchingHooks(event, matcherValue);
    if (matched.length === 0) return [];

    this.emitTriggered(event, matcherValue, matched.length);
    const startedAt = Date.now();
    const results = await Promise.all(
      matched.map((hook) =>
        runHook(hook.command, inputData, {
          timeout: hook.timeout ?? DEFAULT_HOOK_TIMEOUT_SECONDS,
          cwd: hook.cwd ?? (this.options.cwd === '' ? undefined : this.options.cwd),
          env: hook.env,
          signal: args.signal,
        }),
      ),
    );
    const { action, reason } = aggregateResults(event, results);
    this.emitResolved(event, matcherValue, action, reason, Date.now() - startedAt);
    return results;
  }

  private matchingHooks(event: string, matcherValue: string): HookDef[] {
    const seen = new Set<string>();
    const matched: HookDef[] = [];

    for (const hook of this.byEvent.get(event) ?? []) {
      if (!matches(hook.matcher ?? '', matcherValue)) continue;
      const key = (hook.cwd ?? '') + '\0' + hook.command;
      if (seen.has(key)) continue;
      seen.add(key);
      matched.push(hook);
    }

    return matched;
  }

  private emitTriggered(event: string, target: string, count: number): void {
    try {
      this.options.onTriggered?.(event, target, count);
    } catch {}
  }

  private emitResolved(
    event: string,
    target: string,
    action: string,
    reason: string | undefined,
    durationMs: number,
  ): void {
    try {
      this.options.onResolved?.(event, target, action, reason, durationMs);
    } catch {}
  }
}

function matches(pattern: string, value: string): boolean {
  if (pattern.length === 0) return true;
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return false;
  }
}

function matcherValueText(value: HookMatcherValue | undefined): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  return value
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join(' ');
}

function aggregateResults(
  event: string,
  results: readonly HookResult[],
): {
  readonly action: 'allow' | 'block';
  readonly reason?: string;
} {
  const block = blockDecision(event, results);
  if (block !== undefined) {
    return { action: 'block', reason: block.reason };
  }
  return { action: 'allow' };
}

function blockDecision(
  event: string,
  results: readonly HookResult[],
): HookBlockDecision | undefined {
  const block = results.find((result) => result.action === 'block');
  if (block === undefined) return undefined;
  const reason = block.reason?.trim();
  return {
    block: true,
    reason: reason === undefined || reason.length === 0 ? `Blocked by ${event} hook` : reason,
  };
}

function toHookInputData(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    result[camelToSnake(key)] = value;
  }
  return result;
}

function camelToSnake(value: string): string {
  return value.replaceAll(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
}
