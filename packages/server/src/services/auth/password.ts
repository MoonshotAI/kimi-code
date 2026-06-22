import { compare, hash } from '@node-rs/bcrypt';

const BCRYPT_COST = 12;

export async function resolvePasswordHash(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const plaintext = env['KIMI_CODE_PASSWORD'];
  if (!plaintext) {
    return undefined;
  }
  return hash(plaintext, BCRYPT_COST);
}

export async function verifyPassword(
  candidate: string,
  passwordHash: string | undefined,
): Promise<boolean> {
  if (passwordHash === undefined) {
    return false;
  }
  return compare(candidate, passwordHash);
}
