

import { createDecorator } from '../../di';

export interface ILogService {
  readonly _serviceBrand: undefined;

  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
  debug(obj: object | string, msg?: string): void;

  child(bindings: object): ILogService;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const ILogService = createDecorator<ILogService>('logService');
