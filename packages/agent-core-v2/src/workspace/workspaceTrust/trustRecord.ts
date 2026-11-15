import { encodeWorkDirKey } from '#/_base/utils/workdir-slug';
import { canonicalWorkspaceRoot } from '#/_base/utils/paths';
import type { ITelemetryService } from '#/app/telemetry/telemetry';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { isStorageError, StorageErrors } from '#/persistence/interface/storage';

const TRUST_SCOPE = 'workspace-trust';

interface TrustRecord {
  readonly root: string;
  readonly trustedAt: number;
}

interface TrustRecordEntry {
  readonly key: string;
  readonly record: TrustRecord;
}

export async function readWorkspaceTrust(
  docs: IAtomicDocumentStore,
  root: string,
  telemetry?: ITelemetryService,
): Promise<boolean> {
  try {
    const canonicalKey = trustKey(root);
    if ((await docs.get<TrustRecord>(TRUST_SCOPE, canonicalKey)) !== undefined) return true;

    const legacyKey = encodeWorkDirKey(root);
    if (legacyKey !== canonicalKey) {
      const legacy = await docs.get<TrustRecord>(TRUST_SCOPE, legacyKey);
      if (legacy !== undefined) {
        await migrateWorkspaceTrust(docs, canonicalKey, legacyKey, legacy);
        return true;
      }
    }
    const [variant] = await findLegacyTrustRecords(docs, root);
    if (variant === undefined) return false;
    await migrateWorkspaceTrust(docs, canonicalKey, variant.key, variant.record);
    return true;
  } catch (error) {
    telemetry?.track2('workspace_trust_read_failed', {
      error_type: error instanceof Error ? error.name : 'Unknown',
    });
    throw error;
  }
}

export function writeWorkspaceTrust(
  docs: IAtomicDocumentStore,
  root: string,
  trustedAt: number,
): Promise<void> {
  return docs.set(TRUST_SCOPE, trustKey(root), { root, trustedAt });
}

export async function deleteWorkspaceTrust(
  docs: IAtomicDocumentStore,
  root: string,
): Promise<void> {
  const canonicalKey = trustKey(root);
  const legacyKey = encodeWorkDirKey(root);
  await docs.delete(TRUST_SCOPE, canonicalKey);
  if (legacyKey !== canonicalKey) await docs.delete(TRUST_SCOPE, legacyKey);
  for (const variant of await findLegacyTrustRecords(docs, root)) {
    await docs.delete(TRUST_SCOPE, variant.key);
  }
}

async function migrateWorkspaceTrust(
  docs: IAtomicDocumentStore,
  canonicalKey: string,
  legacyKey: string,
  record: TrustRecord,
): Promise<void> {
  await docs.set(TRUST_SCOPE, canonicalKey, record);
  await docs.delete(TRUST_SCOPE, legacyKey);
}

async function findLegacyTrustRecords(
  docs: IAtomicDocumentStore,
  root: string,
): Promise<TrustRecordEntry[]> {
  const canonicalRoot = canonicalWorkspaceRoot(root);
  const canonicalKey = trustKey(root);
  const legacyKey = encodeWorkDirKey(root);
  const result: TrustRecordEntry[] = [];
  for (const key of await docs.list(TRUST_SCOPE)) {
    if (key === canonicalKey || key === legacyKey || /\.tmp\.\d+\.[0-9a-f]+$/.test(key)) continue;
    try {
      const record = await docs.get<TrustRecord | null>(TRUST_SCOPE, key);
      if (record === undefined || record === null || typeof record.root !== 'string') continue;
      if (canonicalWorkspaceRoot(record.root) === canonicalRoot) result.push({ key, record });
    } catch (error) {
      if (!isStorageError(error, StorageErrors.codes.STORAGE_DECODE_FAILED)) throw error;
    }
  }
  return result;
}

function trustKey(root: string): string {
  return encodeWorkDirKey(canonicalWorkspaceRoot(root));
}
