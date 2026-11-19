import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { appendFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const reportsDir = join(root, '.tmp', 'mutation');
const CODE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const VITEST_CONFIGS = ['vitest.config.ts', 'vitest.config.mts', 'vitest.config.js', 'vitest.config.mjs'];
const STATUS_COLUMNS = ['Killed', 'Survived', 'NoCoverage', 'Timeout', 'RuntimeError', 'CompileError', 'Ignored'];
const LISTED_STATUSES = new Set(['Survived', 'NoCoverage']);
const MAX_LISTED = 100;
const BASELINE_START = 'One or more tests failed in the initial test run:';
const BASELINE_END = 'There were failed tests in the initial test run';

export function changedLines(diff) {
  const changes = new Map();
  let file;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line.startsWith('+++ b/') ? line.slice('+++ b/'.length) : undefined;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk || file === undefined) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count === 0) continue;
    const ranges = changes.get(file) ?? [];
    const last = ranges.at(-1);
    if (last !== undefined && last[1] + 1 >= start) last[1] = Math.max(last[1], start + count - 1);
    else ranges.push([start, start + count - 1]);
    changes.set(file, ranges);
  }
  return changes;
}

export function mutationTargets(changes, exists = path => existsSync(join(root, path))) {
  const packages = new Map();
  const skipped = [];
  for (const [file, ranges] of changes) {
    if (!CODE_FILE.test(file) || file.endsWith('.d.ts')) continue;
    const packageDir = packageOf(file, exists);
    if (packageDir === undefined) continue;
    const inPackage = file.slice(packageDir.length + 1);
    if (!inPackage.startsWith('src/')) continue;
    const config = VITEST_CONFIGS.find(name => exists(`${packageDir}/${name}`));
    if (config === undefined) {
      skipped.push({ subject: file, reason: `${packageDir} has no Vitest config, so nothing runs its tests under Stryker` });
      continue;
    }
    const target = packages.get(packageDir) ?? { config, mutate: [] };
    target.mutate.push(...ranges.map(([start, end]) => `${inPackage}:${start}-${end}`));
    packages.set(packageDir, target);
  }
  return { packages, skipped };
}

function packageOf(file, exists) {
  for (let dir = posix.dirname(file); dir !== '.'; dir = posix.dirname(dir)) {
    if (exists(`${dir}/package.json`)) return dir;
  }
  return undefined;
}

export function strykerConfig(target, reportBase, { vitestRunner, includeStatic = false }) {
  return {
    plugins: [vitestRunner],
    testRunner: 'vitest',
    vitest: { configFile: target.config, related: true },
    coverageAnalysis: 'perTest',
    inPlace: true,
    ignoreStatic: !includeStatic,
    mutate: target.mutate,
    reporters: ['progress-append-only', 'json', 'html'],
    jsonReporter: { fileName: `${reportBase}.json` },
    htmlReporter: { fileName: `${reportBase}.html` },
    thresholds: { high: 80, low: 60, break: null },
  };
}

export function baselineFailures(log) {
  const lines = log.replace(/\u001b\[[0-9;]*m/g, '').split('\n');
  const start = lines.findIndex(line => line.includes(BASELINE_START));
  if (start === -1) return [];
  const failures = [];
  for (const line of lines.slice(start + 1)) {
    if (line.includes(BASELINE_END)) break;
    if (line.startsWith('\t\t')) failures.at(-1)?.details.push(line.trim());
    else if (line.startsWith('\t')) failures.push({ test: line.trim(), details: [] });
  }
  return failures;
}

export function summarize({ base, results, skipped }) {
  const lines = [
    '## Mutation testing on changed lines',
    '',
    `Compared with \`${base}\`. Each listed mutant is a small change to a changed line that no related test noticed. Treat it as review information, not as a failure.`,
    '',
  ];
  const ran = results.filter(result => result.report !== undefined);
  if (ran.length > 0) {
    lines.push(`| Package | ${STATUS_COLUMNS.join(' | ')} |`, `|---|${STATUS_COLUMNS.map(() => '---').join('|')}|`);
    for (const result of ran) {
      const counts = Object.fromEntries(STATUS_COLUMNS.map(status => [status, 0]));
      for (const mutant of mutantsOf(result)) counts[mutant.status] = (counts[mutant.status] ?? 0) + 1;
      lines.push(`| ${result.packageDir} | ${STATUS_COLUMNS.map(status => counts[status]).join(' | ')} |`);
    }
    lines.push('');
  }
  for (const result of ran) {
    const listed = mutantsOf(result).filter(mutant => LISTED_STATUSES.has(mutant.status));
    if (listed.length === 0) continue;
    lines.push(`### ${result.packageDir}`, '');
    for (const mutant of listed.slice(0, MAX_LISTED)) {
      const verdict = mutant.status === 'Survived' ? 'survived' : 'no related test runs this line';
      lines.push(`- \`${mutant.file}:${mutant.location.start.line}\` ${mutant.mutatorName}, ${verdict}: \`${snippet(mutant.original)}\` → \`${snippet(mutant.replacement)}\``);
    }
    if (listed.length > MAX_LISTED) lines.push(`- …and ${listed.length - MAX_LISTED} more in the HTML report.`);
    lines.push('');
  }
  const notRun = [
    ...results.filter(result => result.baseline !== undefined).map(result => [
      `- ${result.packageDir}: these related tests fail under Stryker before any mutation. Stryker runs Vitest in one worker thread, so a test that changes process-wide state such as \`HOME\` or the working directory can fail there:`,
      ...result.baseline.map(failure => `  - ${failure.test}${failure.details.length > 0 ? ` (${failure.details[0]})` : ''}`),
    ].join('\n')),
    ...results.filter(result => result.error !== undefined).map(result => `- ${result.packageDir}: ${result.error}`),
    ...skipped.map(entry => `- ${entry.subject}: ${entry.reason}`),
  ];
  if (notRun.length > 0) lines.push('### Not mutated', '', ...notRun, '');
  if (results.length === 0 && skipped.length === 0) lines.push('No changed lines under a package `src` directory.', '');
  return lines.join('\n');
}

function mutantsOf(result) {
  return Object.entries(result.report.files).flatMap(([file, entry]) => {
    const source = entry.source.split('\n');
    return entry.mutants.map(mutant => ({ ...mutant, file: `${result.packageDir}/${file}`, original: textAt(source, mutant.location) }));
  }).toSorted((a, b) => a.file.localeCompare(b.file) || a.location.start.line - b.location.start.line || a.location.start.column - b.location.start.column);
}

function textAt(source, { start, end }) {
  const first = source[start.line - 1] ?? '';
  return start.line === end.line ? first.slice(start.column - 1, end.column - 1) : `${first.slice(start.column - 1)} …`;
}

function snippet(text) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return (flat.length > 80 ? `${flat.slice(0, 79)}…` : flat).replaceAll('`', 'ˋ');
}

function git(args) {
  const run = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr.trim()}`);
  return run.stdout;
}

function runStryker(checkout, packageDir, configPath, logPath) {
  const strykerBin = join(createRequire(join(checkout, 'package.json')).resolve('@stryker-mutator/core/package.json'), '..', 'bin', 'stryker.js');
  return new Promise((resolve, reject) => {
    const log = createWriteStream(logPath);
    const child = spawn(process.execPath, [strykerBin, 'run', configPath], { cwd: join(checkout, packageDir), stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { log.write(chunk); process.stdout.write(chunk); });
    child.stderr.on('data', chunk => { log.write(chunk); process.stderr.write(chunk); });
    child.on('error', reject);
    child.on('close', code => log.end(() => resolve(code)));
  });
}

function resultOf(packageDir, code, reportBase) {
  if (existsSync(`${reportBase}.json`)) return { packageDir, report: JSON.parse(readFileSync(`${reportBase}.json`, 'utf8')) };
  const failures = baselineFailures(readFileSync(`${reportBase}.log`, 'utf8'));
  if (failures.length > 0) return { packageDir, baseline: failures };
  return { packageDir, error: `Stryker exited with code ${code} before writing a report; see ${displayPath(`${reportBase}.log`)}` };
}

function displayPath(path) {
  return relative(root, path).split(sep).join('/');
}

function installDependencies(checkout) {
  const pnpm = process.env.npm_execpath ? [process.execPath, process.env.npm_execpath] : ['pnpm'];
  const run = spawnSync(pnpm[0], [...pnpm.slice(1), 'install', '--frozen-lockfile', '--offline', '--ignore-scripts'], {
    cwd: checkout, stdio: 'inherit', shell: pnpm.length === 1 && process.platform === 'win32',
  });
  if (run.status !== 0) throw new Error('Could not install dependencies offline in the mutation checkout; run pnpm install first');
}

async function main() {
  const { values } = parseArgs({
    options: {
      base: { type: 'string', default: 'origin/main' },
      'include-static': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      keep: { type: 'boolean', default: false },
    },
  });
  const base = git(['merge-base', values.base, 'HEAD']).trim();
  const diff = git(['diff', '--unified=0', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', '--diff-filter=ACMR', base, 'HEAD']);
  const { packages, skipped } = mutationTargets(changedLines(diff));
  for (const [packageDir, target] of packages) process.stdout.write(`${packageDir}: ${target.mutate.join(' ')}\n`);
  if (values['dry-run']) return 0;
  rmSync(reportsDir, { recursive: true, force: true });
  mkdirSync(reportsDir, { recursive: true });
  const results = [];
  if (packages.size > 0) {
    const holder = mkdtempSync(join(tmpdir(), 'kimi-mutation-'));
    const checkout = join(holder, 'checkout');
    const cleanUp = () => {
      if (values.keep) return;
      spawnSync('git', ['worktree', 'remove', '--force', checkout], { cwd: root });
      rmSync(holder, { recursive: true, force: true });
    };
    const interrupted = () => { cleanUp(); process.exit(130); };
    process.once('SIGINT', interrupted);
    try {
      git(['worktree', 'add', '--detach', checkout, 'HEAD']);
      installDependencies(checkout);
      const vitestRunner = createRequire(join(checkout, 'package.json')).resolve('@stryker-mutator/vitest-runner');
      for (const [packageDir, target] of packages) {
        const reportBase = join(reportsDir, packageDir.replaceAll('/', '-'));
        writeFileSync(`${reportBase}.stryker.json`, JSON.stringify(strykerConfig(target, reportBase, { vitestRunner, includeStatic: values['include-static'] }), null, 2));
        const code = await runStryker(checkout, packageDir, `${reportBase}.stryker.json`, `${reportBase}.log`);
        results.push(resultOf(packageDir, code, reportBase));
      }
    } finally {
      process.off('SIGINT', interrupted);
      cleanUp();
      if (values.keep) process.stdout.write(`Kept the mutation checkout at ${checkout}\n`);
    }
  }
  const summary = summarize({ base: base.slice(0, 12), results, skipped });
  writeFileSync(join(reportsDir, 'summary.md'), summary);
  process.stdout.write(`\n${summary}\nReports: ${displayPath(reportsDir)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  return results.some(result => result.error !== undefined) ? 1 : 0;
}

if (import.meta.main) process.exitCode = await main();
