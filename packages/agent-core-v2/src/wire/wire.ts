import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { IAgentJournal } from './journal';
import type { RecordDehydrator, WireRecord } from './record';

export { ForkLineError, type ForkLineFailure } from './tree';

export interface IWireService extends IAgentJournal {
  readonly _serviceBrand: undefined;

  seal(): Promise<void>;
  appendRecord(record: WireRecord, dehydrate?: RecordDehydrator): void;
  readJournal(): AsyncIterable<WireRecord>;
  readRestorable(): AsyncIterable<WireRecord>;
  flush(): Promise<void>;
  drainPersisted(): Promise<void>;
  lineCount(): number;
  lastContextClearLine(): number | undefined;
  journalPath(): string | undefined;
}

export const IWireService: ServiceIdentifier<IWireService> =
  createDecorator<IWireService>('wireService');
