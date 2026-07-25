/**
 * Prompt Optimizer — Report generator.
 *
 * Generates comparison reports between multiple benchmark runs,
 * renders formatted tables, and writes JSON/text outputs.
 */

import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from 'fs';
import { resolve, basename } from 'path';
import type { BenchmarkResult, PruneReport, ModelProfile } from '../types';
import { aggregateResults } from '../benchmark/runner';

export interface CompareInput {
  name: string;
  results: BenchmarkResult[];
}

/**
 * Generate a comparison report between multiple prompt variants.
 */
export function generateComparisonReport(inputs: CompareInput[]): string {
  const lines: string[] = [
    'Prompt Variant Comparison Report',
    '═'.repeat(90),
    '',
    padRight('Metric', 22) + inputs.map((i) => padRight(i.name, 16)).join(''),
    '─'.repeat(90),
  ];

  const aggregates = inputs.map((i) => ({
    name: i.name,
    agg: aggregateResults(i.results),
  }));

  // Pass rate row
  lines.push(
    padRight('Pass rate', 22) +
    aggregates.map((a) => padRight(`${(a.agg.passRate * 100).toFixed(1)}%`, 16)).join(''),
  );

  // Rule compliance row
  lines.push(
    padRight('Rule compliance', 22) +
    aggregates.map((a) => padRight(`${(a.agg.avgRuleCompliance * 100).toFixed(1)}%`, 16)).join(''),
  );

  // Tool accuracy row
  lines.push(
    padRight('Tool accuracy', 22) +
    aggregates.map((a) => padRight(`${(a.agg.avgToolAccuracy * 100).toFixed(1)}%`, 16)).join(''),
  );

  // Token efficiency row
  lines.push(
    padRight('Avg tokens', 22) +
    aggregates.map((a) => padRight(a.agg.avgTokenEfficiency.toFixed(0), 16)).join(''),
  );

  // Conciseness row
  lines.push(
    padRight('Conciseness', 22) +
    aggregates.map((a) => padRight(`${(a.agg.avgConciseness * 100).toFixed(1)}%`, 16)).join(''),
  );

  lines.push('─'.repeat(90));

  // Delta vs first (baseline)
  if (aggregates.length > 1) {
    lines.push('');
    lines.push('Delta vs baseline:');
    const base = aggregates[0]!.agg;
    for (let i = 1; i < aggregates.length; i++) {
      const other = aggregates[i]!;
      const dCompliance = ((other.agg.avgRuleCompliance - base.avgRuleCompliance) * 100).toFixed(1);
      const dTool = ((other.agg.avgToolAccuracy - base.avgToolAccuracy) * 100).toFixed(1);
      const dTokens = (other.agg.avgTokenEfficiency - base.avgTokenEfficiency).toFixed(0);
      lines.push(
        `  ${other.name}: compliance ${sign(dCompliance)}%, tool ${sign(dTool)}%, tokens ${sign(dTokens)}`,
      );
    }
  }

  // Top violations across all
  lines.push('');
  lines.push('Top violations (all variants):');
  const allViolations = new Map<string, number>();
  for (const input of inputs) {
    for (const r of input.results) {
      for (const v of r.violations) {
        allViolations.set(v, (allViolations.get(v) ?? 0) + 1);
      }
    }
  }
  const sorted = [...allViolations.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  for (const [rule, count] of sorted) {
    lines.push(`  ${count}x  ${rule}`);
  }

  return lines.join('\n');
}

/**
 * Load all reports from a directory matching a pattern.
 */
export function loadReports(dir: string, prefix: string): CompareInput[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .sort();

  return files.map((f) => {
    const content = JSON.parse(readFileSync(resolve(dir, f), 'utf-8'));
    const name = basename(f, '.json');
    const results: BenchmarkResult[] = content.results ?? [];
    return { name, results };
  });
}

/**
 * Write a report to disk in both JSON and text formats.
 */
export function writeReport(
  outputDir: string,
  name: string,
  data: unknown,
  textContent?: string,
): { jsonPath: string; textPath?: string } {
  mkdirSync(outputDir, { recursive: true });
  const jsonPath = resolve(outputDir, `${name}.json`);
  writeFileSync(jsonPath, JSON.stringify(data, null, 2));

  let textPath: string | undefined;
  if (textContent) {
    textPath = resolve(outputDir, `${name}.txt`);
    writeFileSync(textPath, textContent);
  }

  return { jsonPath, textPath };
}

/**
 * Generate a summary dashboard combining prune + probe data.
 */
export function generateDashboard(
  pruneReport?: PruneReport,
  modelProfile?: ModelProfile,
): string {
  const lines: string[] = ['Prompt Optimizer Dashboard', '═'.repeat(60), ''];

  if (pruneReport) {
    lines.push(`Prompt Size: ${pruneReport.totalTokens} tokens`);
    lines.push(`Prunable: ${pruneReport.prunableTokens} tokens (${((pruneReport.prunableTokens / pruneReport.totalTokens) * 100).toFixed(1)}%)`);
    lines.push(`Sections: ${pruneReport.sections.length} total, ${pruneReport.sections.filter((s) => s.verdict === 'PRUNE').length} removable`);
    lines.push('');
  }

  if (modelProfile) {
    lines.push(`Model: ${modelProfile.model}`);
    lines.push(`Overall Strength: ${(modelProfile.overallStrength * 100).toFixed(0)}%`);
    const weak = modelProfile.dimensions.filter((d) => d.score < 0.7);
    if (weak.length > 0) {
      lines.push(`Weak dimensions: ${weak.map((d) => `${d.dimension}(${(d.score * 100).toFixed(0)}%)`).join(', ')}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function padRight(str: string, len: number): string {
  return str.length >= len ? str + ' ' : str + ' '.repeat(len - str.length);
}

function sign(val: string): string {
  return Number(val) >= 0 ? `+${val}` : val;
}
