import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';

import { checkSmokeExecutions, type SmokeExecution } from '../../../../scripts/protected-smoke.ts';

export default class DesktopSmokeReporter implements Reporter {
  private readonly executions = new Map<TestCase, SmokeExecution>();

  onTestEnd(test: TestCase, result: TestResult): void {
    if (test.parent.project()?.name !== 'smoke') return;
    this.executions.set(test, {
      title: test.title,
      file: test.location.file,
      project: 'smoke',
      status: result.retry ? `${result.status} (retry count=${result.retry})` : result.status,
      passed: result.status === 'passed' && result.retry === 0 && test.expectedStatus === 'passed' && test.tags.includes('@smoke'),
    });
  }

  async onEnd(): Promise<{ status: 'failed' } | void> {
    const executions = [...this.executions.values()];
    const errors = process.env['KIMI_E2E_PROTECTED'] === '1'
      ? checkSmokeExecutions('playwright', executions)
      : [];
    if (executions.length && !executions.some(test => test.passed)) errors.push('No passing Electron smoke in the selected tests.');
    if (errors.length) {
      process.stderr.write(errors.join('\n') + '\n');
      return { status: 'failed' };
    }
  }
}
