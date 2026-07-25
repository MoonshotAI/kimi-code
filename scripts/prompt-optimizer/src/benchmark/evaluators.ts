/**
 * Prompt Optimizer — Benchmark evaluators.
 *
 * Pure functions that score model output against defined criteria.
 */

import type { Evaluator } from '../types';

export interface EvalContext {
  output: string;
  toolCalls: ToolCall[];
  tokenUsage: { input: number; output: number };
}

export interface ToolCall {
  name: string;
  input: string;
}

/**
 * Run a single evaluator against the model output. Returns 0-1 score.
 */
export function runEvaluator(evaluator: Evaluator, ctx: EvalContext): number {
  switch (evaluator.type) {
    case 'contains':
      return evalContains(ctx.output, evaluator.params);
    case 'not-contains':
      return evalNotContains(ctx.output, evaluator.params);
    case 'tool-called':
      return evalToolCalled(ctx.toolCalls, evaluator.params);
    case 'tool-not-called':
      return evalToolNotCalled(ctx.toolCalls, evaluator.params);
    case 'output-length':
      return evalOutputLength(ctx.output, evaluator.params);
    case 'regex-match':
      return evalRegexMatch(ctx.output, evaluator.params);
    case 'regex-not-match':
      return evalRegexNotMatch(ctx.output, evaluator.params);
    case 'json-schema':
      return evalJsonSchema(ctx.output, evaluator.params);
    case 'llm-judge':
      // LLM judge is async and handled separately
      return 0;
    default:
      return 0;
  }
}

/**
 * Run all evaluators for a case and aggregate scores.
 */
export function runAllEvaluators(evaluators: Evaluator[], ctx: EvalContext): {
  ruleCompliance: number;
  violations: string[];
} {
  const results: { name: string; score: number }[] = [];
  for (const evaluator of evaluators) {
    results.push({ name: evaluator.name, score: runEvaluator(evaluator, ctx) });
  }

  const violations = results.filter((r) => r.score < 1.0).map((r) => r.name);
  const ruleCompliance =
    results.length === 0 ? 1 : results.reduce((sum, r) => sum + r.score, 0) / results.length;

  return { ruleCompliance, violations };
}

// ─── Individual evaluator implementations ───────────────────────────────────

function evalContains(output: string, params: Record<string, unknown>): number {
  const target = String(params['text'] ?? '');
  const caseSensitive = params['caseSensitive'] !== false;
  if (!caseSensitive) {
    return output.toLowerCase().includes(target.toLowerCase()) ? 1 : 0;
  }
  return output.includes(target) ? 1 : 0;
}

function evalNotContains(output: string, params: Record<string, unknown>): number {
  const target = String(params['text'] ?? '');
  const caseSensitive = params['caseSensitive'] !== false;
  if (!caseSensitive) {
    return output.toLowerCase().includes(target.toLowerCase()) ? 0 : 1;
  }
  return output.includes(target) ? 0 : 1;
}

function evalToolCalled(toolCalls: ToolCall[], params: Record<string, unknown>): number {
  const toolName = String(params['tool'] ?? '');
  return toolCalls.some((tc) => tc.name === toolName) ? 1 : 0;
}

function evalToolNotCalled(toolCalls: ToolCall[], params: Record<string, unknown>): number {
  const toolName = String(params['tool'] ?? '');
  return toolCalls.some((tc) => tc.name === toolName) ? 0 : 1;
}

function evalOutputLength(output: string, params: Record<string, unknown>): number {
  const lines = output.split('\n').filter((l) => l.trim().length > 0);
  const maxLines = Number(params['maxLines'] ?? Infinity);
  const minLines = Number(params['minLines'] ?? 0);

  if (lines.length > maxLines) {
    // Graceful degradation: partial score for being close
    return Math.max(0, 1 - (lines.length - maxLines) / maxLines);
  }
  if (lines.length < minLines) {
    return Math.max(0, lines.length / minLines);
  }
  return 1;
}

function evalRegexMatch(output: string, params: Record<string, unknown>): number {
  const pattern = String(params['pattern'] ?? '');
  const flags = String(params['flags'] ?? '');
  try {
    const regex = new RegExp(pattern, flags);
    return regex.test(output) ? 1 : 0;
  } catch {
    return 0;
  }
}

function evalRegexNotMatch(output: string, params: Record<string, unknown>): number {
  const pattern = String(params['pattern'] ?? '');
  const flags = String(params['flags'] ?? '');
  try {
    const regex = new RegExp(pattern, flags);
    return regex.test(output) ? 0 : 1;
  } catch {
    return 1;
  }
}

function evalJsonSchema(output: string, _params: Record<string, unknown>): number {
  try {
    JSON.parse(output);
    return 1;
  } catch {
    return 0;
  }
}
