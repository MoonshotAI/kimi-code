import type { Kaos } from '@moonshot-ai/kaos';

import { registerSingleton, SyncDescriptor } from '../../../di';
import { IKaosService } from './kaos';

export interface KaosServiceOptions {
  readonly kaos?: Kaos;
}

export class KaosService implements IKaosService {
  declare readonly _serviceBrand: undefined;

  constructor(private readonly options: KaosServiceOptions = {}) {}

  get kaos(): Kaos | undefined {
    return this.options.kaos;
  }
}

registerSingleton(IKaosService, new SyncDescriptor(KaosService, [], true));
