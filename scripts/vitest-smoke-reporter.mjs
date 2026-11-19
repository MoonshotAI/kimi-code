import { checkSmokeExecutions } from './protected-smoke.ts';

export default class SmokeReporter {
  onTestRunEnd(modules) {
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
          passed: status === 'passed' && retries === 0 && test.tags.includes('smoke') && !test.options.fails,
        });
      }
    }
    const errors = checkSmokeExecutions('vitest', executions);
    if (errors.length) {
      process.stderr.write(errors.join('\n') + '\n');
      process.exitCode = 1;
    }
  }
}
