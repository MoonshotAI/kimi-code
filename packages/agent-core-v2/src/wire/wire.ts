import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { RecordDehydrator, WireRecord } from './record';

export interface IWireService {
  readonly _serviceBrand: undefined;

  seal(): Promise<void>;
  appendRecord(record: WireRecord, dehydrate?: RecordDehydrator): void;
  readJournal(): AsyncIterable<WireRecord>;
  flush(): Promise<void>;
}

export const IWireService: ServiceIdentifier<IWireService> =
  createDecorator<IWireService>('wireService');
