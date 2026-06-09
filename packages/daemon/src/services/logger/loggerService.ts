/**
 * `PinoLogger` — implementation of `ILogService`.
 */

import { Disposable } from '@moonshot-ai/agent-core';

import type { DaemonLogger } from '../../logger';
import { ILogService } from './logger';

/**
 * Adapter that satisfies `ILogService` by delegating to a `DaemonLogger` (pino).
 * No-op `dispose()`: pino's lifetime is managed by Fastify / the host process,
 * NOT by the DI container. Disposing here would close stdout writer streams
 * that other components still need during teardown.
 */
export class PinoLogger extends Disposable implements ILogService {
  readonly _serviceBrand: undefined;

  constructor(private readonly logger: DaemonLogger) {
    super();
  }

  info(obj: object | string, msg?: string): void {
    if (typeof obj === 'string') {
      this.logger.info(obj);
      return;
    }
    this.logger.info(obj, msg);
  }
  warn(obj: object | string, msg?: string): void {
    if (typeof obj === 'string') {
      this.logger.warn(obj);
      return;
    }
    this.logger.warn(obj, msg);
  }
  error(obj: object | string, msg?: string): void {
    if (typeof obj === 'string') {
      this.logger.error(obj);
      return;
    }
    this.logger.error(obj, msg);
  }
  debug(obj: object | string, msg?: string): void {
    if (typeof obj === 'string') {
      this.logger.debug(obj);
      return;
    }
    this.logger.debug(obj, msg);
  }
  child(bindings: object): ILogService {
    return new PinoLogger(this.logger.child(bindings));
  }
}
