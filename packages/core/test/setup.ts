import { afterEach, beforeEach, type TestContext } from 'vitest';
import pino from 'pino';

import { setClock } from '#/utils/clock';
import { setLog, type LogArgs, type LogImpl } from '#/utils/log';
import { setNow } from '#/utils/now';

const verbose = process.env['KIMI_CODE_TEST_VERBOSE'];
const envVerbose = verbose !== undefined && verbose !== '' && verbose !== '0';

const logger = pino({ level: envVerbose ? 'debug' : 'silent' });
const viaPino = (level: 'debug' | 'info' | 'warn' | 'error') => (...args: LogArgs): void => {
  if (args.length === 1) logger[level](args[0]);
  else logger[level](args[0], args[1]);
};
const injectedLog: LogImpl = {
  debug: viaPino('debug'),
  info: viaPino('info'),
  warn: viaPino('warn'),
  error: viaPino('error'),
};

const isRetry = (context: TestContext): boolean => (context.task.result?.retryCount ?? 0) > 0;

beforeEach((context) => {
  logger.level = envVerbose || isRetry(context) ? 'debug' : 'silent';
  setLog(injectedLog);
});

afterEach((context) => {
  setLog();
  setNow();
  setClock();
  if (isRetry(context) && context.task.result?.state === 'pass') {
    throw new Error(
      `"${context.task.name}" failed and then passed on retry, so it is flaky. Find the cause instead of relying on the retry; the retried attempt above ran with debug logs.`,
    );
  }
});
