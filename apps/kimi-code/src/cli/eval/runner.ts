import type { Event, KimiHarness, Session } from '@moonshot-ai/kimi-code-sdk';

import type {
  EvalCostRates,
  EvalMetric,
  EvalPrompt,
  EvalRunResult,
  EvalRunSpec,
  EvalSpec,
  EvalSuiteResult,
  EvalToolCall,
  EvalVariation,
} from './types';

export interface EvalRunnerDeps {
  readonly harness: KimiHarness;
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeout: (id: ReturnType<typeof setTimeout>) => void;
  readonly stdout?: { write(chunk: string): void } | undefined;
}

export async function runEvalSuite(deps: EvalRunnerDeps, spec: EvalSpec): Promise<EvalSuiteResult> {
  const runs: EvalRunResult[] = [];
  const startedAt = deps.now();
  const suiteDeadline = spec.suiteTimeout !== undefined ? startedAt + spec.suiteTimeout * 1000 : undefined;

  const matrix = buildRunMatrix(spec);

  for (const runSpec of matrix) {
    if (suiteDeadline !== undefined && deps.now() > suiteDeadline) {
      runs.push(createTimeoutResult(runSpec, 'Suite timeout reached'));
      continue;
    }
    const run = await executeRun(deps, spec, runSpec, suiteDeadline);
    runs.push(run);
    deps.stdout?.write(`[${run.status}] ${run.runId} ${run.promptId}/${run.model}/${run.variationId}\n`);
  }

  return buildSuiteResult(spec, runs, startedAt, deps.now());
}

function buildRunMatrix(spec: EvalSpec): EvalRunSpec[] {
  const matrix: EvalRunSpec[] = [];
  for (const prompt of spec.prompts) {
    for (const model of spec.models) {
      for (const variation of spec.variations) {
        for (let sampleIndex = 0; sampleIndex < spec.samples; sampleIndex++) {
          matrix.push({
            runId: `r${matrix.length}`,
            promptId: prompt.id,
            model,
            variationId: variation.id,
            sampleIndex,
          });
        }
      }
    }
  }
  return matrix;
}

async function executeRun(
  deps: EvalRunnerDeps,
  spec: EvalSpec,
  runSpec: EvalRunSpec,
  suiteDeadline: number | undefined,
): Promise<EvalRunResult> {
  const prompt = spec.prompts.find((p) => p.id === runSpec.promptId);
  const variation = spec.variations.find((v) => v.id === runSpec.variationId);
  if (prompt === undefined || variation === undefined) {
    return createErrorResult(runSpec, 'Internal error: prompt or variation not found');
  }

  let promptText: string;
  try {
    promptText = await resolvePromptText(prompt);
  } catch (error) {
    return createErrorResult(runSpec, `Failed to load prompt: ${errorMessage(error)}`);
  }

  const perRunTimeoutMs = spec.timeout * 1000;
  const remainingMs =
    suiteDeadline !== undefined ? Math.min(perRunTimeoutMs, suiteDeadline - deps.now()) : perRunTimeoutMs;
  if (remainingMs <= 0) {
    return createTimeoutResult(runSpec, 'Suite timeout reached before run started');
  }

  const session = await deps.harness.createSession({
    workDir: process.cwd(),
    model: runSpec.model,
    permission: 'auto',
  });

  try {
    await configureSession(session, runSpec.model, variation);
    return await runWithTimeout(deps, spec, session, runSpec, promptText, remainingMs);
  } finally {
    await session.close?.().catch(() => {});
  }
}

async function resolvePromptText(prompt: EvalPrompt): Promise<string> {
  if (prompt.text !== undefined) return prompt.text;
  if (prompt.file !== undefined) {
    const { readFile } = await import('node:fs/promises');
    return readFile(prompt.file, 'utf-8');
  }
  throw new Error('Prompt must have either text or file');
}

async function configureSession(
  session: Session,
  model: string,
  variation: EvalVariation,
): Promise<void> {
  await session.setModel(model);
  if (variation.generationKwargs !== undefined && Object.keys(variation.generationKwargs).length > 0) {
    await session.setGenerationKwargs(variation.generationKwargs);
  }
  if (variation.systemPrompt !== undefined && variation.systemPrompt.length > 0) {
    await session.setSystemPrompt(variation.systemPrompt);
  }
}

async function runWithTimeout(
  deps: EvalRunnerDeps,
  spec: EvalSpec,
  session: Session,
  runSpec: EvalRunSpec,
  promptText: string,
  timeoutMs: number,
): Promise<EvalRunResult> {
  return new Promise<EvalRunResult>((resolve) => {
    const timeoutId = deps.setTimeout(() => {
      cleanup();
      resolve(createTimeoutResult(runSpec, `Run exceeded ${spec.timeout}s timeout`));
    }, timeoutMs);

    const cleanup = (): void => {
      deps.clearTimeout(timeoutId);
      unsubscribe?.();
    };

    let unsubscribe: (() => void) | undefined;
    const collector = createEventCollector(runSpec, session.id, () => {
      cleanup();
      const result = collector.toResult();
      computeMetrics(result, spec.evaluation?.metrics ?? []);
      result.estimatedCostUsd = estimateCost(result, spec.cost);
      resolve(result);
    });

    unsubscribe = session.onEvent((event) => {
      collector.handleEvent(event);
    });

    if (!spec.executeTools) {
      session.setApprovalHandler(() => ({ decision: 'rejected', reason: 'Eval executeTools is disabled' }));
    } else {
      session.setApprovalHandler(() => ({ decision: 'approved' }));
    }
    session.setQuestionHandler(() => null);

    session.prompt(promptText).catch((error: unknown) => {
      cleanup();
      resolve(createErrorResult(runSpec, errorMessage(error)));
    });
  });
}

function createEventCollector(
  runSpec: EvalRunSpec,
  sessionId: string,
  onCompleted: () => void,
): {
  handleEvent: (event: Event) => void;
  toResult: () => EvalRunResult;
} {
  const startedAt = new Date().toISOString();
  const startTime = Date.now();
  let firstTokenAt: string | undefined;
  let endedAt: string | undefined;
  let assistantText = '';
  let thinkingText = '';
  let finishReason: 'completed' | 'error' | 'timeout' = 'completed';
  let error: string | undefined;
  const toolCalls = new Map<string, EvalToolCall>();
  let usage: EvalRunResult['usage'];

  const handleEvent = (event: Event): void => {
    if ('agentId' in event && event.agentId !== 'main') return;

    // eslint-disable-next-line typescript-eslint/switch-exhaustiveness-check
    switch (event.type) {
      case 'assistant.delta':
        firstTokenAt ??= new Date().toISOString();
        assistantText += event.delta;
        return;
      case 'thinking.delta':
        thinkingText += event.delta;
        return;
      case 'tool.call.started': {
        toolCalls.set(event.toolCallId, {
          id: event.toolCallId,
          name: event.name,
          args: event.args,
        });
        return;
      }
      case 'tool.call.delta': {
        const existing = toolCalls.get(event.toolCallId);
        if (existing !== undefined && event.argumentsPart !== undefined) {
          existing.args = mergeArguments(existing.args, event.argumentsPart);
        }
        return;
      }
      case 'tool.result': {
        const existing = toolCalls.get(event.toolCallId);
        if (existing !== undefined) {
          existing.result = event.output;
        }
        return;
      }
      case 'agent.status.updated': {
        if (event.usage?.total !== undefined) {
          usage = {
            inputTokens: event.usage.total.inputOther + (event.usage.total.inputCacheRead ?? 0),
            outputTokens: event.usage.total.output,
            cachedInputTokens: event.usage.total.inputCacheRead,
          };
        }
        return;
      }
      case 'error':
        finishReason = 'error';
        error = `${event.code}: ${event.message}`;
        endedAt = new Date().toISOString();
        onCompleted();
        return;
      case 'turn.ended':
        endedAt = new Date().toISOString();
        if (event.reason !== 'completed') {
          finishReason = 'error';
          error = event.error !== undefined ? `${event.error.code}: ${event.error.message}` : event.reason;
        }
        onCompleted();
        return;
      default:
        return;
    }
  };

  const toResult = (): EvalRunResult => {
    const endedTime = endedAt !== undefined ? new Date(endedAt).getTime() : Date.now();
    return {
      ...runSpec,
      sessionId,
      status: finishReason,
      error,
      assistantText,
      thinkingText,
      toolCalls: Array.from(toolCalls.values()),
      timing: {
        startedAt,
        firstTokenAt,
        endedAt,
        durationMs: endedTime - startTime,
        timeToFirstTokenMs:
          firstTokenAt !== undefined ? new Date(firstTokenAt).getTime() - startTime : undefined,
      },
      usage,
    };
  };

  return { handleEvent, toResult };
}

function mergeArguments(current: unknown, delta: string): unknown {
  if (typeof current === 'string') {
    return current + delta;
  }
  if (current !== null && typeof current === 'object') {
    try {
      const parsed = JSON.parse(delta);
      if (typeof parsed === 'object' && parsed !== null) {
        return { ...current, ...parsed };
      }
    } catch {
      // Fall through to delta replacement.
    }
  }
  return delta;
}

function createErrorResult(runSpec: EvalRunSpec, message: string): EvalRunResult {
  return {
    ...runSpec,
    sessionId: '',
    status: 'error',
    error: message,
    assistantText: '',
    thinkingText: '',
    toolCalls: [],
    timing: {
      startedAt: new Date().toISOString(),
      durationMs: 0,
    },
  };
}

function createTimeoutResult(runSpec: EvalRunSpec, message: string): EvalRunResult {
  return {
    ...runSpec,
    sessionId: '',
    status: 'timeout',
    error: message,
    assistantText: '',
    thinkingText: '',
    toolCalls: [],
    timing: {
      startedAt: new Date().toISOString(),
      durationMs: 0,
    },
  };
}

function buildSuiteResult(
  spec: EvalSpec,
  runs: EvalRunResult[],
  startedAt: number,
  endedAt: number,
): EvalSuiteResult {
  const completed = runs.filter((r) => r.status === 'completed').length;
  const failed = runs.filter((r) => r.status === 'error').length;
  const timedOut = runs.filter((r) => r.status === 'timeout').length;
  const totalCost = runs.reduce((sum, r) => sum + (r.estimatedCostUsd ?? 0), 0);
  const ttftValues = runs
    .map((r) => r.timing.timeToFirstTokenMs)
    .filter((v): v is number => v !== undefined);
  const avgTtft = ttftValues.length > 0 ? ttftValues.reduce((a, b) => a + b, 0) / ttftValues.length : undefined;

  return {
    summary: {
      totalRuns: runs.length,
      completed,
      failed,
      timedOut,
      totalDurationMs: endedAt - startedAt,
      totalEstimatedCostUsd: totalCost > 0 ? totalCost : undefined,
      avgTimeToFirstTokenMs: avgTtft,
    },
    spec,
    runs,
  };
}

function estimateCost(run: EvalRunResult, costTable: Record<string, EvalCostRates> | undefined): number | undefined {
  if (costTable === undefined || run.usage === undefined) return undefined;
  const rates = costTable[run.model];
  if (rates === undefined) return undefined;
  const cachedInputTokens = run.usage.cachedInputTokens ?? 0;
  const nonCachedInputTokens = Math.max(0, run.usage.inputTokens - cachedInputTokens);
  const inputCost = (nonCachedInputTokens / 1000) * rates.inputPer1k;
  const outputCost = (run.usage.outputTokens / 1000) * rates.outputPer1k;
  const cachedInputCost =
    rates.cachedInputPer1k !== undefined
      ? (cachedInputTokens / 1000) * rates.cachedInputPer1k
      : 0;
  return inputCost + outputCost + cachedInputCost;
}

function computeMetrics(run: EvalRunResult, metrics: EvalMetric[]): void {
  if (metrics.length === 0) return;
  const result: Record<string, number | boolean> = {};
  for (const metric of metrics) {
    if (metric.type === 'substring') {
      result[metric.name] = metric.value !== undefined && run.assistantText.includes(metric.value);
    } else if (metric.type === 'length') {
      result[metric.name] = run.assistantText.length;
    }
  }
  run.metrics = result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
