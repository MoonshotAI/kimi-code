import { onTestFailed, onTestFinished } from 'vitest';

import { recordReportEvent, setActiveReportCase } from '../src/report.js';

export function createCaseLogger(caseName: string): (label: string, value?: unknown) => void {
  setActiveReportCase(caseName);
  let failed = false;
  onTestFailed((error) => {
    failed = true;
    recordReportEvent({
      kind: 'test-result',
      caseName,
      state: 'failed',
      error: errorForLog(error),
    });
  });
  onTestFinished(() => {
    if (failed) return;
    recordReportEvent({
      kind: 'test-result',
      caseName,
      state: 'passed',
    });
  });
  return (label, value) => {
    recordReportEvent({ kind: 'log', caseName, label, value });
    const prefix = `[daemon-e2e] ${caseName} :: ${label}`;
    if (value === undefined) {
      writeLogLine(prefix);
      return;
    }
    writeLogLine(`${prefix}\n${stringifyForLog(value)}`);
  };
}

export function errorForLog(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...objectFields(error),
    };
  }
  return error;
}

function objectFields(value: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  );
}

function stringifyForLog(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function writeLogLine(line: string): void {
  process.stdout.write(`${line}\n`);
}
