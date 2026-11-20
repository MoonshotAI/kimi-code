#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { parse } from 'yaml';

import { readProtectedManifest } from '../protected-smoke.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const MANIFEST_FILE = 'tests/quarantine.yaml';
const PROTECTED_FILE = 'tests/protected.yaml';
const MAX_DAYS_AHEAD = 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN = '@quarantine';
const TEST_SOURCE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const JOURNEY = /^apps\/desktop\/(?:e2e\/[^/]+|test\/e2e\/.+)\.spec\.ts$/;
const DECLARATION = /^\s*test(?:\.describe)?\(\s*(['"])((?:\\.|(?!\1).)*)\1\s*,\s*\{([^}]*)\}/;
const FIELDS = ['file', 'test', 'runner', 'reason', 'owner', 'since', 'expires'];

export function quarantinedTests(sources) {
  const found = [];
  const problems = [];
  for (const { file, text } of sources) {
    const tokens = text.split(TOKEN).length - 1;
    if (tokens === 0) continue;
    if (!JOURNEY.test(file)) {
      problems.push(`${file} uses ${TOKEN}, but only Desktop journeys can be quarantined`);
      continue;
    }
    let declared = 0;
    for (const line of text.split('\n')) {
      const match = DECLARATION.exec(line);
      if (match === null || !match[3].includes(TOKEN)) continue;
      declared += 1;
      found.push({ file, test: match[2].replace(/\\(.)/g, '$1'), smoke: match[3].includes('@smoke') });
    }
    if (declared !== tokens) problems.push(`${file} marks ${tokens} test(s) with ${TOKEN} but declares ${declared} on one line as test('title', { tag: '${TOKEN}' }, ...)`);
  }
  return { found, problems };
}

export function readQuarantine(text) {
  const parsed = parse(text);
  const raw = parsed?.quarantine;
  if (!Array.isArray(raw)) return { entries: [], problems: [`${MANIFEST_FILE} must have a quarantine list`] };
  const entries = [];
  const problems = [];
  for (const [index, entry] of raw.entries()) {
    const missing = FIELDS.filter((field) => typeof entry?.[field] !== 'string' || entry[field].trim() === '');
    if (missing.length > 0) problems.push(`${MANIFEST_FILE} entry ${index + 1} lacks ${missing.join(', ')}`);
    else entries.push(entry);
  }
  return { entries, problems };
}

export function quarantineProblems({ entries, found, protectedIds, today }) {
  const problems = [];
  const key = (entry) => `${entry.file} › ${entry.test}`;
  const listed = new Map();
  for (const entry of entries) {
    if (listed.has(key(entry))) problems.push(`${key(entry)} is listed twice`);
    listed.set(key(entry), entry);
    if (entry.runner !== 'playwright') problems.push(`${key(entry)}: runner ${entry.runner} is not supported; only Desktop journeys run under Playwright can be quarantined`);
    const since = dayOf(entry.since);
    const expires = dayOf(entry.expires);
    const now = dayOf(today);
    if (since === undefined || expires === undefined) {
      problems.push(`${key(entry)}: since and expires must be dates written as YYYY-MM-DD`);
      continue;
    }
    if (since > now) problems.push(`${key(entry)}: since ${entry.since} is later than the commit date ${today}`);
    if (expires <= since) problems.push(`${key(entry)}: expires ${entry.expires} must be after since ${entry.since}`);
    if (expires < now) problems.push(`${key(entry)} expired on ${entry.expires}: fix the journey and drop the tag, or renew it with a new expires date and reason`);
    if ((expires - now) / DAY_MS > MAX_DAYS_AHEAD) problems.push(`${key(entry)}: expires ${entry.expires} is more than ${MAX_DAYS_AHEAD} days after the commit date ${today}`);
  }
  for (const test of found) {
    if (!listed.has(key(test))) problems.push(`${key(test)} is tagged ${TOKEN} but not listed in ${MANIFEST_FILE}; add its reason, owner, since and expires`);
    if (test.smoke) problems.push(`${key(test)} is a smoke journey; the smoke run would drop it silently, so it cannot be quarantined`);
    const id = /^\[L0:([^\]]+)\]/.exec(test.test)?.[1];
    if (id !== undefined || protectedIds.some((protectedId) => test.test.startsWith(`[L0:${protectedId}]`))) {
      problems.push(`${key(test)} is a protected L0 test and cannot be quarantined; change ${PROTECTED_FILE} through review first`);
    }
  }
  for (const entry of entries) {
    if (!found.some((test) => key(test) === key(entry))) problems.push(`${key(entry)} is listed in ${MANIFEST_FILE}, but no test with that title in that file is tagged ${TOKEN}`);
  }
  return problems;
}

function dayOf(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return undefined;
  const time = Date.parse(`${text}T00:00:00Z`);
  return Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== text ? undefined : time;
}

function trackedTestSources() {
  const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return output.split('\0').filter((file) => TEST_SOURCE.test(file) && !file.startsWith('scripts/checks/')).map((file) => ({ file, text: readFileSync(join(ROOT, file), 'utf8') }));
}

export function main(args) {
  if (args.length > 0) {
    process.stderr.write(`✗ quarantine: unsupported arguments ${args.join(' ')}\n`);
    return 2;
  }
  const today = execFileSync('git', ['log', '-1', '--format=%cs', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const { entries, problems: manifestProblems } = readQuarantine(readFileSync(join(ROOT, MANIFEST_FILE), 'utf8'));
  const { found, problems: sourceProblems } = quarantinedTests(trackedTestSources());
  const protectedIds = readProtectedManifest(join(ROOT, PROTECTED_FILE)).cases.map((entry) => entry.id);
  const problems = [...manifestProblems, ...sourceProblems, ...quarantineProblems({ entries, found, protectedIds, today })];
  if (problems.length > 0) {
    process.stderr.write([`✗ quarantine: ${problems.length} problem(s) with quarantined tests (dates are checked against the commit date ${today})`, ...problems.map((problem) => `  - ${problem}`)].join('\n') + '\n');
    return 1;
  }
  const next = entries.map((entry) => entry.expires).toSorted((a, b) => a.localeCompare(b))[0];
  process.stdout.write(`✓ quarantine: ${found.length} quarantined Desktop journeys have an owner and a reason${next === undefined ? '' : `; the first expires on ${next}`}\n`);
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  process.exitCode = main(process.argv.slice(2));
}
