/**
 * Private provenance for model records synthesized by effective overlays.
 *
 * Object identity is deliberate: provenance never enters the passthrough
 * ModelRecord schema or TOML, and a caller that explicitly replaces a
 * synthesized record creates ordinary registry state that may be persisted.
 */

import type { ModelRecord, ModelsSection } from '#/kosong/model/model';

const runtimeOnlyRecords = new WeakSet<ModelRecord>();

export function markRuntimeOnlyModelRecord(record: ModelRecord | undefined): void {
  if (record !== undefined) runtimeOnlyRecords.add(record);
}

export function isRuntimeOnlyModelRecord(record: ModelRecord | undefined): boolean {
  return record !== undefined && runtimeOnlyRecords.has(record);
}

export function withoutRuntimeOnlyModels(models: Readonly<ModelsSection>): ModelsSection {
  let result: ModelsSection | undefined;
  for (const [id, record] of Object.entries(models)) {
    if (!isRuntimeOnlyModelRecord(record)) continue;
    result ??= { ...models };
    delete result[id];
  }
  return result ?? (models as ModelsSection);
}
