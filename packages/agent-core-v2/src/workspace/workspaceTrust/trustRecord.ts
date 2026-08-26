import { dirname } from 'pathe';

import { encodeWorkDirKey } from '#/_base/utils/workdir-slug';
import { canonicalWorkspaceRoot } from '#/_base/utils/paths';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';

const TRUST_SCOPE = 'workspace-trust';

interface TrustRecord {
  readonly root: string;
  readonly trustedAt?: number;
  readonly trusted?: boolean;
  readonly untrustedAt?: number;
}

export async function readWorkspaceTrust(
  docs: IAtomicDocumentStore,
  root: string,
): Promise<boolean> {
  try {
    for (const candidate of ancestorRoots(root)) {
      const record = await readOwnRecord(docs, candidate);
      if (record !== undefined) return record.trusted !== false;
    }
    return false;
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

export function writeUntrustedWorkspaceTrust(
  docs: IAtomicDocumentStore,
  root: string,
  untrustedAt: number,
): Promise<void> {
  return docs.set(TRUST_SCOPE, trustKey(root), { root, trusted: false, untrustedAt });
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

export function workspaceTrustWatchKeys(root: string): readonly string[] {
  return ancestorRoots(root).map(trustKey);
}

async function readOwnRecord(
  docs: IAtomicDocumentStore,
  root: string,
): Promise<TrustRecord | undefined> {
  const canonicalKey = trustKey(root);
  const canonical = await docs.get<TrustRecord>(TRUST_SCOPE, canonicalKey);
  if (canonical !== undefined) return canonical;

  const legacyKey = encodeWorkDirKey(root);
  if (legacyKey === canonicalKey) return undefined;
  const legacy = await docs.get<TrustRecord>(TRUST_SCOPE, legacyKey);
  if (legacy === undefined) return undefined;
  try {
    await docs.set(TRUST_SCOPE, canonicalKey, legacy);
    await docs.delete(TRUST_SCOPE, legacyKey);
  } catch {}
  return legacy;
}

function ancestorRoots(root: string): string[] {
  const roots: string[] = [];
  let current = canonicalWorkspaceRoot(root);
  while (true) {
    roots.push(current);
    const parent = dirname(current);
    const next = canonicalWorkspaceRoot(parent);
    if (next === current) return roots;
    current = next;
  }
}

function trustKey(root: string): string {
  return encodeWorkDirKey(canonicalWorkspaceRoot(root));
}
