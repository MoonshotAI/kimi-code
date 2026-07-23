import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import bcrypt from 'bcryptjs';

const { compare, hash } = bcrypt;

const BCRYPT_COST = 12;
const PASSWORD_VERIFICATION_CACHE_TTL_MS = 5 * 60_000;

interface PasswordVerifierOptions {
  readonly compare?: (candidate: string, passwordHash: string) => Promise<boolean>;
  readonly now?: () => number;
}

export async function resolvePasswordHash(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const plaintext = env['KIMI_CODE_PASSWORD'];
  if (!plaintext) {
    return undefined;
  }
  return hash(plaintext, BCRYPT_COST);
}

/**
 * Build a process-local password verifier with a short success cache.
 *
 * The cache holds only a random-key HMAC of the successful candidate, never
 * the password itself or a reusable unkeyed digest. Its five-minute lifetime
 * starts after bcrypt succeeds and is not extended by cache hits. Concurrent
 * callers with the same candidate share one bcrypt comparison; distinct
 * candidates remain independent. Pending entries are removed on settlement.
 */
export function createPasswordVerifier(
  passwordHash: string | undefined,
  options?: PasswordVerifierOptions,
): (candidate: string) => Promise<boolean> {
  if (passwordHash === undefined) {
    return async () => false;
  }

  const comparePassword = options?.compare ?? compare;
  const now = options?.now ?? Date.now;
  const hmacKey = randomBytes(32);
  const inFlightVerifications = new Map<string, Promise<boolean>>();
  let successfulVerification:
    | { readonly digest: Buffer; readonly expiresAt: number }
    | undefined;

  const verify = async (candidate: string): Promise<boolean> => {
    const digest = createHmac('sha256', hmacKey).update(candidate).digest();
    const digestKey = digest.toString('base64');
    const currentTime = now();
    if (
      successfulVerification !== undefined &&
      successfulVerification.expiresAt <= currentTime
    ) {
      successfulVerification = undefined;
    }
    if (
      successfulVerification !== undefined &&
      timingSafeEqual(digest, successfulVerification.digest)
    ) {
      return true;
    }

    const inFlight = inFlightVerifications.get(digestKey);
    if (inFlight !== undefined) {
      return inFlight;
    }

    const verification = (async () => {
      const valid = await comparePassword(candidate, passwordHash);
      if (valid) {
        successfulVerification = {
          digest,
          expiresAt: now() + PASSWORD_VERIFICATION_CACHE_TTL_MS,
        };
      }
      return valid;
    })();
    inFlightVerifications.set(digestKey, verification);
    try {
      return await verification;
    } finally {
      if (inFlightVerifications.get(digestKey) === verification) {
        inFlightVerifications.delete(digestKey);
      }
    }
  };
  return verify;
}
