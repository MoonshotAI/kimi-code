import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { appendFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { basename, dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const reportsDir = join(root, '.tmp', 'mutation');
const CODE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const TEST_FILE = /(?:^|\/)__tests__\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const ESCAPES = { n: '\n', t: '\t', '"': '"', '\\': '\\' };
const CLEANUP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const VITEST_CONFIGS = ['vitest.config.ts', 'vitest.config.mts', 'vitest.config.js', 'vitest.config.mjs'];
const STATUS_COLUMNS = ['Killed', 'Survived', 'NoCoverage', 'Timeout', 'RuntimeError', 'CompileError', 'Ignored'];
const LISTED_STATUSES = new Set(['Survived', 'NoCoverage']);
const MAX_LISTED = 100;
const BASELINE_START = 'One or more tests failed in the initial test run:';
const BASELINE_END = 'There were failed tests in the initial test run';
const NO_RELATED_TESTS = 'No tests were executed';
const PROCESS_CONTROL = /['"](?:node:)?child_process['"]|\bprocess\.kill\(|\bkillProcessTree\(|\bTestProcess\.start\(/;
const PROCESS_CONTROL_REASON = 'starts or stops operating-system processes. A mutant there can make a test signal the test runner\'s process group or every process of the user, or leak children until the machine runs out of memory, so it is not mutated';
const LEAK_SWEEP_MS = 30_000;

export function changedLines(diff) {
  const changes = new Map();
  let file;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = newPathOf(line);
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

function newPathOf(line) {
  const raw = line.slice('+++ '.length).replace(/\t$/, '');
  const path = raw.startsWith('"') ? unquote(raw) : raw;
  return path.startsWith('b/') ? path.slice('b/'.length) : undefined;
}

function unquote(quoted) {
  const bytes = [];
  for (let index = 1; index < quoted.length - 1; index += 1) {
    const octal = quoted[index] === '\\' ? /^[0-7]{3}/.exec(quoted.slice(index + 1)) : null;
    if (octal !== null) {
      bytes.push(Number.parseInt(octal[0], 8));
      index += 3;
    } else if (quoted[index] === '\\') {
      index += 1;
      bytes.push(...Buffer.from(ESCAPES[quoted[index]] ?? quoted[index]));
    } else {
      bytes.push(...Buffer.from(quoted[index]));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

export function mutationTargets(changes, exists = path => existsSync(join(root, path)), read = path => readFileSync(join(root, path), 'utf8')) {
  const packages = new Map();
  const skipped = [];
  for (const [file, ranges] of changes) {
    if (!CODE_FILE.test(file) || file.endsWith('.d.ts') || TEST_FILE.test(file)) continue;
    const packageDir = packageOf(file, exists);
    if (packageDir === undefined) continue;
    const inPackage = file.slice(packageDir.length + 1);
    if (!inPackage.startsWith('src/')) continue;
    const config = VITEST_CONFIGS.find(name => exists(`${packageDir}/${name}`));
    if (config === undefined) {
      skipped.push({ subject: file, reason: `${packageDir} has no Vitest config, so nothing runs its tests under Stryker` });
      continue;
    }
    if (PROCESS_CONTROL.test(read(file))) {
      skipped.push({ subject: file, reason: PROCESS_CONTROL_REASON });
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
    ...results.filter(result => result.untested === true).map(result => `- ${result.packageDir}: no Vitest test of this package imports the changed files, so a mistake on these lines would go unnoticed here.`),
    ...results.filter(result => result.error !== undefined).map(result => `- ${result.packageDir}: ${result.error}`),
    ...results.filter(result => result.stopped !== undefined).map(result => `- ${result.packageDir}: ${result.stopped}`),
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

function runStryker({ checkout, marker, packageDir, configPath, logPath, deadline }) {
  const strykerBin = join(createRequire(join(checkout, 'package.json')).resolve('@stryker-mutator/core/package.json'), '..', 'bin', 'stryker.js');
  return new Promise((resolve, reject) => {
    const log = createWriteStream(logPath);
    const child = spawn(process.execPath, [strykerBin, 'run', configPath], {
      cwd: join(checkout, packageDir),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let outOfTime = false;
    const sweep = setInterval(() => killProcesses(leakedProcesses(processTable(), marker, child.pid)), LEAK_SWEEP_MS);
    const timer = Number.isFinite(deadline)
      ? setTimeout(() => {
        outOfTime = true;
        killProcessGroup(child);
      }, Math.max(0, deadline - Date.now()))
      : undefined;
    const stop = () => {
      clearInterval(sweep);
      clearTimeout(timer);
    };
    child.stdout.on('data', chunk => { log.write(chunk); process.stdout.write(chunk); });
    child.stderr.on('data', chunk => { log.write(chunk); process.stderr.write(chunk); });
    child.on('error', error => {
      stop();
      reject(error);
    });
    child.on('close', code => {
      stop();
      killProcessGroup(child);
      killMarkedProcesses(marker);
      log.end(() => resolve({ code, outOfTime }));
    });
  });
}

export function leakedProcesses(table, marker, rootPid) {
  const marked = table.filter(entry => entry.command.includes(marker));
  const markedPids = new Set(marked.map(entry => entry.pid));
  return marked.filter(entry => entry.pid !== rootPid && !markedPids.has(entry.ppid)).map(entry => entry.pid);
}

export function parseProcessTable(text) {
  return text.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : [];
  });
}

function processTable() {
  if (process.platform === 'win32') return [];
  const run = spawnSync('ps', ['-Aww', '-o', 'pid=,ppid=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return run.status === 0 ? parseProcessTable(run.stdout) : [];
}

function killProcesses(pids) {
  for (const pid of pids) {
    if (pid <= 1 || pid === process.pid) continue;
    try { process.kill(pid, 'SIGKILL'); } catch { continue; }
  }
}

function killMarkedProcesses(marker) {
  killProcesses(processTable().filter(entry => entry.command.includes(marker)).map(entry => entry.pid));
}

function killProcessGroup(child) {
  if (child.pid === undefined || child.pid <= 1) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { return; }
}

export function runResult(packageDir, { code, report, log, logPath, outOfTime = false, budgetMinutes }) {
  if (report !== undefined) return { packageDir, report };
  if (outOfTime) return { packageDir, stopped: `stopped when the ${budgetMinutes}-minute budget ran out, before Stryker wrote a report` };
  const failures = baselineFailures(log);
  if (failures.length > 0) return { packageDir, baseline: failures };
  if (log.includes(NO_RELATED_TESTS)) return { packageDir, untested: true };
  return { packageDir, error: `Stryker exited with code ${code} before writing a report; see ${logPath}` };
}

function displayPath(path) {
  return relative(root, path).split(sep).join('/');
}

function pnpm(args, options) {
  return spawnSync('pnpm', args, { ...options, shell: process.platform === 'win32' });
}

function installDependencies(checkout) {
  const store = pnpm(['store', 'path'], { cwd: root, encoding: 'utf8' });
  if (store.status !== 0) throw new Error(`pnpm store path failed: ${store.stderr}`);
  const active = store.stdout.trim();
  const storeDir = /^v\d+$/.test(basename(active)) ? dirname(active) : active;
  const run = pnpm(['install', '--frozen-lockfile', '--offline', '--ignore-scripts', '--store-dir', storeDir], { cwd: checkout, stdio: 'inherit' });
  if (run.status !== 0) throw new Error('Could not install dependencies offline in the mutation checkout; run pnpm install first');
}

function removeCheckout(holder, checkout) {
  spawnSync('git', ['worktree', 'remove', '--force', checkout], { cwd: root });
  try {
    rmSync(holder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    process.stderr.write(`Could not remove the mutation checkout at ${holder}: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  spawnSync('git', ['worktree', 'prune'], { cwd: root });
}

async function main() {
  const { values } = parseArgs({
    options: {
      base: { type: 'string', default: 'origin/main' },
      'include-static': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      keep: { type: 'boolean', default: false },
      'budget-minutes': { type: 'string' },
    },
  });
  const budgetMinutes = values['budget-minutes'] === undefined ? undefined : Number(values['budget-minutes']);
  if (budgetMinutes !== undefined && !(budgetMinutes > 0 && budgetMinutes <= 24 * 60)) {
    throw new Error(`--budget-minutes needs a number of minutes between 0 and ${24 * 60}, got ${values['budget-minutes']}`);
  }
  const deadline = budgetMinutes === undefined ? Infinity : Date.now() + budgetMinutes * 60_000;
  const base = git(['merge-base', values.base, 'HEAD']).trim();
  const diff = git([
    '-c', 'core.quotePath=false', 'diff', '--unified=0', '--inter-hunk-context=0', '--no-color', '--no-ext-diff', '--no-textconv',
    '--src-prefix=a/', '--dst-prefix=b/', '--diff-filter=ACMR', base, 'HEAD',
  ]);
  const { packages, skipped } = mutationTargets(changedLines(diff));
  for (const [packageDir, target] of packages) process.stdout.write(`${packageDir}: ${target.mutate.join(' ')}\n`);
  if (values['dry-run']) return 0;
  rmSync(reportsDir, { recursive: true, force: true });
  mkdirSync(reportsDir, { recursive: true });
  const results = [];
  let failure;
  let cleanUp = () => {};
  if (packages.size > 0) {
    const holder = mkdtempSync(join(tmpdir(), 'kimi-mutation-'));
    const checkout = join(holder, 'checkout');
    const marker = basename(holder);
    cleanUp = () => {
      killMarkedProcesses(marker);
      if (values.keep) process.stdout.write(`Kept the mutation checkout at ${checkout}\n`);
      else removeCheckout(holder, checkout);
    };
    const onSignal = signal => {
      cleanUp();
      process.exit(128 + (constants.signals[signal] ?? 1));
    };
    for (const signal of CLEANUP_SIGNALS) process.once(signal, onSignal);
    try {
      git(['worktree', 'add', '--detach', checkout, 'HEAD']);
      installDependencies(checkout);
      const vitestRunner = createRequire(join(checkout, 'package.json')).resolve('@stryker-mutator/vitest-runner');
      for (const [packageDir, target] of packages) {
        if (Date.now() >= deadline) {
          results.push({ packageDir, stopped: `not mutated: the ${budgetMinutes}-minute budget ran out before this package` });
          continue;
        }
        const reportBase = join(reportsDir, packageDir.replaceAll('/', '-'));
        writeFileSync(`${reportBase}.stryker.json`, JSON.stringify(strykerConfig(target, reportBase, { vitestRunner, includeStatic: values['include-static'] }), null, 2));
        const logPath = `${reportBase}.log`;
        const { code, outOfTime } = await runStryker({ checkout, marker, packageDir, configPath: `${reportBase}.stryker.json`, logPath, deadline });
        results.push(runResult(packageDir, {
          code,
          outOfTime,
          budgetMinutes,
          report: existsSync(`${reportBase}.json`) ? JSON.parse(readFileSync(`${reportBase}.json`, 'utf8')) : undefined,
          log: readFileSync(logPath, 'utf8'),
          logPath: displayPath(logPath),
        }));
      }
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    } finally {
      for (const signal of CLEANUP_SIGNALS) process.off(signal, onSignal);
    }
    for (const packageDir of packages.keys()) {
      if (failure !== undefined && !results.some(result => result.packageDir === packageDir)) {
        results.push({ packageDir, error: `not mutated because the run stopped: ${failure.message}` });
      }
    }
  }
  publish(summarize({ base: base.slice(0, 12), results, skipped }));
  cleanUp();
  if (failure !== undefined) throw failure;
  return results.some(result => result.error !== undefined) ? 1 : 0;
}

function publish(summary) {
  writeFileSync(join(reportsDir, 'summary.md'), summary);
  process.stdout.write(`\n${summary}\nReports: ${displayPath(reportsDir)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}

if (import.meta.main) process.exitCode = await main();
