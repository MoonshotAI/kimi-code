/**
 * Prompt Optimizer — A/B Test Framework.
 *
 * Runs multiple prompt variants against the same case set,
 * compares scores, and outputs a statistical report.
 */

import type { ABComparison, ABExperiment, ABResult, BenchmarkCase, BenchmarkResult, BenchmarkScores } from '../types';
import { runSuite, aggregateResults, type LLMCaller, type RunnerConfig } from '../benchmark/runner';
import { BENCHMARK_CASES } from '../benchmark/cases';

export interface ABConfig {
  runner: RunnerConfig;
  caller: LLMCaller;
}

/**
 * Execute an A/B experiment.
 */
export async function runABExperiment(
  experiment: ABExperiment,
  config: ABConfig,
): Promise<ABResult> {
  const cases = resolveCases(experiment.caseFilter);
  const variantResults = new Map<string, BenchmarkResult[]>();

  for (const variant of experiment.variants) {
    const allResults: BenchmarkResult[] = [];

    for (let rep = 0; rep < experiment.repetitions; rep++) {
      const results = await runSuite(cases, variant, config.caller, config.runner);
      allResults.push(...results);
    }

    variantResults.set(variant.name, allResults);
  }

  // Generate pairwise comparisons
  const comparison = generateComparisons(experiment, variantResults);

  return { experiment: experiment.name, variantResults, comparison };
}

/**
 * Generate pairwise comparisons between all variant pairs.
 */
function generateComparisons(
  experiment: ABExperiment,
  variantResults: Map<string, BenchmarkResult[]>,
): ABComparison[] {
  const comparisons: ABComparison[] = [];
  const variants = experiment.variants;
  const dimensions: (keyof BenchmarkScores)[] = [
    'ruleCompliance',
    'tokenEfficiency',
    'toolAccuracy',
    'outputConciseness',
  ];

  for (let i = 0; i < variants.length; i++) {
    for (let j = i + 1; j < variants.length; j++) {
      const nameA = variants[i]!.name;
      const nameB = variants[j]!.name;
      const resultsA = variantResults.get(nameA) ?? [];
      const resultsB = variantResults.get(nameB) ?? [];

      for (const dim of dimensions) {
        const scoresA = resultsA.map((r) => getScore(r.scores, dim));
        const scoresB = resultsB.map((r) => getScore(r.scores, dim));

        const meanA = mean(scoresA);
        const meanB = mean(scoresB);
        const delta = meanB - meanA;
        const deltaPercent = meanA !== 0 ? (delta / Math.abs(meanA)) * 100 : 0;

        // Simple significance test: bootstrap confidence interval
        const significant = isSignificant(scoresA, scoresB);

        let verdict: ABComparison['verdict'];
        if (!significant) verdict = 'tie';
        else if (dim === 'tokenEfficiency') verdict = delta < 0 ? 'B wins' : 'A wins'; // lower is better
        else verdict = delta > 0 ? 'B wins' : 'A wins';

        comparisons.push({
          variantA: nameA,
          variantB: nameB,
          dimension: dim,
          meanA,
          meanB,
          delta,
          deltaPercent,
          significant,
          verdict,
        });
      }
    }
  }

  return comparisons;
}

/**
 * Format A/B test results as a readable report.
 */
export function formatABReport(result: ABResult): string {
  const lines: string[] = [
    `A/B Test Report: ${result.experiment}`,
    '═'.repeat(80),
    '',
  ];

  // Summary per variant
  for (const [name, results] of result.variantResults) {
    const agg = aggregateResults(results);
    lines.push(
      `Variant: ${name}`,
      `  Pass rate: ${(agg.passRate * 100).toFixed(1)}%`,
      `  Rule compliance: ${(agg.avgRuleCompliance * 100).toFixed(1)}%`,
      `  Tool accuracy: ${(agg.avgToolAccuracy * 100).toFixed(1)}%`,
      `  Avg tokens: ${agg.avgTokenEfficiency.toFixed(0)}`,
      '',
    );
  }

  // Comparison table
  lines.push('─'.repeat(80));
  lines.push(
    padRight('Dimension', 20) +
    padRight('A mean', 10) +
    padRight('B mean', 10) +
    padRight('Delta', 10) +
    padRight('Sig?', 6) +
    'Verdict',
  );
  lines.push('─'.repeat(80));

  for (const c of result.comparison) {
    lines.push(
      padRight(c.dimension, 20) +
      padRight(formatNum(c.meanA), 10) +
      padRight(formatNum(c.meanB), 10) +
      padRight(`${c.deltaPercent >= 0 ? '+' : ''}${c.deltaPercent.toFixed(1)}%`, 10) +
      padRight(c.significant ? 'YES' : 'no', 6) +
      c.verdict,
    );
  }

  lines.push('─'.repeat(80));
  return lines.join('\n');
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function resolveCases(filter: string[] | 'all'): BenchmarkCase[] {
  if (filter === 'all') return BENCHMARK_CASES;
  return BENCHMARK_CASES.filter((c) => filter.includes(c.id) || filter.includes(c.category));
}

function getScore(scores: BenchmarkScores, dim: keyof BenchmarkScores): number {
  const val = scores[dim];
  if (typeof val === 'boolean') return val ? 1 : 0;
  return val;
}

function mean(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/**
 * Simple bootstrap significance test.
 * Returns true if 95% CI of (B - A) does not include 0.
 */
function isSignificant(scoresA: number[], scoresB: number[], iterations = 1000): boolean {
  if (scoresA.length < 3 || scoresB.length < 3) return false;

  const observedDiff = mean(scoresB) - mean(scoresA);
  if (Math.abs(observedDiff) < 0.01) return false;

  const combined = [...scoresA, ...scoresB];
  let moreExtreme = 0;

  for (let i = 0; i < iterations; i++) {
    // Shuffle and split
    const shuffled = [...combined].sort(() => Math.random() - 0.5);
    const permA = shuffled.slice(0, scoresA.length);
    const permB = shuffled.slice(scoresA.length);
    const permDiff = mean(permB) - mean(permA);

    if (Math.abs(permDiff) >= Math.abs(observedDiff)) {
      moreExtreme++;
    }
  }

  const pValue = moreExtreme / iterations;
  return pValue < 0.05;
}

function padRight(str: string, len: number): string {
  return str.length >= len ? str + ' ' : str + ' '.repeat(len - str.length);
}

function formatNum(n: number): string {
  return n < 10 ? n.toFixed(3) : n.toFixed(1);
}
