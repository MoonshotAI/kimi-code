#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

import {
  defaultReportDir,
  recordReportEvent,
  resetReportDir,
  writeHtmlReport,
} from '../src/report.js';

const packageRoot = resolve(import.meta.dirname, '..');
const scenariosDir = join(packageRoot, 'scenarios');
const tsxBin = process.platform === 'win32' ? 'tsx.cmd' : 'tsx';

async function main(): Promise<void> {
  const reportDir = defaultReportDir();
  resetReportDir(reportDir);

  const scenarios = readdirSync(scenariosDir)
    .filter((file) => file.endsWith('.ts'))
    .toSorted();

  let failed = false;
  for (const file of scenarios) {
    const caseName = file.slice(0, -'.ts'.length);
    const scenarioPath = join('scenarios', file);
    process.stdout.write(`▶ ${scenarioPath}\n`);
    recordReportEvent(
      { kind: 'log', caseName, label: 'scenario started', value: { file: scenarioPath } },
      { reportDir },
    );

    const result = await runScenario(file, caseName, reportDir);
    recordReportEvent(
      {
        kind: 'test-result',
        caseName,
        state: result.exitCode === 0 ? 'passed' : 'failed',
        error: result.exitCode === 0 ? undefined : { exitCode: result.exitCode },
      },
      { reportDir },
    );
    if (result.exitCode !== 0) {
      failed = true;
      break;
    }
  }

  const htmlPath = writeHtmlReport({
    reportDir,
    title: `daemon-e2e scenarios (${failed ? 'failed' : 'passed'})`,
  });
  process.stdout.write(`[daemon-e2e] HTML report: ${htmlPath}\n`);
  if (failed) process.exit(1);
}

async function runScenario(
  file: string,
  caseName: string,
  reportDir: string,
): Promise<{ exitCode: number }> {
  const child = spawn(tsxBin, [join('scenarios', file)], {
    cwd: packageRoot,
    env: {
      ...process.env,
      DAEMON_E2E_CASE_NAME: caseName,
      DAEMON_E2E_REPORT_DIR: reportDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  captureLines(child.stdout, caseName, 'stdout', reportDir);
  captureLines(child.stderr, caseName, 'stderr', reportDir);

  return new Promise((resolveScenario) => {
    child.on('error', (error) => {
      recordReportEvent(
        {
          kind: 'log',
          caseName,
          label: 'spawn error',
          value: { name: error.name, message: error.message },
        },
        { reportDir },
      );
      resolveScenario({ exitCode: 1 });
    });
    child.on('close', (code) => {
      resolveScenario({ exitCode: code ?? 1 });
    });
  });
}

function captureLines(
  stream: NodeJS.ReadableStream,
  caseName: string,
  label: 'stdout' | 'stderr',
  reportDir: string,
): void {
  const lines = createInterface({ input: stream });
  lines.on('line', (line) => {
    const output = label === 'stderr' ? process.stderr : process.stdout;
    output.write(`${line}\n`);
    recordReportEvent({ kind: 'log', caseName, label, value: line }, { reportDir });
  });
}

try {
  await main();
} catch (error) {
  recordReportEvent({
    kind: 'test-result',
    caseName: 'scenario runner',
    state: 'failed',
    error: error instanceof Error ? { name: error.name, message: error.message } : error,
  });
  const htmlPath = writeHtmlReport({
    title: 'daemon-e2e scenarios (failed)',
  });
  process.stderr.write(`✗ scenario runner failed: ${String(error)}\n`);
  process.stderr.write(`[daemon-e2e] HTML report: ${htmlPath}\n`);
  process.exit(1);
}
