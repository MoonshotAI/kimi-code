/**
 * `ILogService` DI surface.
 *
 * Thin interface over the pino logger so consumer services don't take a
 * direct dependency on the `pino` package. The daemon registers a
 * `PinoLogger` adapter that delegates to the `DaemonLogger` (pino) instance
 * Fastify shares with us at boot.
 *
 * Registered FIRST in the DI container (= constructed first when consumers
 * dispatch `accessor.get(ILogService)`) so it disposes LAST in the
 * reverse-construction-order teardown chain. Other
 * services log on their own `dispose()`; if the logger went first they'd NPE.
 */

import { Disposable, createDecorator } from '@moonshot-ai/agent-core';

import type { DaemonLogger } from '../../logger';

export interface ILogService {
  readonly _serviceBrand: undefined;

  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
  debug(obj: object | string, msg?: string): void;
  /** Pino-style child logger that inherits parent bindings. */
  child(bindings: object): ILogService;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const ILogService = createDecorator<ILogService>('logService');


