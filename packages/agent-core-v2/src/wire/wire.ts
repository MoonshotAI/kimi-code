/**
 * `wire` domain — the Agent-scoped journal adapter contract.
 *
 * The service owns one Agent's `wire.jsonl` journal as a consistency
 * boundary: seal initializes a fresh journal, appendRecord writes one
 * serialized durable-event record (with optional blob dehydration), and
 * readJournal streams validated, migrated records (healing the journal with
 * an atomic rewrite when the format predates the current protocol). State
 * replay and event dispatch live in the state domain's event dispatcher.
 */

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
