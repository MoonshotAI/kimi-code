/**
 * Prompt Optimizer — Pruner.
 *
 * Systematically removes each section from system.md,
 * runs the relevant benchmark cases, and reports impact.
 */

import type { BenchmarkCase, BenchmarkResult, PromptSection, PruneReport, PruneResult } from '../types';
import { generateBaselineVariant, generatePruneVariant } from '../prompt-parser';
import { runSuite, aggregateResults, type LLMCaller, type RunnerConfig } from '../benchmark/runner';
import { getCasesBySection } from '../benchmark/cases';

export interface PrunerConfig {
  /** Minimum score delta to consider "significant" */
  significanceThreshold: number;
  /** Model and API config */
  runner: RunnerConfig;
  /** LLM caller */
  caller: LLMCaller;
}

const DEFAULT_PRUNER_CONFIG: Partial<PrunerConfig> = {
  significanceThreshold: 0.1,
};

/**
 * Run the pruner: for each section, remove it and measure impact.
 */
export async function runPruner(
  sections: PromptSection[],
  allCases: BenchmarkCase[],
  config: PrunerConfig,
): Promise<PruneReport> {
  const threshold = config.significanceThreshold ?? DEFAULT_PRUNER_CONFIG.significanceThreshold!;

  // 1. Run baseline
  const baselineVariant = generateBaselineVariant(sections);
  const baselineResults = await runSuite(allCases, baselineVariant, config.caller, config.runner);
  const baselineAgg = aggregateResults(baselineResults);

  // 2. For each section, run with that section removed
  const pruneResults: PruneResult[] = [];

  for (const section of sections) {
    // Skip preamble (identity text — always needed)
    if (section.heading === '(preamble)') {
      pruneResults.push({
        section: section.heading,
        tokens: section.tokens,
        impact: 'HIGH',
        verdict: 'KEEP',
        reason: 'Identity preamble — always required',
        scoreDeltas: {},
      });
      continue;
    }

    // Find cases relevant to this section
    const relevantCases = getCasesBySection(section.heading);
    const casesToRun = relevantCases.length > 0 ? relevantCases : allCases.slice(0, 5);

    // Run pruned variant against the same case set
    const prunedVariant = generatePruneVariant(sections, section.heading);
    const prunedResults = await runSuite(casesToRun, prunedVariant, config.caller, config.runner);
    const prunedAgg = aggregateResults(prunedResults);

    // Compare against baseline scores on the SAME case subset (not all cases)
    const relevantCaseIds = new Set(casesToRun.map((c) => c.id));
    const relevantBaselineResults = baselineResults.filter((r) => relevantCaseIds.has(r.taskId));
    const relevantBaselineAgg = aggregateResults(relevantBaselineResults);

    const complianceDelta = prunedAgg.avgRuleCompliance - relevantBaselineAgg.avgRuleCompliance;
    const toolDelta = prunedAgg.avgToolAccuracy - relevantBaselineAgg.avgToolAccuracy;
    const passRateDelta = prunedAgg.passRate - relevantBaselineAgg.passRate;

    const maxNegativeDelta = Math.min(complianceDelta, toolDelta, passRateDelta);

    let impact: PruneResult['impact'];
    let verdict: PruneResult['verdict'];
    let reason: string;

    if (maxNegativeDelta >= -0.02) {
      impact = 'NONE';
      verdict = 'PRUNE';
      reason = 'No measurable impact when removed';
    } else if (maxNegativeDelta >= -threshold) {
      impact = 'LOW';
      verdict = 'PRUNE';
      reason = `Minor impact (${(maxNegativeDelta * 100).toFixed(1)}% delta)`;
    } else if (maxNegativeDelta >= -threshold * 2) {
      impact = 'MEDIUM';
      verdict = 'KEEP';
      reason = `Moderate impact (${(maxNegativeDelta * 100).toFixed(1)}% delta)`;
    } else {
      impact = 'HIGH';
      verdict = 'KEEP';
      reason = `Critical section (${(maxNegativeDelta * 100).toFixed(1)}% delta)`;
    }

    pruneResults.push({
      section: section.heading,
      tokens: section.tokens,
      impact,
      verdict,
      reason,
      scoreDeltas: {
        ruleCompliance: complianceDelta,
        toolAccuracy: toolDelta,
      },
    });
  }

  const totalTokens = sections.reduce((sum, s) => sum + s.tokens, 0);
  const prunableTokens = pruneResults
    .filter((r) => r.verdict === 'PRUNE')
    .reduce((sum, r) => sum + r.tokens, 0);

  return {
    promptVersion: 'current',
    model: config.runner.model,
    totalTokens,
    prunableTokens,
    sections: pruneResults,
  };
}

/**
 * Format prune report as a readable table.
 */
export function formatPruneReport(report: PruneReport): string {
  const lines: string[] = [
    'Prompt Health Report',
    '═'.repeat(80),
    `Model: ${report.model} | Total: ${report.totalTokens} tokens | Prunable: ${report.prunableTokens} tokens (${((report.prunableTokens / report.totalTokens) * 100).toFixed(1)}%)`,
    '─'.repeat(80),
    padRight('Section', 35) + padRight('Tokens', 8) + padRight('Impact', 10) + padRight('Verdict', 8) + 'Reason',
    '─'.repeat(80),
  ];

  for (const r of report.sections) {
    lines.push(
      padRight(r.section.slice(0, 33), 35) +
      padRight(String(r.tokens), 8) +
      padRight(r.impact, 10) +
      padRight(r.verdict, 8) +
      r.reason,
    );
  }

  lines.push('─'.repeat(80));
  return lines.join('\n');
}

function padRight(str: string, len: number): string {
  return str.length >= len ? str + ' ' : str + ' '.repeat(len - str.length);
}
