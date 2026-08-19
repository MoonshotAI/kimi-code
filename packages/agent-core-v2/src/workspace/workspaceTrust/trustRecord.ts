import { encodeWorkDirKey } from '#/_base/utils/workdir-slug';
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
    return (await docs.get<TrustRecord>(TRUST_SCOPE, encodeWorkDirKey(root))) !== undefined;
  } catch {
    return false;
  }
}

export function writeWorkspaceTrust(
  docs: IAtomicDocumentStore,
  root: string,
  trustedAt: number,
): Promise<void> {
  return docs.set(TRUST_SCOPE, encodeWorkDirKey(root), { root, trustedAt });
}

export function deleteWorkspaceTrust(
  docs: IAtomicDocumentStore,
  root: string,
): Promise<void> {
  return docs.delete(TRUST_SCOPE, encodeWorkDirKey(root));
}
