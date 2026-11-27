import { randomBytes, timingSafeEqual } from 'node:crypto';

import {
  MEDIA_SIGNATURE_REUSE_THRESHOLD_MS,
  MEDIA_SIGNATURE_TTL_MS,
} from './constants';

export interface MediaSignature {
  readonly signature: string;
  readonly expiresAt: number;
}

export interface MediaSignatureService {
  issue(): MediaSignature;
  validate(candidate: string): boolean;
}

export interface MediaSignatureServiceOptions {
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly reuseThresholdMs?: number;
}

interface SignatureEntry {
  readonly value: string;
  readonly expiresAt: number;
}

function matches(expected: string, candidate: string): boolean {
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

  let current: SignatureEntry | undefined;
  let previous: SignatureEntry | undefined;

  function isLive(entry: SignatureEntry | undefined, at: number): entry is SignatureEntry {
    return entry !== undefined && entry.expiresAt > at;
  }

  function prune(at: number): void {
    if (!isLive(current, at)) current = undefined;
    if (!isLive(previous, at)) previous = undefined;
  }

  function expose(entry: SignatureEntry): MediaSignature {
    return { signature: entry.value, expiresAt: entry.expiresAt };
  }

  return {
    issue() {
      const at = now();
      prune(at);
      if (isLive(current, at) && current.expiresAt - at > reuseThresholdMs) {
        return expose(current);
      }
      previous = current;
      current = {
        value: randomBytes(32).toString('base64url'),
        expiresAt: at + ttlMs,
      };
      return expose(current);
    },

    validate(candidate) {
      const at = now();
      const accepted = [current, previous].some(
        (entry) => isLive(entry, at) && matches(entry.value, candidate),
      );
      prune(at);
      return accepted;
    },
  };
}