#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const RATCHET_FILE = 'scripts/checks/ratchet.mjs';
const MAIN_CONFIG = '.oxlintrc.json';
const RATCHET_CONFIG = '.oxlintrc.ratchet.json';
const BASELINE_FILE = 'scripts/checks/baselines/oxlint-ratchet.json';
const UNUSED_DIRECTIVE = /^Unused (?:eslint|oxlint)-disable directive/;
const DIAGNOSTIC_SCOPES = new Map([['react-hooks', 'react']]);

export function ruleOf(code) {
  const match = /^([\w-]+)\((.+)\)$/.exec(code ?? '');
  return match === null ? undefined : `${DIAGNOSTIC_SCOPES.get(match[1]) ?? match[1]}/${match[2]}`;
}

export function ratchetRules(config) {
  const rules = new Set();
  for (const entries of [config.rules, ...(config.overrides ?? []).map((override) => override.rules)]) {
    for (const [rule, setting] of Object.entries(entries ?? {})) {
      const level = Array.isArray(setting) ? setting[0] : setting;
      if (level !== 'off' && level !== 'allow') rules.add(rule);
    }
  }
  return rules;
}

export function countFindings(diagnostics, rules) {
  const counts = {};
  const unused = [];
  const unmatched = [];
  for (const diagnostic of diagnostics) {
    if (UNUSED_DIRECTIVE.test(diagnostic.message)) {
      unused.push(diagnostic);
      continue;
    }
    const rule = ruleOf(diagnostic.code);
    if (rule === undefined || !rules.has(rule)) {
      unmatched.push(diagnostic);
      continue;
    }
    counts[rule] ??= {};
    counts[rule][diagnostic.filename] = (counts[rule][diagnostic.filename] ?? 0) + 1;
  }
  return { counts, unused, unmatched };
}

export function compareCounts(baseline, current) {
  const changes = [];
  for (const rule of new Set([...Object.keys(baseline), ...Object.keys(current)])) {
    const before = baseline[rule] ?? {};
    const after = current[rule] ?? {};
    for (const file of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const from = before[file] ?? 0;
      const to = after[file] ?? 0;
      if (to > from) changes.push({ kind: 'added', rule, file, from, to });
      if (to < from) changes.push({ kind: 'removed', rule, file, from, to });
    }
  }
  return changes.toSorted((a, b) => {
    for (const key of ['kind', 'rule', 'file']) {
      const order = a[key].localeCompare(b[key]);
      if (order !== 0) return order;
    }
    return 0;
  });
}

export function ratchetBaseline(path, counts, args) {
  const changes = compareCounts(existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}, counts);
  if (!args.includes('--update')) return { status: 'compared', changes };
  const added = changes.filter((change) => change.kind === 'added');
  if (added.length > 0 && !args.includes('--allow-increase')) return { status: 'refused', changes: added };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(sortCounts(counts), null, 2)}\n`);
  return { status: 'written', changes };
}

export function reportChanges(changes, describe) {
  const added = changes.filter((change) => change.kind === 'added');
  const removed = changes.filter((change) => change.kind === 'removed');
  return [...(added.length > 0 ? describe.added(added) : []), ...(removed.length > 0 ? describe.removed(removed) : [])];
}

export function trackedFiles(root, keep, pathspecs = []) {
  const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...pathspecs], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return output.split('\0').filter((file) => file !== '' && keep(file) && existsSync(join(root, file)));
}

export function runCountCheck({ name, root, checkFile, baselineFile, args, measure, formatReport, summary }) {
  const known = new Set(['--update', '--allow-increase']);
  if (args.some((arg) => !known.has(arg)) || (args.includes('--allow-increase') && !args.includes('--update'))) {
    process.stderr.write(`✗ ${name}: unsupported arguments ${args.join(' ')}. Run \`pnpm lint\`; \`node ${checkFile} --update\` lowers ${baselineFile}.\n`);
    return 2;
  }
  const counts = measure();
  const outcome = ratchetBaseline(join(root, baselineFile), counts, args);
  if (outcome.status === 'written') {
    process.stdout.write(`✓ ${name}: wrote ${baselineFile}\n`);
    return 0;
  }
  const report = formatReport(outcome.changes);
  if (report.length > 0) {
    process.stderr.write(`${report.join('\n')}\n`);
    return 1;
  }
  process.stdout.write(`✓ ${name}: ${summary(counts)}\n`);
  return 0;
}

function sortCounts(counts) {
  return Object.fromEntries(
    Object.keys(counts)
      .toSorted()
      .map((rule) => [
        rule,
        Object.fromEntries(
          Object.keys(counts[rule])
            .toSorted()
            .map((file) => [file, counts[rule][file]]),
        ),
      ]),
  );
}

function totals(counts) {
  const files = new Set();
  let findings = 0;
  for (const perFile of Object.values(counts)) {
    for (const [file, count] of Object.entries(perFile)) {
      files.add(file);
      findings += count;
    }
  }
  return { findings, files: files.size };
}

function runOxlint(args) {
  const result = spawnSync(process.execPath, [join(ROOT, 'node_modules/oxlint/bin/oxlint'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  try {
    return JSON.parse(result.stdout);
  } catch {
    const output = result.stderr === '' ? result.stdout : result.stderr;
    throw new Error(`oxlint ${args.join(' ')} exited with ${result.status}: ${output.slice(0, 2000)}`);
  }
}

function describeLocation(diagnostic) {
  const span = diagnostic.labels?.[0]?.span;
  const help = diagnostic.help === undefined ? '' : ` ${diagnostic.help}`;
  return `    ${diagnostic.filename}:${span?.line}:${span?.column}  ${diagnostic.message}${help}`;
}

function formatUnmatched(unmatched) {
  const shown = unmatched.slice(0, 20);
  return [
    `✗ ratchet: ${unmatched.length} finding(s) match no rule in ${RATCHET_CONFIG}`,
    ...shown.flatMap((diagnostic) => [`  ${diagnostic.code ?? 'no rule code'}`, describeLocation(diagnostic)]),
    ...(unmatched.length > shown.length ? [`  … and ${unmatched.length - shown.length} more`] : []),
    '  Why: the ratchet counts a finding only under a rule it can find in its config, so it would drop these without a word.',
    `  What to do: if oxlint reports a frozen rule under another plugin name (it reports the react hooks rules as react-hooks), map that name in DIAGNOSTIC_SCOPES in ${RATCHET_FILE}. Otherwise fix the findings: they come from rules that must have none.`,
  ];
}

function formatReport(changes, unused, diagnostics) {
  const lines = [];
  const added = changes.filter((change) => change.kind === 'added');
  const removed = changes.filter((change) => change.kind === 'removed');
  if (unused.length > 0) {
    lines.push(
      `✗ ratchet: ${unused.length} disable directive(s) suppress nothing`,
      ...unused.map(describeLocation),
      '  Why: a suppression that matches no finding hides nothing today and silently hides the next real finding on that line.',
      '  What to do: delete the directive, or the rule names in it that report nothing.',
    );
  }
  if (added.length > 0) {
    lines.push(`✗ ratchet: new findings for rules frozen in ${BASELINE_FILE}`);
    for (const change of added) {
      lines.push(`  ${change.rule} in ${change.file}: ${change.from} → ${change.to}`);
      lines.push(
        ...diagnostics
          .filter((diagnostic) => diagnostic.filename === change.file && ruleOf(diagnostic.code) === change.rule)
          .map(describeLocation),
      );
    }
    lines.push(
      '  Why: these rules already have findings in existing code, so they are frozen at today\'s count per file. New code must not add to them.',
      `  What to do: fix the new occurrence. Do not raise the baseline to pass. If you moved existing code from another file, run \`node ${RATCHET_FILE} --update --allow-increase\` and say so in the PR.`,
    );
  }
  if (removed.length > 0) {
    lines.push(
      `✗ ratchet: ${BASELINE_FILE} allows more findings than the code has`,
      ...removed.map((change) => `  ${change.rule} in ${change.file}: ${change.from} → ${change.to}`),
      '  Why: the baseline only moves down. Lowering it now keeps fixed findings from coming back unnoticed.',
      `  What to do: run \`node ${RATCHET_FILE} --update\` and commit the baseline.`,
    );
  }
  return lines;
}

export function main(args) {
  const known = new Set(['--update', '--allow-increase']);
  const unknown = args.filter((arg) => !known.has(arg));
  if (unknown.length > 0 || (args.includes('--allow-increase') && !args.includes('--update'))) {
    process.stderr.write(
      `✗ ratchet: unsupported arguments ${args.join(' ')}. Run \`pnpm lint\`; \`node ${RATCHET_FILE} --update\` lowers ${BASELINE_FILE}.\n`,
    );
    return 2;
  }
  let mainConfig;
  let ratchetConfig;
  let diagnostics;
  try {
    mainConfig = runOxlint(['--type-aware', '--print-config']);
    ratchetConfig = runOxlint(['-c', RATCHET_CONFIG, '--type-aware', '--print-config']);
    diagnostics = runOxlint(['-c', RATCHET_CONFIG, '--type-aware', '--format', 'json']).diagnostics;
  } catch (error) {
    process.stderr.write(`✗ ratchet: could not run oxlint. ${error.message}\n`);
    return 1;
  }
  const mainIgnores = JSON.stringify((mainConfig.ignorePatterns ?? []).toSorted());
  const ratchetIgnores = JSON.stringify((ratchetConfig.ignorePatterns ?? []).toSorted());
  if (mainIgnores !== ratchetIgnores) {
    process.stderr.write(
      [
        `✗ ratchet: ignorePatterns in ${RATCHET_CONFIG} differ from ${MAIN_CONFIG}`,
        '  Why: extends does not carry ignorePatterns over, so the ratchet would lint a different set of files than lint does.',
        `  What to do: copy the ignorePatterns list from ${MAIN_CONFIG} into ${RATCHET_CONFIG}.`,
      ].join('\n') + '\n',
    );
    return 1;
  }
  const rules = ratchetRules(JSON.parse(readFileSync(join(ROOT, RATCHET_CONFIG), 'utf8')));
  const { counts, unused, unmatched } = countFindings(diagnostics, rules);
  if (unmatched.length > 0) {
    process.stderr.write(`${formatUnmatched(unmatched).join('\n')}\n`);
    return 1;
  }
  const outcome = ratchetBaseline(join(ROOT, BASELINE_FILE), counts, args);
  if (outcome.status === 'written') {
    const { findings, files } = totals(counts);
    process.stdout.write(`✓ ratchet: wrote ${BASELINE_FILE} (${findings} findings in ${files} files)\n`);
    return 0;
  }
  const report = formatReport(outcome.changes, outcome.status === 'refused' ? [] : unused, diagnostics);
  if (report.length > 0) {
    process.stderr.write(`${report.join('\n')}\n`);
    return 1;
  }
  const { findings, files } = totals(counts);
  process.stdout.write(
    `✓ ratchet: ${rules.size} rules frozen at ${findings} findings in ${files} files; nothing new, no unused suppressions\n`,
  );
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  process.exitCode = main(process.argv.slice(2));
}
