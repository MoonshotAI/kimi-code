import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { link, mkdir, open, readFile, rename, rm, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { ulid } from 'ulid';

import { readPrivateFile, writePrivateFile } from './privateFiles';

export type AccessRole = 'viewer' | 'operator' | 'owner';
export type ExternalAccessRole = 'viewer' | 'operator';

const ROLE_RANK: Readonly<Record<AccessRole, number>> = {
  viewer: 1,
  operator: 2,
  owner: 3,
};

export function hasMinimumRole(actual: AccessRole, required: AccessRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

export interface AccessPrincipal {
  readonly role: AccessRole;
  readonly principalId?: string;
  readonly name?: string;
}

export interface AccessTokenRecord {
  readonly id: string;
  readonly name: string;
  readonly role: ExternalAccessRole;
  readonly token_hash: string;
  readonly created_at: string;
  readonly last_used_at: string | null;
  readonly revoked_at: string | null;
}

export interface AccessPrincipalView {
  readonly id: string;
  readonly name: string;
  readonly role: ExternalAccessRole;
  readonly created_at: string;
  readonly last_used_at: string | null;
  readonly revoked_at: string | null;
}

interface AccessTokensFile {
  readonly version: 1;
  readonly tokens: AccessTokenRecord[];
}

export const ACCESS_TOKEN_PREFIX = 'kap_';
export const ACCESS_TOKENS_FILENAME = 'access_tokens.json';
const LAST_USED_FLUSH_INTERVAL_MS = 60_000;

export function accessTokensPath(homeDir: string): string {
  return join(homeDir, 'server', ACCESS_TOKENS_FILENAME);
}

export function generateAccessToken(): string {
  return `${ACCESS_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function hashAccessToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function sanitizeClientLabel(value: string): string {
  return value.replaceAll(/[\u0000-\u001F\u007F-\u009F]+/g, ' ').trim();
}

function toPrincipalView(record: AccessTokenRecord): AccessPrincipalView {
  return {
    id: record.id,
    name: record.name,
    role: record.role,
    created_at: record.created_at,
    last_used_at: record.last_used_at,
    revoked_at: record.revoked_at,
  };
}

function parseTokensFile(raw: string): AccessTokenRecord[] {
  const parsed = JSON.parse(raw) as Partial<AccessTokensFile>;
  if (!Array.isArray(parsed?.tokens)) return [];
  const out: AccessTokenRecord[] = [];
  for (const item of parsed.tokens) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Partial<AccessTokenRecord>;
    if (
      typeof rec.id !== 'string' ||
      typeof rec.name !== 'string' ||
      (rec.role !== 'viewer' && rec.role !== 'operator') ||
      typeof rec.token_hash !== 'string' ||
      typeof rec.created_at !== 'string'
    ) {
      continue;
    }
    out.push({
      id: rec.id,
      name: rec.name,
      role: rec.role,
      token_hash: rec.token_hash,
      created_at: rec.created_at,
      last_used_at: typeof rec.last_used_at === 'string' ? rec.last_used_at : null,
      revoked_at: typeof rec.revoked_at === 'string' ? rec.revoked_at : null,
    });
  }
  return out;
}

async function readAccessTokenRecords(filePath: string): Promise<AccessTokenRecord[]> {
  try {
    const buf = await readPrivateFile(filePath);
    return parseTokensFile(buf.toString('utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function writeAccessTokenRecords(
  filePath: string,
  tokens: readonly AccessTokenRecord[],
): Promise<void> {
  const payload: AccessTokensFile = { version: 1, tokens: [...tokens] };
  await writePrivateFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

async function withFileLock<T>(targetPath: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${targetPath}.lock`;
  const dir = dirname(lockPath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lockToken = `${process.pid}:${ulid()}`;
  const stagePath = `${lockPath}.stage.${process.pid}.${ulid()}`;
  const stageFh = await open(stagePath, 'wx', 0o600);
  try {
    await stageFh.writeFile(lockToken);
  } finally {
    await stageFh.close();
  }
  let acquired = false;
  const deadline = Date.now() + 5_000;
  try {
    for (;;) {
      try {
        await link(stagePath, lockPath);
        acquired = true;
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EXDEV' || code === 'EPERM' || code === 'ENOSYS') {
          try {
            const fh = await open(lockPath, 'wx', 0o600);
            try {
              await fh.writeFile(lockToken);
            } finally {
              await fh.close();
            }
            acquired = true;
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          }
        } else if (code !== 'EEXIST') {
          throw error;
        }
        try {
          const st = await stat(lockPath);
          const raw = (await readFile(lockPath, 'utf8')).trim();
          const holderPid = Number.parseInt(raw.split(':', 1)[0] ?? '', 10);
          const malformedStale = !Number.isFinite(holderPid) && Date.now() - st.mtimeMs > 5_000;
          const deadHolder = Number.isFinite(holderPid) && !isProcessAlive(holderPid);
          if (deadHolder || malformedStale) {
            const reclaimTmp = `${lockPath}.reclaim.${process.pid}.${ulid()}`;
            await rename(lockPath, reclaimTmp)
              .then(async () => {
                const verify = (await readFile(reclaimTmp, 'utf8').catch(() => '')).trim();
                if (verify === raw) {
                  await rm(reclaimTmp, { force: true }).catch(() => {});
                } else {
                  await rename(reclaimTmp, lockPath).catch(async () => {
                    await rm(reclaimTmp, { force: true }).catch(() => {});
                  });
                }
              })
              .catch(() => {});
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error(`Timed out acquiring lock for ${targetPath}`, { cause: error });
        }
        await new Promise((r) => setTimeout(r, 15));
      }
    }
  } finally {
    await rm(stagePath, { force: true }).catch(() => {});
  }
  try {
    return await fn();
  } finally {
    if (acquired) {
      const current = (await readFile(lockPath, 'utf8').catch(() => '')).trim();
      if (current === lockToken) {
        await unlink(lockPath).catch(() => {});
      }
    }
  }
}

export async function createPersistedAccessToken(
  homeDir: string,
  input: { readonly name: string; readonly role: ExternalAccessRole; readonly now?: Date },
): Promise<{ readonly token: string; readonly principal: AccessPrincipalView }> {
  const filePath = accessTokensPath(homeDir);
  return withFileLock(filePath, async () => {
    const existing = await readAccessTokenRecords(filePath);
    const token = generateAccessToken();
    const nowIso = (input.now ?? new Date()).toISOString();
    const record: AccessTokenRecord = {
      id: `tok_${ulid()}`,
      name: sanitizeClientLabel(input.name),
      role: input.role,
      token_hash: hashAccessToken(token),
      created_at: nowIso,
      last_used_at: null,
      revoked_at: null,
    };
    await writeAccessTokenRecords(filePath, [...existing, record]);
    return { token, principal: toPrincipalView(record) };
  });
}

export async function listPersistedAccessPrincipals(
  homeDir: string,
): Promise<AccessPrincipalView[]> {
  const records = await readAccessTokenRecords(accessTokensPath(homeDir));
  return records.map(toPrincipalView);
}

export async function revokePersistedAccessPrincipal(
  homeDir: string,
  principalId: string,
  now: Date = new Date(),
): Promise<AccessPrincipalView | undefined> {
  const filePath = accessTokensPath(homeDir);
  return withFileLock(filePath, async () => {
    const records = await readAccessTokenRecords(filePath);
    const index = records.findIndex((r) => r.id === principalId);
    if (index < 0) return undefined;
    const current = records[index]!;
    const updated: AccessTokenRecord =
      current.revoked_at !== null
        ? current
        : { ...current, revoked_at: now.toISOString() };
    if (updated !== current) {
      const next = [...records];
      next[index] = updated;
      await writeAccessTokenRecords(filePath, next);
    }
    return toPrincipalView(updated);
  });
}

export interface EphemeralTokenSpec {
  readonly id?: string;
  readonly token: string;
  readonly name: string;
  readonly role: ExternalAccessRole;
}

export interface AccessTokenStore {
  resolve(candidate: string): Promise<AccessPrincipal | null>;
  createToken(input: {
    readonly name: string;
    readonly role: ExternalAccessRole;
  }): Promise<{ readonly token: string; readonly principal: AccessPrincipalView }>;
  listPrincipals(): Promise<AccessPrincipalView[]>;
  revokePrincipal(principalId: string): Promise<AccessPrincipalView | undefined>;
  dispose(): void;
}

export interface AccessTokenStoreOptions {
  readonly homeDir: string;
  readonly persist?: boolean;
  readonly ephemeralTokens?: readonly EphemeralTokenSpec[];
  readonly onRevoked?: (principalId: string) => void;
  readonly watchIntervalMs?: number;
}

interface EphemeralEntry {
  readonly id: string;
  readonly name: string;
  readonly role: ExternalAccessRole;
  readonly hashBuf: Buffer;
}

function timingSafeHexEqual(hexA: string, hexB: string): boolean {
  const a = Buffer.from(hexA, 'utf8');
  const b = Buffer.from(hexB, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createAccessTokenStore(opts: AccessTokenStoreOptions): AccessTokenStore {
  const filePath = accessTokensPath(opts.homeDir);
  const ephemerals: EphemeralEntry[] = (opts.ephemeralTokens ?? []).map((spec) => {
    if (!spec.token.startsWith(ACCESS_TOKEN_PREFIX)) {
      throw new Error(`Ephemeral access token must start with "${ACCESS_TOKEN_PREFIX}"`);
    }
    return {
      id: spec.id ?? `ephem_${ulid()}`,
      name: sanitizeClientLabel(spec.name),
      role: spec.role,
      hashBuf: Buffer.from(hashAccessToken(spec.token), 'utf8'),
    };
  });

  let cache: {
    mtimeMs: number;
    ino: number;
    records: AccessTokenRecord[];
  } = { mtimeMs: -1, ino: -1, records: [] };
  const lastUsedFlushedMs = new Map<string, number>();
  let writeChain: Promise<void> = Promise.resolve();

  const enqueueWrite = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = writeChain.then(fn, fn);
    writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const notifyNewlyRevoked = (
    prevRecords: readonly AccessTokenRecord[],
    nextRecords: readonly AccessTokenRecord[],
  ): void => {
    if (opts.onRevoked === undefined) return;
    const prevActive = new Set(prevRecords.filter((r) => r.revoked_at === null).map((r) => r.id));
    const nextActive = new Set(nextRecords.filter((r) => r.revoked_at === null).map((r) => r.id));
    for (const id of prevActive) {
      if (!nextActive.has(id)) {
        opts.onRevoked(id);
      }
    }
  };

  const refreshIfNeeded = async (): Promise<AccessTokenRecord[]> => {
    let st: Awaited<ReturnType<typeof stat>> | undefined;
    try {
      st = await stat(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (cache.records.length > 0) {
          const prev = cache.records;
          cache = { mtimeMs: -1, ino: -1, records: [] };
          notifyNewlyRevoked(prev, []);
        }
        return [];
      }
      return cache.records;
    }
    if (st.mtimeMs === cache.mtimeMs && st.ino === cache.ino) {
      return cache.records;
    }
    try {
      const records = await readAccessTokenRecords(filePath);
      const prev = cache.records;
      cache = { mtimeMs: st.mtimeMs, ino: st.ino, records };
      notifyNewlyRevoked(prev, records);
      return records;
    } catch {
      const prev = cache.records;
      cache = { mtimeMs: -1, ino: -1, records: [] };
      notifyNewlyRevoked(prev, []);
      return [];
    }
  };

  const maybeTouchLastUsed = (principalId: string): void => {
    const nowMs = Date.now();
    const prevMs = lastUsedFlushedMs.get(principalId) ?? 0;
    if (nowMs - prevMs < LAST_USED_FLUSH_INTERVAL_MS) return;
    lastUsedFlushedMs.set(principalId, nowMs);
    const nowIso = new Date(nowMs).toISOString();
    void enqueueWrite(async () => {
      await withFileLock(filePath, async () => {
        const current = await readAccessTokenRecords(filePath);
        const idx = current.findIndex((r) => r.id === principalId && r.revoked_at === null);
        if (idx < 0) return;
        const next = [...current];
        next[idx] = { ...current[idx]!, last_used_at: nowIso };
        await writeAccessTokenRecords(filePath, next);
      });
      cache = { mtimeMs: -1, ino: -1, records: cache.records };
    }).catch(() => {});
  };

  const persistEnabled = opts.persist !== false;
  const watchTimer = persistEnabled
    ? setInterval(() => {
        void refreshIfNeeded().catch(() => {});
      }, opts.watchIntervalMs ?? 500)
    : undefined;
  watchTimer?.unref?.();

  return {
    async resolve(candidate: string): Promise<AccessPrincipal | null> {
      if (!candidate.startsWith(ACCESS_TOKEN_PREFIX)) return null;
      const candidateHash = hashAccessToken(candidate);
      const candidateBuf = Buffer.from(candidateHash, 'utf8');
      for (const ephem of ephemerals) {
        if (
          candidateBuf.length === ephem.hashBuf.length &&
          timingSafeEqual(candidateBuf, ephem.hashBuf)
        ) {
          return { role: ephem.role, principalId: ephem.id, name: ephem.name };
        }
      }
      if (!persistEnabled) return null;
      const records = await refreshIfNeeded();
      for (const rec of records) {
        if (rec.revoked_at !== null) continue;
        if (timingSafeHexEqual(candidateHash, rec.token_hash)) {
          maybeTouchLastUsed(rec.id);
          return { role: rec.role, principalId: rec.id, name: rec.name };
        }
      }
      return null;
    },

    createToken(input) {
      return enqueueWrite(async () => {
        const result = await createPersistedAccessToken(opts.homeDir, input);
        cache = { mtimeMs: -1, ino: -1, records: cache.records };
        await refreshIfNeeded();
        return result;
      });
    },

    async listPrincipals(): Promise<AccessPrincipalView[]> {
      const records = await refreshIfNeeded();
      return records.map(toPrincipalView);
    },

    revokePrincipal(principalId: string) {
      return enqueueWrite(async () => {
        const revoked = await revokePersistedAccessPrincipal(opts.homeDir, principalId);
        if (revoked !== undefined) {
          cache = { mtimeMs: -1, ino: -1, records: cache.records };
          await refreshIfNeeded();
        }
        return revoked;
      });
    },

    dispose(): void {
      if (watchTimer !== undefined) clearInterval(watchTimer);
    },
  };
}
