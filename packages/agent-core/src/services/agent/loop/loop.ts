import { createDecorator } from '../../../di';

import type { LoopRecordedEvent } from '../../../loop';

export interface ILoopService {
  handleEvent(event: LoopRecordedEvent): void;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const ILoopService = createDecorator<ILoopService>('agentLoopService');
