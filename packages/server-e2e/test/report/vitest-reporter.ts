import { join, resolve } from 'node:path';

import type { Reporter, TestRunEndReason } from 'vitest/reporters';

import {
  recordReportEvent,
  resetReportDir,
  writeHtmlReport,
} from '../../src/report.js';

export default class DaemonE2eHtmlReporter implements Reporter {
  onTestRunStart(): void {
    resetReportDir(vitestReportDir());
  }

  onTestRunEnd(
    _testModules: Parameters<NonNullable<Reporter['onTestRunEnd']>>[0],
    unhandledErrors: Parameters<NonNullable<Reporter['onTestRunEnd']>>[1],
    reason: TestRunEndReason,
  ): void {
    const reportDir = vitestReportDir();
    if (unhandledErrors.length > 0) {
      recordReportEvent(
        {
          kind: 'test-result',
          caseName: 'run',
          state: 'failed',
          error: unhandledErrors,
        },
        { reportDir },
      );
    }
    const htmlPath = writeHtmlReport({
      reportDir,
      title: `server-e2e report (${reason})`,
    });
    process.stdout.write(`[server-e2e] HTML report: ${htmlPath}\n`);
  }
}

function vitestReportDir(): string {
  return resolve(process.env['KIMI_SERVER_E2E_REPORT_DIR'] ?? join(process.cwd(), 'reports', 'vitest', 'latest'));
}
