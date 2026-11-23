import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';

import { checkProtectedExecutions, gateScope, type ProtectedExecution } from '../../../../scripts/protected-smoke.ts';

export default class DesktopSmokeReporter implements Reporter {
  private readonly executions = new Map<TestCase, ProtectedExecution>();

  onTestEnd(test: TestCase, result: TestResult): void {
    this.executions.set(test, {
      title: test.title,
      file: test.location.file,
      project: test.parent.project()?.name ?? '',
      status: result.retry ? `${result.status} (retry count=${result.retry})` : result.status,
      passed: result.status === 'passed' && result.retry === 0 && test.expectedStatus === 'passed',
      tags: test.tags,
    });
  }

  async onEnd(): Promise<{ status: 'failed' } | void> {
    const executions = [...this.executions.values()];
    const errors = process.env['KIMI_E2E_PROTECTED'] === '1'
      ? checkProtectedExecutions('playwright', executions, { scope: gateScope() })
      : [];
    const smoke = executions.filter(test => test.project === 'smoke');
    if (smoke.length && !smoke.some(test => test.passed)) errors.push('No passing Electron smoke in the selected tests.');
    if (errors.length) {
      process.stderr.write(errors.join('\n') + '\n');
      return { status: 'failed' };
    }
  }
}
