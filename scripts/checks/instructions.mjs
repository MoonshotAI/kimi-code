#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const CHECK_FILE = 'scripts/checks/instructions.mjs';
const CONFIG_FILE = 'scripts/checks/instructions.json';
const OPENING_FENCE = /^ {0,3}(`{3,}|~{3,})/;
const CLOSING_FENCE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const CODE_SPAN = /(`+)([\s\S]*?[^`])\1(?!`)/g;
const LINK = /\]\(\s*(<[^>\n]*>|[^)\s]+)/g;
const SCHEME = /^[a-z][\w+.-]*:/i;
const NOT_A_PATH = /[\s*<>{}|…$()=]|^[@#/~-]/;
const LOCATION_SUFFIX = /(?::\d+(?:-\d+)?|#L\d+(?:-L?\d+)?)$/;

function linkTarget(raw) {
  const unwrapped = raw.startsWith('<') ? raw.slice(1, -1) : raw;
  const path = unwrapped.split(/[?#]/)[0].replace(/\/+$/, '');
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

export function referencesIn(text) {
  const references = [];
  let fence;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (fence !== undefined) {
      const closing = CLOSING_FENCE.exec(line);
      if (closing !== null && closing[1][0] === fence[0] && closing[1].length >= fence.length) fence = undefined;
      continue;
    }
    const opening = OPENING_FENCE.exec(line);
    if (opening !== null) {
      fence = opening[1];
      continue;
    }
    const spans = [];
    const prose = line.replace(CODE_SPAN, (span, _ticks, content) => {
      spans.push(content.trim());
      return ' '.repeat(span.length);
    });
    for (const match of prose.matchAll(LINK)) {
      const target = linkTarget(match[1]);
      if (target !== '' && !SCHEME.test(target)) references.push({ line: index + 1, kind: 'link', value: target });
    }
    for (const span of spans) {
      const value = span.replace(LOCATION_SUFFIX, '').replace(/\/+$/, '');
      if (value.includes('/') && !NOT_A_PATH.test(value) && !SCHEME.test(value)) {
        references.push({ line: index + 1, kind: 'path', value });
      }
    }
  }
  return references;
}

function ancestorsOf(directory) {
  const ancestors = [directory];
  let current = directory;
  while (current !== '.') {
    current = dirname(current);
    ancestors.push(current);
  }
  return ancestors;
}

export function resolveReference(file, reference, exists) {
  const directory = dirname(file);
  if (reference.kind === 'link') return exists(normalize(join(directory, reference.value))) ? 'found' : 'missing';
  const first = reference.value.split('/')[0];
  const bases = ancestorsOf(directory).filter((base) => exists(join(base, first)));
  if (bases.length === 0) return 'skipped';
  return bases.some((base) => exists(join(base, reference.value))) ? 'found' : 'missing';
}

export function invalidEntries(entries) {
  return entries.filter(
    (entry) =>
      typeof entry?.file !== 'string' ||
      typeof entry.reference !== 'string' ||
      typeof entry.why !== 'string' ||
      entry.why.trim() === '',
  );
}

export function applyAllowlist(missing, entries) {
  const matches = (entry, reference) => entry.file === reference.file && entry.reference === reference.value;
  return {
    unexplained: missing.filter((reference) => !entries.some((entry) => matches(entry, reference))),
    unused: entries.filter((entry) => !missing.some((reference) => matches(entry, reference))),
  };
}

export function checkBudgets(budgets, sizeOf) {
  return Object.entries(budgets)
    .map(([file, limit]) => ({ file, limit, size: sizeOf(file) }))
    .filter((entry) => entry.size === undefined || entry.size > entry.limit);
}

export function entriesOf(files) {
  const entries = new Set(['.']);
  for (const file of files) {
    let current = file;
    while (current !== '.' && !entries.has(current)) {
      entries.add(current);
      current = dirname(current);
    }
  }
  return entries;
}

function listRepoFiles() {
  const result = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`git ls-files exited with ${result.status}: ${result.stderr}`);
  return result.stdout.split('\0').filter((file) => file !== '' && existsSync(join(ROOT, file)));
}

function sizeOf(file) {
  const path = join(ROOT, file);
  return existsSync(path) ? statSync(path).size : undefined;
}

function formatReport({ invalid, unexplained, unused, overBudget }) {
  const lines = [];
  if (invalid.length > 0) {
    lines.push(
      `✗ instructions: ${invalid.length} unresolved entr${invalid.length === 1 ? 'y' : 'ies'} in ${CONFIG_FILE} lack a file, a reference or a reason`,
      ...invalid.map((entry) => `    ${JSON.stringify(entry)}`),
      '  Why: an entry without a reason cannot be reviewed, and nobody can tell later whether it still applies.',
      '  What to do: give every entry a "file", the exact "reference" text and a non-empty "why".',
    );
  }
  if (unexplained.length > 0) {
    lines.push(
      `✗ instructions: ${unexplained.length} reference(s) in AGENTS.md files point to nothing`,
      ...unexplained.map((reference) => `    ${reference.file}:${reference.line}  ${reference.value}`),
      '  Why: agents follow these paths and links; a dead one sends them to a file that does not exist.',
      `  What to do: fix the path. If it names something outside this repository or a build output, add it to the unresolved list in ${CONFIG_FILE} with the reason.`,
    );
  }
  if (unused.length > 0) {
    lines.push(
      `✗ instructions: ${unused.length} unresolved entr${unused.length === 1 ? 'y' : 'ies'} in ${CONFIG_FILE} match no reference`,
      ...unused.map((entry) => `    ${entry.file}  ${entry.reference}`),
      '  Why: a stale entry would let the next dead reference with the same text pass unnoticed.',
      `  What to do: delete the entry from ${CONFIG_FILE}.`,
    );
  }
  for (const entry of overBudget) {
    if (entry.size === undefined) {
      lines.push(
        `✗ instructions: ${entry.file} has a budget in ${CONFIG_FILE} but does not exist`,
        `  What to do: fix the file name, or delete the budget if the file was removed on purpose.`,
      );
      continue;
    }
    lines.push(
      `✗ instructions: ${entry.file} is ${entry.size} bytes, over its ${entry.limit}-byte budget`,
      '  Why: every agent session loads this file, and agent loaders warn or truncate once instructions pass 32 KiB.',
      `  What to do: move content that only one directory needs into that directory's AGENTS.md, then condense. Raise the budget in ${CONFIG_FILE} only if the words need the space, and give the reason in the PR.`,
    );
  }
  return lines;
}

export function main(args) {
  if (args.length > 0) {
    process.stderr.write(`✗ instructions: unsupported arguments ${args.join(' ')}. Run \`node ${CHECK_FILE}\`.\n`);
    return 2;
  }
  let config;
  try {
    config = JSON.parse(readFileSync(join(ROOT, CONFIG_FILE), 'utf8'));
  } catch (error) {
    process.stderr.write(`✗ instructions: could not read ${CONFIG_FILE}. ${error.message}\n`);
    return 1;
  }
  let repoFiles;
  try {
    repoFiles = listRepoFiles();
  } catch (error) {
    process.stderr.write(`✗ instructions: could not list repository files. ${error.message}\n`);
    return 1;
  }
  const entries = entriesOf(repoFiles);
  const exists = (path) => entries.has(normalize(path));
  const files = repoFiles.filter((file) => basename(file) === 'AGENTS.md').toSorted();
  const unresolved = config.unresolved ?? [];
  const missing = [];
  let resolved = 0;
  for (const file of files) {
    for (const reference of referencesIn(readFileSync(join(ROOT, file), 'utf8'))) {
      const result = resolveReference(file, reference, exists);
      if (result === 'found') resolved += 1;
      if (result === 'missing') missing.push({ file, ...reference });
    }
  }
  const { unexplained, unused } = applyAllowlist(missing, unresolved);
  const overBudget = checkBudgets(config.budgets ?? {}, sizeOf);
  const report = formatReport({ invalid: invalidEntries(unresolved), unexplained, unused, overBudget });
  if (report.length > 0) {
    process.stderr.write(`${report.join('\n')}\n`);
    return 1;
  }
  const budgets = Object.entries(config.budgets ?? {})
    .map(([file, limit]) => `${file} ${sizeOf(file)}/${limit} bytes`)
    .join(', ');
  process.stdout.write(
    `✓ instructions: ${files.length} AGENTS.md files, ${resolved} references resolve, ${missing.length} listed as unresolved${budgets === '' ? '' : `; ${budgets}`}\n`,
  );
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  process.exitCode = main(process.argv.slice(2));
}
