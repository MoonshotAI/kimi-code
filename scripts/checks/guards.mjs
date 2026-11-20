#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { parse } from 'yaml';

const ROOT = resolve(import.meta.dirname, '../..');
const GUARDS_FILE = 'scripts/checks/guards.mjs';
const SNAPSHOT_FILE = 'scripts/checks/baselines/oxlint-config.json';
const REGISTRY_FILE = 'scripts/checks/registry.json';
const LEVEL_NAMES = { allow: 'off', off: 'off', warn: 'warn', deny: 'error', error: 'error' };
const LEVEL_RANKS = { off: 0, warn: 1, error: 2 };
const KIND_ORDER = { weakened: 0, changed: 1, strengthened: 2 };
const DIFFED_KEYS = new Set(['$schema', 'categories', 'plugins', 'rules', 'overrides', 'ignorePatterns']);
const RUNS_AFTER_FAILURE = /\balways\(\)|!\s*cancelled\(\)/;

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, sortKeys(value[key])]),
  );
}

function levelOf(setting) {
  const level = Array.isArray(setting) ? setting[0] : setting;
  return LEVEL_NAMES[level] ?? 'off';
}

function describeFiles(files) {
  return files.length <= 2 ? files.join(', ') : `${files[0]} (+${files.length - 1} more)`;
}

function diffRules(beforeRules, afterRules, scope) {
  const before = beforeRules ?? {};
  const after = afterRules ?? {};
  const findings = [];
  for (const rule of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const from = levelOf(before[rule]);
    const to = levelOf(after[rule]);
    if (from !== to) {
      findings.push({
        kind: LEVEL_RANKS[to] < LEVEL_RANKS[from] ? 'weakened' : 'strengthened',
        detail: `${scope}${rule}: ${from} → ${to}`,
      });
    } else if (to !== 'off' && JSON.stringify(before[rule]) !== JSON.stringify(after[rule])) {
      findings.push({ kind: 'changed', detail: `${scope}${rule}: options changed` });
    }
  }
  return findings;
}

function diffMembers(beforeItems, afterItems, label, addedKind, removedKind) {
  const before = beforeItems ?? [];
  const after = afterItems ?? [];
  return [
    ...after
      .filter((item) => !before.includes(item))
      .map((item) => ({ kind: addedKind, detail: `${label} added: ${item}` })),
    ...before
      .filter((item) => !after.includes(item))
      .map((item) => ({ kind: removedKind, detail: `${label} removed: ${item}` })),
  ];
}

function diffOverrides(beforeOverrides, afterOverrides) {
  const before = beforeOverrides ?? [];
  const after = afterOverrides ?? [];
  const keyOf = (override) => JSON.stringify(override.files);
  const otherSettingsOf = (override) =>
    JSON.stringify({ ...override, files: undefined, rules: undefined, plugins: undefined });
  const afterByFiles = new Map(after.map((override) => [keyOf(override), override]));
  const beforeKeys = new Set(before.map(keyOf));
  const findings = [];
  for (const override of before) {
    const scope = `override ${describeFiles(override.files)}: `;
    const match = afterByFiles.get(keyOf(override));
    if (match === undefined) {
      findings.push({ kind: 'changed', detail: `${scope}removed` });
      continue;
    }
    findings.push(
      ...diffRules(override.rules, match.rules, scope),
      ...diffMembers(override.plugins, match.plugins, `${scope}plugin`, 'changed', 'weakened'),
    );
    if (otherSettingsOf(override) !== otherSettingsOf(match)) {
      findings.push({ kind: 'changed', detail: `${scope}other settings changed` });
    }
  }
  for (const override of after) {
    if (!beforeKeys.has(keyOf(override))) {
      findings.push({ kind: 'changed', detail: `override ${describeFiles(override.files)}: added` });
    }
  }
  return findings;
}

export function diffConfigs(before, after) {
  const findings = [
    ...diffRules(before.categories, after.categories, 'category '),
    ...diffMembers(before.plugins, after.plugins, 'plugin', 'changed', 'weakened'),
    ...diffRules(before.rules, after.rules, ''),
    ...diffOverrides(before.overrides, after.overrides),
    ...diffMembers(before.ignorePatterns, after.ignorePatterns, 'ignore pattern', 'weakened', 'strengthened'),
  ];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!DIFFED_KEYS.has(key) && JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      findings.push({ kind: 'changed', detail: `${key} changed` });
    }
  }
  return findings.toSorted(
    (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.detail.localeCompare(b.detail),
  );
}

function commandsIn(value) {
  if (typeof value === 'string') return value.split('&&').map((command) => command.trim());
  if (Array.isArray(value)) return value.flatMap(commandsIn);
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(commandsIn);
  return [];
}

function commandLines(text) {
  return text
    .split('\n')
    .map((line) =>
      line
        .trim()
        .replace(/^-\s*/, '')
        .replace(/^run:\s*/, ''),
    )
    .filter((line) => line !== '');
}

function jobBlock(text, job) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^  ${job}:\\s*$`).test(line));
  if (start === -1) return '';
  const end = lines.findIndex((line, index) => index > start && /^ {0,2}\S/.test(line));
  return lines.slice(start + 1, end === -1 ? lines.length : end).join('\n');
}

function commandsAt(location, readText) {
  const [file, path] = location.split('#');
  const text = readText(file);
  if (text === undefined) return [];
  if (path === undefined) return commandLines(text);
  if (file.endsWith('.json')) {
    return commandsIn(path.split('.').reduce((value, key) => value?.[key], JSON.parse(text)));
  }
  return commandLines(jobBlock(text, path.replace(/^jobs\./, '')));
}

export function checkWiring(registry, readText, fileExists) {
  const findings = [];
  for (const entry of registry.invocations) {
    const commands = commandsAt(entry.in, readText);
    const wired = entry.contains
      ? commands.some((command) => command.includes(entry.run))
      : commands.includes(entry.run);
    if (!wired) findings.push({ kind: 'missing', entry });
    for (const path of entry.run.split(/\s+/).filter((token) => /^[\w./-]+\.[cm]?js$/.test(token))) {
      if (!fileExists(path)) findings.push({ kind: 'missing-file', entry, path });
    }
  }
  for (const entry of registry.forbidden) {
    for (const command of commandsAt(entry.in, readText)) {
      const flag = command.split(/\s+/).find((token) => entry.flags.includes(token));
      if (flag !== undefined) findings.push({ kind: 'forbidden', entry, command, flag });
    }
  }
  return findings;
}

export function checkFanIn(registry, readText) {
  const findings = [];
  for (const entry of registry.fanIn ?? []) {
    const text = readText(entry.workflow);
    const jobs = text === undefined ? undefined : parse(text)?.jobs;
    const job = jobs?.[entry.job];
    if (job === undefined) {
      findings.push({ kind: 'fan-in-missing', entry });
      continue;
    }
    const needs = [job.needs ?? []].flat();
    for (const need of entry.needs) {
      if (!needs.includes(need)) findings.push({ kind: 'fan-in-need', entry, job: need });
    }
    if (!RUNS_AFTER_FAILURE.test(String(job.if ?? ''))) findings.push({ kind: 'fan-in-condition', entry });
    if (entry.checksResults) {
      const steps = JSON.stringify(job.steps ?? []);
      for (const need of needs) {
        if (!steps.includes(`needs.${need}.result`)) findings.push({ kind: 'fan-in-result', entry, job: need });
      }
    }
    if (entry.coversJobsExcept !== undefined) {
      for (const other of Object.keys(jobs)) {
        if (other !== entry.job && !entry.coversJobsExcept.includes(other) && !needs.includes(other)) {
          findings.push({ kind: 'fan-in-uncovered', entry, job: other });
        }
      }
    }
  }
  return findings;
}

function formatConfigFindings(findings) {
  if (findings.length === 0) return [];
  return [
    `✗ guards: the effective oxlint config differs from ${SNAPSHOT_FILE}`,
    ...findings.map((finding) => `  - ${finding.kind}: ${finding.detail}`),
    '  Why: lint rules and lint scope should change only on purpose and in review. An unnoticed downgrade or a newly ignored path lets back in the problems the rule used to catch.',
    `  What to do: if the change is intended, run \`node ${GUARDS_FILE} --update\`, commit the snapshot together with the config change, and explain the change in the PR. Otherwise revert the config change.`,
  ];
}

function formatWiringFinding(finding) {
  const { entry } = finding;
  if (finding.kind === 'missing') {
    return [
      `✗ guards: \`${entry.run}\` is no longer run by ${entry.in}`,
      `  Why: ${entry.why}`,
      `  What to do: restore it. To retire this check on purpose, delete its entry from ${REGISTRY_FILE} in the same change and say why in the PR.`,
    ];
  }
  if (finding.kind === 'missing-file') {
    return [
      `✗ guards: ${finding.path} no longer exists, but ${entry.in} is registered to run it`,
      `  Why: ${entry.why}`,
      `  What to do: restore the file, or retire the check on purpose by deleting its entry from ${REGISTRY_FILE} and saying why in the PR.`,
    ];
  }
  return [
    `✗ guards: ${entry.in} runs \`${finding.command}\`, which passes ${finding.flag}`,
    `  Why: ${entry.why}`,
    `  What to do: remove ${finding.flag} from that command.`,
  ];
}

function formatFanInFinding(finding) {
  const { entry } = finding;
  const where = `${entry.workflow} job ${entry.job}`;
  const [problem, fix] = {
    'fan-in-missing': [`${where} no longer exists`, `restore it, or retire it on purpose by deleting its fanIn entry from ${REGISTRY_FILE} and saying why in the PR.`],
    'fan-in-need': [`${where} no longer needs ${finding.job}`, `add ${finding.job} back to its needs.`],
    'fan-in-condition': [`${where} does not run when a job it collects fails`, 'give it `if: ${{ always() }}` or `if: ${{ !cancelled() }}`. A skipped job is reported as passed, so without it a failure upstream reaches the merge button as green.'],
    'fan-in-result': [`${where} needs ${finding.job} but never reads needs.${finding.job}.result`, `fail the job unless needs.${finding.job}.result is success.`],
    'fan-in-uncovered': [`${where} does not collect ${finding.job}`, `add ${finding.job} to its needs and check its result, or list it in coversJobsExcept of the fanIn entry in ${REGISTRY_FILE} and say why in the PR.`],
  }[finding.kind];
  return [`✗ guards: ${problem}`, `  Why: ${entry.why}`, `  What to do: ${fix}`];
}

export function expandOverridePlugins(config, catalog) {
  const categories = config.categories ?? {};
  const pluginKey = (name) => name.replaceAll('_', '-');
  return {
    ...config,
    overrides: (config.overrides ?? []).map((override) => {
      const plugins = (override.plugins ?? []).map(pluginKey);
      if (plugins.length === 0) return override;
      const categoryRules = catalog
        .filter((rule) => plugins.includes(pluginKey(rule.scope)) && levelOf(categories[rule.category]) !== 'off')
        .map((rule) => [`${rule.scope}/${rule.value}`, categories[rule.category]]);
      return { ...override, rules: { ...Object.fromEntries(categoryRules), ...override.rules } };
    }),
  };
}

function runOxlint(args) {
  const result = spawnSync(process.execPath, [join(ROOT, 'node_modules/oxlint/bin/oxlint'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const output = result.stderr === '' ? result.stdout : result.stderr;
    throw new Error(`oxlint ${args.join(' ')} exited with ${result.status}: ${output}`);
  }
  return JSON.parse(result.stdout);
}

function readEffectiveConfig() {
  const config = runOxlint(['--type-aware', '--print-config']);
  const catalog = runOxlint(['--rules', '--format', 'json']);
  return sortKeys(expandOverridePlugins(config, catalog));
}

export function main(args) {
  const unknown = args.filter((arg) => arg !== '--update');
  if (unknown.length > 0) {
    process.stderr.write(
      `✗ guards: unknown argument ${unknown.join(' ')}. Run \`pnpm lint\` without extra arguments; \`node ${GUARDS_FILE} --update\` rewrites ${SNAPSHOT_FILE}.\n`,
    );
    return 2;
  }
  let config;
  try {
    config = readEffectiveConfig();
  } catch (error) {
    process.stderr.write(`✗ guards: could not read the effective oxlint config. ${error.message}\n`);
    return 1;
  }
  const ruleCount = Object.keys(config.rules).length;
  if (args.includes('--update')) {
    mkdirSync(dirname(join(ROOT, SNAPSHOT_FILE)), { recursive: true });
    writeFileSync(join(ROOT, SNAPSHOT_FILE), `${JSON.stringify(config, null, 2)}\n`);
    process.stdout.write(`✓ guards: wrote ${SNAPSHOT_FILE} (${ruleCount} rules)\n`);
    return 0;
  }
  if (!existsSync(join(ROOT, SNAPSHOT_FILE))) {
    process.stderr.write(
      `✗ guards: ${SNAPSHOT_FILE} is missing. Run \`node ${GUARDS_FILE} --update\` to record the current oxlint config, then commit it.\n`,
    );
    return 1;
  }
  const snapshot = JSON.parse(readFileSync(join(ROOT, SNAPSHOT_FILE), 'utf8'));
  const registry = JSON.parse(readFileSync(join(ROOT, REGISTRY_FILE), 'utf8'));
  const report = [
    ...formatConfigFindings(diffConfigs(snapshot, config)),
    ...checkWiring(
      registry,
      (file) => (existsSync(join(ROOT, file)) ? readFileSync(join(ROOT, file), 'utf8') : undefined),
      (file) => existsSync(join(ROOT, file)),
    ).flatMap(formatWiringFinding),
    ...checkFanIn(registry, (file) => (existsSync(join(ROOT, file)) ? readFileSync(join(ROOT, file), 'utf8') : undefined)).flatMap(formatFanInFinding),
  ];
  if (report.length > 0) {
    process.stderr.write(`${report.join('\n')}\n`);
    return 1;
  }
  process.stdout.write(
    `✓ guards: oxlint config matches the snapshot (${ruleCount} rules, ${config.overrides?.length ?? 0} overrides); ${registry.invocations.length} check invocations wired; ${registry.fanIn?.length ?? 0} fan-in jobs collect every result\n`,
  );
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  process.exitCode = main(process.argv.slice(2));
}
