/**
 * Prompt Optimizer — Benchmark runner.
 *
 * Executes benchmark cases against a given prompt variant and model,
 * collects results, and outputs a structured report.
 */

import type { BenchmarkCase, BenchmarkResult, BenchmarkScores, PromptVariant } from '../types';
import { runAllEvaluators, type EvalContext } from './evaluators';
import { estimateTokens } from '../prompt-parser';

export interface RunnerConfig {
  model: string;
  apiBaseUrl: string;
  apiKey: string;
  concurrency: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

export interface ModelResponse {
  content: string;
  toolCalls: { name: string; input: string }[];
  usage: { input: number; output: number };
  latencyMs: number;
}

/**
 * LLM caller signature — includes optional tool definitions.
 */
export type LLMCaller = (
  systemPrompt: string,
  userMessages: string[],
  config: RunnerConfig,
  tools?: ToolDefinition[],
) => Promise<ModelResponse>;

/**
 * Dry-run caller that simulates model responses for testing the framework.
 */
export const dryRunCaller: LLMCaller = async (_system, userMessages, _config, _tools) => {
  return {
    content: `[DRY RUN] Would respond to: "${userMessages[0]?.slice(0, 50)}..."`,
    toolCalls: [],
    usage: { input: 100, output: 50 },
    latencyMs: 0,
  };
};

/**
 * Run a single benchmark case against a prompt variant.
 */
export async function runCase(
  benchCase: BenchmarkCase,
  variant: PromptVariant,
  caller: LLMCaller,
  config: RunnerConfig,
): Promise<BenchmarkResult> {
  const start = Date.now();

  const response = await caller(variant.content, benchCase.userMessages, config, benchCase.availableTools);

  const latencyMs = Date.now() - start;

  const evalCtx: EvalContext = {
    output: response.content,
    toolCalls: response.toolCalls,
    tokenUsage: response.usage,
  };

  const { ruleCompliance, violations } = runAllEvaluators(benchCase.evaluators, evalCtx);

  const scores: BenchmarkScores = {
    taskSuccess: violations.length === 0,
    ruleCompliance,
    tokenEfficiency: response.usage.input + response.usage.output,
    toolAccuracy: computeToolAccuracy(benchCase, response.toolCalls),
    outputConciseness: computeConciseness(response.content),
  };

  return {
    taskId: benchCase.id,
    promptVersion: variant.name,
    model: config.model,
    scores,
    violations,
    latencyMs,
    tokenUsage: response.usage,
    rawOutput: response.content,
  };
}

/**
 * Run all cases in a benchmark suite against a variant.
 */
export async function runSuite(
  cases: BenchmarkCase[],
  variant: PromptVariant,
  caller: LLMCaller,
  config: RunnerConfig,
): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];

  // Run with limited concurrency
  const queue = [...cases];
  const running: Promise<void>[] = [];

  while (queue.length > 0 || running.length > 0) {
    while (running.length < config.concurrency && queue.length > 0) {
      const benchCase = queue.shift()!;
      const promise = runCase(benchCase, variant, caller, config)
        .then((result) => { results.push(result); })
        .finally(() => { running.splice(running.indexOf(promise), 1); });
      running.push(promise);
    }
    if (running.length > 0) {
      await Promise.race(running);
    }
  }

  return results;
}

/**
 * Compute aggregate scores across a suite run.
 */
export function aggregateResults(results: BenchmarkResult[]): {
  totalCases: number;
  passRate: number;
  avgRuleCompliance: number;
  avgTokenEfficiency: number;
  avgToolAccuracy: number;
  avgConciseness: number;
  topViolations: { rule: string; count: number }[];
} {
  const totalCases = results.length;
  const passCount = results.filter((r) => r.scores.taskSuccess).length;

  const avgRuleCompliance = avg(results.map((r) => r.scores.ruleCompliance));
  const avgTokenEfficiency = avg(results.map((r) => r.scores.tokenEfficiency));
  const avgToolAccuracy = avg(results.map((r) => r.scores.toolAccuracy));
  const avgConciseness = avg(results.map((r) => r.scores.outputConciseness));

  // Count violations
  const violationCounts = new Map<string, number>();
  for (const r of results) {
    for (const v of r.violations) {
      violationCounts.set(v, (violationCounts.get(v) ?? 0) + 1);
    }
  }
  const topViolations = [...violationCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([rule, count]) => ({ rule, count }));

  return {
    totalCases,
    passRate: totalCases > 0 ? passCount / totalCases : 0,
    avgRuleCompliance,
    avgTokenEfficiency,
    avgToolAccuracy,
    avgConciseness,
    topViolations,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function computeToolAccuracy(
  benchCase: BenchmarkCase,
  toolCalls: { name: string; input: string }[],
): number {
  const toolEvals = benchCase.evaluators.filter(
    (e) => e.type === 'tool-called' || e.type === 'tool-not-called',
  );
  if (toolEvals.length === 0) return 1;

  let correct = 0;
  for (const ev of toolEvals) {
    const toolName = String(ev.params['tool'] ?? '');
    const called = toolCalls.some((tc) => tc.name === toolName);
    if (ev.type === 'tool-called' && called) correct++;
    if (ev.type === 'tool-not-called' && !called) correct++;
  }
  return correct / toolEvals.length;
}

function computeConciseness(output: string): number {
  const tokens = estimateTokens(output);
  // Score degrades for very long outputs
  if (tokens <= 100) return 1;
  if (tokens <= 300) return 0.8;
  if (tokens <= 600) return 0.6;
  if (tokens <= 1000) return 0.4;
  return 0.2;
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}
