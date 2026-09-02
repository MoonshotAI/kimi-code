import { createHash, randomBytes, randomInt } from "node:crypto";

const PKCE_VERIFIER_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

export interface PkceChallenge {
  readonly verifier: string;
  readonly challenge: string;
}

export function createPkceVerifier(length = 64): string {
  let verifier = "";
  for (let i = 0; i < length; i += 1) {
    verifier += PKCE_VERIFIER_ALPHABET[randomInt(PKCE_VERIFIER_ALPHABET.length)];
  }
  return verifier;
}

/** RFC 7636 S256 challenge: base64url(SHA-256(verifier)) with padding stripped. */
export function createPkceChallenge(): PkceChallenge {
  const verifier = createPkceVerifier();
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function randomState(): string {
  return randomBytes(24).toString("hex");
}
