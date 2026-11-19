import { afterEach, beforeEach } from 'vitest';
import pino from 'pino';

import { setClock } from '#/utils/clock';
import { setLog, type LogArgs, type LogImpl } from '#/utils/log';
import { setNow } from '#/utils/now';

const verbose = process.env['KIMI_CODE_TEST_VERBOSE'];
const envVerbose = verbose !== undefined && verbose !== '' && verbose !== '0';

const logger = pino({ level: envVerbose ? 'debug' : 'info' });
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

beforeEach((context) => {
  const retried = (context.task.result?.retryCount ?? 0) > 0;
  logger.level = envVerbose || retried ? 'debug' : 'info';
  setLog(injectedLog);
});

afterEach(() => {
  setLog();
  setNow();
  setClock();
});
