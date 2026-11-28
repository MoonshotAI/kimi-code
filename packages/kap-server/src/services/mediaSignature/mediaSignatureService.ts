import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  MEDIA_SIGNATURE_REUSE_THRESHOLD_MS,
  MEDIA_SIGNATURE_TTL_MS,
} from './constants';

export interface MediaSignatureTarget {
  readonly sessionId: string;
  readonly path: string;
  readonly allowExternalSymlinks: boolean;
}

export interface MediaSignature {
  readonly signature: string;
  readonly expiresAt: number;
}

export interface MediaSignatureService {
  issue(target: MediaSignatureTarget): MediaSignature;
  validate(target: MediaSignatureTarget, candidate: string): boolean;
}

export interface MediaSignatureServiceOptions {
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly reuseThresholdMs?: number;
}

interface SignatureKey {
  readonly secret: Buffer;
  readonly expiresAt: number;
}

function payloadOf(target: MediaSignatureTarget): string {
  return `${target.sessionId}\n${target.path}\n${target.allowExternalSymlinks ? '1' : '0'}`;
}

function sign(key: SignatureKey, target: MediaSignatureTarget): string {
  return createHmac('sha256', key.secret).update(payloadOf(target)).digest('base64url');
}

function equalSignatures(expected: string, candidate: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const candidateBytes = Buffer.from(candidate);
  return expectedBytes.length === candidateBytes.length && timingSafeEqual(expectedBytes, candidateBytes);
}

export function createMediaSignatureService(
  opts: MediaSignatureServiceOptions = {},
): MediaSignatureService {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? MEDIA_SIGNATURE_TTL_MS;
  const reuseThresholdMs = opts.reuseThresholdMs ?? MEDIA_SIGNATURE_REUSE_THRESHOLD_MS;

  let keys: SignatureKey[] = [];

  function prune(at: number): void {
    keys = keys.filter((key) => key.expiresAt > at);
  }

  function keyFor(at: number): SignatureKey {
    const newest = keys.at(-1);
    if (newest !== undefined && newest.expiresAt - at > reuseThresholdMs) return newest;
    const created = { secret: randomBytes(32), expiresAt: at + ttlMs };
    keys.push(created);
    return created;
  }

  return {
    issue(target) {
      const at = now();
      prune(at);
      const key = keyFor(at);
      return { signature: sign(key, target), expiresAt: key.expiresAt };
    },

    validate(target, candidate) {
      const at = now();
      prune(at);
      return keys.some((key) => equalSignatures(sign(key, target), candidate));
    },
  };
}