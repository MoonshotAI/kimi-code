/**
 * Prompt Optimizer — CLI entry point.
 *
 * Usage:
 *   tsx src/cli.ts bench [--model <model>] [--variant <name>] [--dry-run]
 *   tsx src/cli.ts prune [--model <model>] [--dry-run]
 *   tsx src/cli.ts ab    [--model <model>] [--experiment <file>] [--dry-run]
 *   tsx src/cli.ts probe [--model <model>] [--reps <n>] [--dry-run]
 */

import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { loadConfig } from './config';
import { loadPrompt, generateBaselineVariant, generatePruneVariant } from './prompt-parser';
import { BENCHMARK_CASES } from './benchmark/cases';
import { runSuite, aggregateResults, dryRunCaller, type RunnerConfig } from './benchmark/runner';
import { runPruner, formatPruneReport } from './pruner/pruner';
import { runProbe, formatProbeReport } from './probe/probe';
import { formatABReport, runABExperiment } from './ab-test/ab-test';
import { generateComparisonReport, type CompareInput } from './report/report';
import { realCaller, resolveCredentials } from './llm-caller';

const args = process.argv.slice(2);
const command = args[0];

function getArg(name: string, defaultValue?: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return defaultValue;
  return args[idx + 1] ?? defaultValue;
}

function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

async function main() {
  const config = loadConfig();
  const isDryRun = hasFlag('dry-run');
  const model = getArg('model', config.defaultModel)!;

  const runnerConfig: RunnerConfig = {
    model,
    apiBaseUrl: config.apiBaseUrl,
    apiKey: process.env[config.apiKeyEnvVar] ?? '',
    concurrency: config.concurrency,
  };

  // Resolve caller: real API if key available and not --dry-run, otherwise dry-run
  const resolved = resolveCredentials(runnerConfig);
  const hasApiKey = resolved.apiKey.length > 0;
  const caller = isDryRun || !hasApiKey ? dryRunCaller : realCaller;

  if (!isDryRun && !hasApiKey) {
    console.warn('Warning: No API key found, falling back to dry-run mode.');
    console.warn('  Checked: KIMI_API_KEY, KIMI_MODEL_API_KEY, ~/.kimi-code/config.toml');
  }

  const outputDir = config.outputDir;
  mkdirSync(outputDir, { recursive: true });

  switch (command) {
    case 'bench': {
      const compareArg = getArg('compare');
      const { sections } = loadPrompt(config.systemPromptPath);

      if (compareArg) {
        // --compare mode: run multiple variants and compare
        const variantNames = compareArg.split(',');
        console.log(`Comparing variants: ${variantNames.join(' vs ')} (model: ${model}, dry-run: ${isDryRun})`);
        const compareInputs: CompareInput[] = [];

        for (const vName of variantNames) {
          const variant = vName.trim() === 'base'
            ? generateBaselineVariant(sections)
            : generatePruneVariant(sections, vName.trim());
          const results = await runSuite(BENCHMARK_CASES, variant, caller, runnerConfig);
          compareInputs.push({ name: vName.trim(), results });
        }

        console.log('\n' + generateComparisonReport(compareInputs));

        const reportPath = resolve(outputDir, `compare-${model}-${Date.now()}.json`);
        writeFileSync(reportPath, JSON.stringify(compareInputs.map((c) => ({ name: c.name, aggregate: aggregateResults(c.results) })), null, 2));
        console.log(`\nFull report: ${reportPath}`);
      } else {
        // Single variant mode
        const variantName = getArg('variant', 'base')!;
        console.log(`Running benchmark suite (${BENCHMARK_CASES.length} cases, model: ${model}, variant: ${variantName}, dry-run: ${isDryRun})`);
        const variant = variantName === 'base'
          ? generateBaselineVariant(sections)
          : generatePruneVariant(sections, variantName);
        const results = await runSuite(BENCHMARK_CASES, variant, caller, runnerConfig);
        const agg = aggregateResults(results);

        console.log('\n═══ Benchmark Results ═══');
        console.log(`Pass rate:        ${(agg.passRate * 100).toFixed(1)}%`);
        console.log(`Rule compliance:  ${(agg.avgRuleCompliance * 100).toFixed(1)}%`);
        console.log(`Tool accuracy:    ${(agg.avgToolAccuracy * 100).toFixed(1)}%`);
        console.log(`Avg tokens:       ${agg.avgTokenEfficiency.toFixed(0)}`);
        console.log(`Conciseness:      ${(agg.avgConciseness * 100).toFixed(1)}%`);

        if (agg.topViolations.length > 0) {
          console.log('\nTop violations:');
          for (const v of agg.topViolations) {
            console.log(`  ${v.count}x  ${v.rule}`);
          }
        }

        const reportPath = resolve(outputDir, `bench-${model}-${Date.now()}.json`);
        writeFileSync(reportPath, JSON.stringify({ aggregate: agg, results }, null, 2));
        console.log(`\nFull report: ${reportPath}`);
      }
      break;
    }

    case 'prune': {
      console.log(`Running pruner (model: ${model}, dry-run: ${isDryRun})`);
      const { sections } = loadPrompt(config.systemPromptPath);

      const report = await runPruner(sections, BENCHMARK_CASES, {
        significanceThreshold: 0.1,
        runner: runnerConfig,
        caller,
      });

      console.log('\n' + formatPruneReport(report));

      const reportPath = resolve(outputDir, `prune-${model}-${Date.now()}.json`);
      writeFileSync(reportPath, JSON.stringify(report, null, 2));
      console.log(`\nFull report: ${reportPath}`);
      break;
    }

    case 'ab': {
      console.log(`Running A/B test (model: ${model}, dry-run: ${isDryRun})`);
      const { sections } = loadPrompt(config.systemPromptPath);
      const baseline = generateBaselineVariant(sections);

      // Default experiment: test removing "Ultimate Reminders" last 3 rules
      const trimmedContent = sections
        .map((s) => s.content)
        .join('\n')
        .replace(/- Before you finalize a reply[\s\S]*$/, '');

      const result = await runABExperiment(
        {
          name: 'trim-ultimate-reminders-tail',
          targetSections: ['Ultimate Reminders'],
          variants: [
            baseline,
            {
              name: 'trimmed-tail',
              description: 'Removed last 3 rules from Ultimate Reminders',
              content: trimmedContent,
              modifiedSections: ['Ultimate Reminders'],
            },
          ],
          caseFilter: 'all',
          repetitions: 1,
          model,
        },
        { runner: runnerConfig, caller },
      );

      console.log('\n' + formatABReport(result));

      const reportPath = resolve(outputDir, `ab-${model}-${Date.now()}.json`);
      writeFileSync(reportPath, JSON.stringify({ ...result, variantResults: Object.fromEntries(result.variantResults) }, null, 2));
      console.log(`\nFull report: ${reportPath}`);
      break;
    }

    case 'probe': {
      const reps = Number(getArg('reps', '3'));
      console.log(`Running model probe (model: ${model}, reps: ${reps}, dry-run: ${isDryRun})`);

      const profile = await runProbe({
        runner: runnerConfig,
        caller,
        repetitions: reps,
      });

      console.log('\n' + formatProbeReport(profile));

      const reportPath = resolve(outputDir, `probe-${model}-${Date.now()}.json`);
      writeFileSync(reportPath, JSON.stringify(profile, null, 2));
      console.log(`\nFull report: ${reportPath}`);
      break;
    }

    default:
      console.log(`Prompt Optimizer — Data-driven prompt optimization for kimi-code

Commands:
  bench   Run the benchmark suite against current system.md
  prune   Scan for removable sections (prompt pruning)
  ab      A/B test prompt variants
  probe   Profile model capabilities and weaknesses

Options:
  --model <name>    Model to test (default: ${config.defaultModel})
  --dry-run         Run without API calls (test framework only)
  --reps <n>        Repetitions for probe (default: 3)

Examples:
  tsx src/cli.ts bench --dry-run
  tsx src/cli.ts prune --model gpt-4o
  tsx src/cli.ts probe --model deepseek-v3 --reps 5
  tsx src/cli.ts ab --dry-run`);
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
