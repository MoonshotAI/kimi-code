#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { parse } from 'yaml';

const ROOT = resolve(import.meta.dirname, '../..');
const CATALOG_FILE = 'tests/e2e/scenarios/cache/catalog.yaml';
const CACHE_SCENARIOS = 'tests/e2e/scenarios/cache/';
const PROMISES = ['keeps', 'breaks', 'unknown'];
const BREAK_PARTS = ['header', 'history'];
const KINDS = {
  explicit: { where: (test) => test.startsWith(CACHE_SCENARIOS) && test.endsWith('.spec.ts'), place: `a scenario in ${CACHE_SCENARIOS}` },
  implicit: { where: (test) => test.startsWith('tests/e2e/scenarios/') && !test.startsWith(CACHE_SCENARIOS) && test.endsWith('.spec.ts'), place: `a scenario in tests/e2e/scenarios/ outside ${CACHE_SCENARIOS}` },
  kap: { where: (test) => test.startsWith('tests/scenarios/'), place: 'a KAP scenario in tests/scenarios/' },
  engine: { where: (test) => /^packages\/[^/]+\/test\//.test(test), place: 'a package test in packages/<name>/test/' },
};
const ID = /^[A-F][0-9]+$/;

const filled = (value) => typeof value === 'string' && value.trim() !== '';

export function readCatalog(text) {
  const entries = parse(text)?.entries;
  return Array.isArray(entries) ? { entries, problems: [] } : { entries: [], problems: [`${CATALOG_FILE} must have an entries list`] };
}

function entryProblems(entry, index, readText) {
  const name = filled(entry?.id) ? entry.id : `entry ${index + 1}`;
  const problems = [];
  if (!filled(entry?.id) || !ID.test(entry.id)) problems.push(`${name}: id must be a group letter A-F followed by a number`);
  if (!filled(entry?.operation)) problems.push(`${name}: operation must say what the user does or what happens`);
  if (!PROMISES.includes(entry?.promise)) problems.push(`${name}: promise must be one of ${PROMISES.join(', ')}`);
  if (entry?.promise === 'breaks') {
    if (!BREAK_PARTS.includes(entry.break?.at) || !filled(entry.break?.reason)) {
      problems.push(`${name}: a break needs break.at (${BREAK_PARTS.join(' or ')}) and break.reason, the reason the scenario declares with model.expectCacheBreak()`);
    }
  } else if (entry?.break !== undefined) {
    problems.push(`${name}: only a promise of breaks takes a break`);
  }
  const coverage = entry?.coverage ?? [];
  if (!Array.isArray(coverage)) return [...problems, `${name}: coverage must be a list`];
  if (coverage.length === 0 && !filled(entry?.gap)) problems.push(`${name}: list the tests that cover it, or say in gap what is missing`);
  if (entry?.promise === 'unknown' && !filled(entry?.gap)) problems.push(`${name}: an unknown promise needs a gap that says what to find out`);
  for (const item of coverage) {
    const kind = KINDS[item?.kind];
    if (kind === undefined) {
      problems.push(`${name}: coverage kind must be one of ${Object.keys(KINDS).join(', ')}`);
      continue;
    }
    if (entry.promise === 'unknown' && item.kind === 'explicit') problems.push(`${name}: a scenario cannot assert an unknown promise; settle the promise first`);
    if (!filled(item.test) || !kind.where(item.test)) {
      problems.push(`${name}: ${item.kind} coverage must point at ${kind.place}, got ${JSON.stringify(item.test)}`);
      continue;
    }
    const text = readText(item.test);
    if (text === undefined) {
      problems.push(`${name}: ${item.test} does not exist`);
      continue;
    }
    if (item.case !== undefined && (!filled(item.case) || !text.includes(item.case))) problems.push(`${name}: ${item.test} has no case ${JSON.stringify(item.case)}`);
    if (item.kind !== 'explicit') continue;
    const declares = text.includes('expectCacheBreak(');
    if (entry.promise === 'keeps' && declares) problems.push(`${name}: ${item.test} declares a cache break, but the promise is keeps`);
    if (entry.promise === 'breaks' && filled(entry.break?.reason) && !text.includes(entry.break.reason)) {
      problems.push(`${name}: ${item.test} must declare the break with model.expectCacheBreak(${JSON.stringify(entry.break?.reason)}, …)`);
    }
  }
  return problems;
}

export function catalogProblems({ entries, scenarios, readText }) {
  const problems = entries.flatMap((entry, index) => entryProblems(entry, index, readText));
  const ids = entries.map((entry) => entry?.id).filter(filled);
  for (const id of new Set(ids.filter((id, index) => ids.indexOf(id) !== index))) problems.push(`${id} is listed twice`);
  const covered = new Set(entries.flatMap((entry) => (Array.isArray(entry?.coverage) ? entry.coverage : [])).filter((item) => item?.kind === 'explicit').map((item) => item.test));
  for (const scenario of scenarios) {
    if (!covered.has(scenario)) problems.push(`${scenario} is a cache scenario, but no entry in ${CATALOG_FILE} lists it as explicit coverage`);
  }
  return problems;
}

function cacheScenarios() {
  return readdirSync(join(ROOT, CACHE_SCENARIOS))
    .filter((name) => name.endsWith('.spec.ts'))
    .map((name) => `${CACHE_SCENARIOS}${name}`)
    .toSorted();
}

export function main(args) {
  if (args.length > 0) {
    process.stderr.write(`✗ e2e-cache-catalog: unsupported arguments ${args.join(' ')}\n`);
    return 2;
  }
  const { entries, problems: readProblems } = readCatalog(readFileSync(join(ROOT, CATALOG_FILE), 'utf8'));
  const scenarios = cacheScenarios();
  const readText = (file) => (existsSync(join(ROOT, file)) ? readFileSync(join(ROOT, file), 'utf8') : undefined);
  const problems = [...readProblems, ...catalogProblems({ entries, scenarios, readText })];
  if (problems.length > 0) {
    process.stderr.write(
      [
        `✗ e2e-cache-catalog: ${problems.length} problem(s) in ${CATALOG_FILE}`,
        '  Why: the catalog is the list of everything that may change what the product sends to the model service. An entry without a test, or a cache scenario that is not listed, is a hole nobody sees.',
        ...problems.map((problem) => `  - ${problem}`),
      ].join('\n') + '\n',
    );
    return 1;
  }
  const gaps = entries.filter((entry) => filled(entry.gap)).length;
  process.stdout.write(`✓ e2e-cache-catalog: ${entries.length} entries, ${scenarios.length} cache scenarios listed, ${gaps} entries with a recorded gap\n`);
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  process.exitCode = main(process.argv.slice(2));
}
