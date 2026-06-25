import type { Kaos } from '@moonshot-ai/kaos';

import { createDecorator } from '../../../di';

export interface IKaosService {
  readonly _serviceBrand: undefined;
  readonly kaos: Kaos | undefined;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IKaosService = createDecorator<IKaosService>('agentKaosService');
