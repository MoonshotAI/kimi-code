/**
 * `mcp` domain (L5) — MCP OAuth credential store.
 *
 * Persists OAuth tokens, registered DCR client info, and discovery state for
 * MCP HTTP servers through the `storage` access-pattern store
 * (`IAtomicDocumentStore`) under the `credentials/mcp` scope
 * (`<homeDir>/credentials/mcp/<key>-*.json`). One logical record per
 * `(serverName, serverUrl)` identity, addressed by {@link mcpOAuthStoreKey}.
 *
 * Read semantics: missing or corrupt JSON resolves to `undefined` (never
 * throws). The provider treats `undefined` as "not stored".
 *
 * Security: tokens are encrypted at rest with AES-256-GCM. The 256-bit key is
 * derived (HKDF-SHA256) from two sources combined:
 *   1. The OS hostname — ties the key to the host.
 *   2. A per-installation random 32-byte secret stored at
 *      `<homeDir>/.kimi-code/oauth-key-secret` (created with 0600 perms on
 *      first use). This secret is never transmitted and never reused across
 *      machines, so an attacker who merely knows the hostname cannot
 *      reconstruct the key offline.
 *
 * Legacy plain-text records are still readable.
 */

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';

import { basename } from 'pathe';

import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';

const CREDENTIALS_SCOPE = 'credentials/mcp';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const KEY_LENGTH = 32; // AES-256
const SECRET_FILE_PATH = join(homedir(), '.kimi-code', 'oauth-key-secret');

let cachedKey: Buffer | undefined;

/**
 * Derive a 32-byte AES-256 key from the OS hostname plus a per-installation
 * random secret file. The secret is generated on first use with restrictive
 * permissions (0600 on POSIX; on Windows the file inherits home-dir ACLs).
 *
 * Combining hostname with a per-install secret means:
 *   - Two machines with the same hostname derive different keys.
 *   - An attacker who only knows the hostname cannot reconstruct the key.
 *   - Cloning the home directory to another host keeps the secret, but the
 *     hostname contribution still changes — so the cloned key differs.
 */
function deriveKey(): Buffer {
  if (cachedKey !== undefined) return cachedKey;

  const secret = loadOrCreateSecret();
  const hostnameBytes = Buffer.from(hostname(), 'utf8');
  // HKDF-SHA256 with hostname as salt and a fixed info label. Output is
  // exactly KEY_LENGTH bytes. HKDF extract+expand gives us a uniform key
  // even when the input entropy is unevenly distributed.
  const key = Buffer.from(
    hkdfSync('sha256', secret, hostnameBytes, 'kimi-code-mcp-oauth-v1', KEY_LENGTH),
  );
  // Zero out the secret buffer copy we hold locally; the on-disk copy stays.
  secret.fill(0);
  cachedKey = key;
  return key;
}

/**
 * Load the per-installation 32-byte secret from `SECRET_FILE_PATH`, or
 * generate and persist it on first use. Returns a fresh copy each call so
 * callers may safely zero their reference.
 */
function loadOrCreateSecret(): Buffer {
  try {
    const existing = readFileSync(SECRET_FILE_PATH);
    if (existing.length === KEY_LENGTH) {
      return Buffer.from(existing);
    }
    // Wrong length — treat as missing and regenerate.
  } catch {
    // File does not exist or is unreadable; fall through to generation.
  }
  const generated = randomBytes(KEY_LENGTH);
  try {
    mkdirSync(dirname(SECRET_FILE_PATH), { recursive: true });
    writeFileSync(SECRET_FILE_PATH, generated, { mode: 0o600 });
    // On POSIX, ensure restrictive perms even if the file already existed.
    try {
      chmodSync(SECRET_FILE_PATH, 0o600);
    } catch {
      // chmod failure on Windows is expected (POSIX-only syscall); ignore.
    }
  } catch {
    // If we cannot persist the secret (read-only home, sandbox, etc.), fall
    // back to an ephemeral one. This means tokens encrypted this session
    // cannot be decrypted after restart, but preserves session functionality.
    // A subsequent call will retry persistence.
  }
  return generated;
}

interface EncryptedBlob {
  iv: string;
  tag: string;
  data: string;
}

function encrypt(value: string): EncryptedBlob {
  const key = deriveKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    data: encrypted.toString('hex'),
  };
}

function decrypt(blob: EncryptedBlob): string {
  const key = deriveKey();
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(blob.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(blob.tag, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(blob.data, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

export function sanitizeStoreKey(name: string): string {
  // Unicode letters/digits pass through so non-ASCII server names keep a
  // recognizable key; anything else becomes an underscore.
  const safe = basename(name)
    .replaceAll(/[^\p{L}\p{N}_-]/gu, '_')
    .replaceAll(/_+/g, '_');
  if (safe.length === 0 || safe.startsWith('.')) {
    throw new Error(`Invalid MCP OAuth store key: "${name}"`);
  }
  return safe;
}

export function canonicalMcpOAuthResource(serverUrl: string | URL): string {
  const url = new URL(serverUrl);
  url.hash = '';
  return url.toString();
}

export function mcpOAuthStoreKey(serverName: string, serverUrl: string | URL): string {
  const safeName = sanitizeStoreKey(serverName);
  const resource = canonicalMcpOAuthResource(serverUrl);
  const digest = createHash('sha256')
    .update(serverName)
    .update('\0')
    .update(resource)
    .digest('hex')
    .slice(0, 24);
  return `${safeName}-${digest}`;
}

export interface McpOAuthStore {
  read<T>(key: string): Promise<T | undefined>;
  write(key: string, data: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export function createMcpOAuthStore(docs: IAtomicDocumentStore): McpOAuthStore {
  return {
    async read<T>(key: string): Promise<T | undefined> {
      try {
        const raw = await docs.get<EncryptedBlob | T>(CREDENTIALS_SCOPE, key);
        if (raw === undefined) return undefined;
        // Support both encrypted (new) and plain (legacy) storage.
        if (
          typeof raw === 'object' &&
          raw !== null &&
          'iv' in raw &&
          'tag' in raw &&
          'data' in raw
        ) {
          return JSON.parse(decrypt(raw)) as T;
        }
        return raw as T;
      } catch (error) {
        // Contract: read resolves to `undefined` for missing OR corrupt records
        // (see file header). But classify the failure so security-sensitive
        // events (AES-GCM tag mismatch = tampering or wrong key) and I/O
        // errors are observable instead of vanishing silently — a corrupt
        // credential blob that the provider treats as "not stored" is hard
        // to debug otherwise. We still return `undefined` to honor the
        // existing contract and avoid surfacing errors to callers that
        // expect `T | undefined`.
        const reason = error instanceof Error ? error.message : String(error);
        // eslint-disable-next-line no-console
        console.warn(
          `[mcp/oauth/store] read(${key}) failed; treating as missing. reason=${reason}`,
        );
        return undefined;
      }
    },
    write(key, data) {
      const encrypted = encrypt(JSON.stringify(data));
      return docs.set(CREDENTIALS_SCOPE, key, encrypted);
    },
    remove(key) {
      return docs.delete(CREDENTIALS_SCOPE, key);
    },
  };
}
