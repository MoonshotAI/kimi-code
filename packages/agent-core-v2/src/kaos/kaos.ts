import type { Kaos } from '@moonshot-ai/kaos';

import { createDecorator } from '#/_base/di/instantiation';

export interface IKaosService {
  readonly _serviceBrand: undefined;
  readonly kaos: Kaos | undefined;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IKaosService = createDecorator<IKaosService>('agentKaosService');

export type KaosFactoryOptions =
  | { readonly kind: 'local'; readonly cwd?: string }
  | { readonly kind: 'ssh'; readonly host: string; readonly cwd?: string };

export interface IKaosFactory {
  readonly _serviceBrand: undefined;
  create(options: KaosFactoryOptions): Promise<Kaos>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IKaosFactory = createDecorator<IKaosFactory>('kaosFactory');

export interface ISessionKaosService {
  readonly _serviceBrand: undefined;
  readonly toolKaos: Kaos;
  readonly persistenceKaos: Kaos;
  readonly systemContextKaos: Kaos;
  readonly additionalDirs: readonly string[];
  setToolKaos(kaos: Kaos): void;
  setPersistenceKaos(kaos: Kaos): void;
  addAdditionalDir(dir: string): void;
  removeAdditionalDir(dir: string): void;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const ISessionKaosService = createDecorator<ISessionKaosService>('sessionKaosService');
