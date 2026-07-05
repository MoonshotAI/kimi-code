import pino from 'pino';
import type { Config } from './config.js';

/**
 * Factory for the application logger.
 */

export function createLogger(config: Config) {
  return pino({
    level: config.logLevel,
  });
}
