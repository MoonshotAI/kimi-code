import { encodeWorkDirKey } from '#/_base/utils/workdir-slug';
import { canonicalWorkspaceRoot } from '#/_base/utils/paths';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';

const TRUST_SCOPE = 'workspace-trust';

interface TrustRecord {
  readonly root: string;
  readonly trustedAt: number;
}

export async function readWorkspaceTrust(
  docs: IAtomicDocumentStore,
  root: string,
): Promise<boolean> {
  try {
    const canonicalKey = trustKey(root);
    if ((await docs.get<TrustRecord>(TRUST_SCOPE, canonicalKey)) !== undefined) return true;

    const legacyKey = encodeWorkDirKey(root);
    if (legacyKey === canonicalKey) return false;
    const legacy = await docs.get<TrustRecord>(TRUST_SCOPE, legacyKey);
    if (legacy === undefined) return false;
    try {
      await docs.set(TRUST_SCOPE, canonicalKey, legacy);
      await docs.delete(TRUST_SCOPE, legacyKey);
    } catch {}
    return true;
  } catch {
    return false;
  }
}

export function writeWorkspaceTrust(
  docs: IAtomicDocumentStore,
  root: string,
  trustedAt: number,
): Promise<void> {
  return docs.set(TRUST_SCOPE, trustKey(root), { root, trustedAt });
}

export function deleteWorkspaceTrust(
  docs: IAtomicDocumentStore,
  root: string,
): Promise<void> {
  const canonicalKey = trustKey(root);
  const legacyKey = encodeWorkDirKey(root);
  return (async () => {
    await docs.delete(TRUST_SCOPE, canonicalKey);
    if (legacyKey !== canonicalKey) await docs.delete(TRUST_SCOPE, legacyKey);
  })();
}

function trustKey(root: string): string {
  return encodeWorkDirKey(canonicalWorkspaceRoot(root));
}
