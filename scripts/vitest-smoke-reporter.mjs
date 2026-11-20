import { checkProtectedExecutions, gateScope } from './protected-smoke.ts';

export function executionsOf(modules) {
  const executions = [];
  for (const module of modules) {
    for (const test of module.children.allTests()) {
      const status = test.result().state;
      const retries = test.diagnostic()?.retryCount ?? 0;
      executions.push({
        title: test.name,
        file: module.moduleId,
        project: module.project.name,
        status: retries ? `${status} (retry count=${retries})` : status,
        passed: status === 'passed' && retries === 0 && !test.options.fails,
        tags: test.tags,
      });
    }
  }
  return executions;
}

export function gateErrors(executions, scope) {
  return executions.length === 0
    ? ['No Vitest results reached the L0 gate; every protected test counts as missing.']
    : checkProtectedExecutions('vitest', executions, { scope });
}

export default class ProtectedTestsReporter {
  onTestRunEnd(modules) {
    const errors = gateErrors(executionsOf(modules), gateScope());
    if (errors.length) {
      process.stderr.write(errors.join('\n') + '\n');
      process.exitCode = 1;
    }
  }
}
