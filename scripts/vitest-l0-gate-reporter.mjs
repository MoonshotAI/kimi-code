import { protectedCases } from './protected-smoke.ts';
import { executionsOf, gateErrors } from './vitest-smoke-reporter.mjs';

export default class L0GateReporter {
  onTestRunEnd(modules) {
    const executions = executionsOf(modules);
    const errors = gateErrors(executions, 'all');
    if (errors.length) {
      process.stderr.write(['✗ L0 gate: protected tests are missing or did not pass on their first attempt', ...errors].join('\n') + '\n');
      process.exitCode = 1;
      return;
    }
    const count = protectedCases().filter(entry => entry.runner === 'vitest').length;
    process.stdout.write(`✓ L0 gate: all ${count} protected Vitest tests passed on their first attempt in ${executions.length} merged results. Other failures are reported by the test jobs.\n`);
    process.exitCode = 0;
  }
}
