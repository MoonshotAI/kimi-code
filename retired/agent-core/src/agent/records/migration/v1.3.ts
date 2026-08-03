import type { WireMigration, WireMigrationRecord } from './index';

/**
 * v1.2 -> v1.3 is a bump-only migration.
 *
 * v1.3 introduces blobref offloading for large base64 media payloads.
 * Records written by v1.3+ may contain `blobref:<mime>;<hash>` URLs in
 * message content instead of inline `data:` URIs. Wire records are still
 * valid JSON and do not require transformation; the blobref format is
 * transparently handled at read/write time by BlobStore.
 */
export const migrateV1_2ToV1_3: WireMigration = {
  sourceVersion: '1.2',
  targetVersion: '1.3',
  migrateRecord(record: WireMigrationRecord): WireMigrationRecord {
    return record;
  },
};
